// Notion corpus source: block-text extraction (pure), the incremental walk's
// cursor contract (mocked fetch), and the embed-only ingest path against
// :memory:. The cursor rules matter most — they're what makes a crash re-walk
// instead of stranding older pages, same contract as linear.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { openTestDb } from './helpers'
import { blockText, fetchNotionSince, pageTitle, type Block, type SearchPage } from '../sync/notion'
import { memoryRepo } from '../db/repos/memory'

/* ------------------------------------------------------------- pure bits -- */

describe('notion block text', () => {
  const rt = (...t: string[]) => t.map((x) => ({ plain_text: x }))

  it('reads rich_text off any block type', () => {
    expect(blockText({ id: 'b', type: 'paragraph', paragraph: { rich_text: rt('Hello ', 'world') } } as Block)).toBe('Hello world')
    expect(blockText({ id: 'b', type: 'heading_1', heading_1: { rich_text: rt('ERD: dictation flow') } } as Block)).toBe('ERD: dictation flow')
    expect(blockText({ id: 'b', type: 'code', code: { rich_text: rt('SELECT 1') } } as Block)).toBe('SELECT 1')
  })

  it('renders to_do checkboxes as text', () => {
    expect(blockText({ id: 'b', type: 'to_do', to_do: { rich_text: rt('ship it'), checked: true } } as Block)).toBe('[x] ship it')
    expect(blockText({ id: 'b', type: 'to_do', to_do: { rich_text: rt('ship it'), checked: false } } as Block)).toBe('[ ] ship it')
  })

  it('reads child_page titles and image captions; empty for structural blocks', () => {
    expect(blockText({ id: 'b', type: 'child_page', child_page: { title: 'Sub doc' } } as Block)).toBe('Sub doc')
    expect(blockText({ id: 'b', type: 'image', image: { caption: rt('the ERD diagram') } } as Block)).toBe('the ERD diagram')
    expect(blockText({ id: 'b', type: 'divider', divider: {} } as Block)).toBe('')
  })

  it('finds the title property whatever it is named', () => {
    const p: SearchPage = {
      id: 'p1',
      properties: { WeirdName: { type: 'title', title: [{ plain_text: 'Dictation ERD' }] }, Other: { type: 'select' } },
    }
    expect(pageTitle(p)).toBe('Dictation ERD')
    expect(pageTitle({ id: 'p2', properties: {} })).toBe('Untitled')
  })
})

/* -------------------------------------------------------- fetch contract -- */

type FetchResponse = { ok: boolean; status: number; headers: { get: (k: string) => string | null }; json: () => Promise<unknown> }
const res = (body: unknown, status = 200): FetchResponse => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  json: () => Promise.resolve(body),
})

const page = (id: string, edited: string, title = 'Doc'): SearchPage => ({
  id,
  url: `https://notion.so/${id}`,
  last_edited_time: edited,
  created_time: '2026-01-01T00:00:00.000Z',
  properties: { Name: { type: 'title', title: [{ plain_text: title }] } },
})

const blocks = (...texts: string[]) => ({
  results: texts.map((t, i) => ({ id: `b${i}`, type: 'paragraph', paragraph: { rich_text: [{ plain_text: t }] } })),
  has_more: false,
  next_cursor: null,
})

describe('fetchNotionSince', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('walks pages, emits docs with url+title, returns max edited time', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res({ results: [page('A', '2026-07-20T10:00:00.000Z', 'ERD doc')], has_more: false, next_cursor: null }))
      .mockResolvedValueOnce(res(blocks('The dictation ERD lives here', 'showcase -> orchestrator')))
    vi.stubGlobal('fetch', fetchMock)

    const seen: { id: string; title: string; url?: string; text: string }[] = []
    const next = await fetchNotionSince('tok', undefined, async (docs) => {
      seen.push(...docs)
    })

    expect(seen).toHaveLength(1)
    expect(seen[0].id).toBe('notion:A')
    expect(seen[0].title).toBe('ERD doc')
    expect(seen[0].url).toBe('https://notion.so/A')
    expect(seen[0].text).toContain('dictation ERD')
    expect(next).toBe('2026-07-20T10:00:00.000Z')
  })

  it('stops at the cursor and does NOT fetch blocks for older pages', async () => {
    const fetchMock = vi
      .fn()
      // newest first: B (new), A (old, at cursor)
      .mockResolvedValueOnce(
        res({ results: [page('B', '2026-07-21T09:00:00.000Z'), page('A', '2026-07-20T10:00:00.000Z')], has_more: true, next_cursor: 'more' }),
      )
      .mockResolvedValueOnce(res(blocks('new content')))
    vi.stubGlobal('fetch', fetchMock)

    const seen: string[] = []
    const next = await fetchNotionSince('tok', '2026-07-20T10:00:00.000Z', async (docs) => {
      seen.push(...docs.map((d) => d.id))
    })

    expect(seen).toEqual(['notion:B'])
    // 1 search + 1 block fetch for B only — A crossed the cursor, walk stopped,
    // and the has_more page was never requested.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(next).toBe('2026-07-21T09:00:00.000Z')
  })

  it('skips empty pages and keeps the cursor unchanged when nothing is newer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res({ results: [page('A', '2026-07-20T10:00:00.000Z')], has_more: false, next_cursor: null }))
    vi.stubGlobal('fetch', fetchMock)
    const next = await fetchNotionSince('tok', '2026-07-20T10:00:00.000Z', async () => {
      throw new Error('should not emit')
    })
    expect(next).toBe('2026-07-20T10:00:00.000Z')
  })

  it('surfaces the sharing hint on 401/403', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res({}, 401)))
    await expect(fetchNotionSince('bad', undefined, async () => {})).rejects.toThrow(/shared into the pages/)
  })
})

/* ---------------------------------------------------------- corpus rows -- */

describe('corpus memory rows', () => {
  let db: Database.Database
  beforeEach(() => {
    db = openTestDb()
  })

  it('stores a notion doc searchably (FTS over content) with its url', () => {
    const memory = memoryRepo(db)
    memory.upsert({
      id: 'notion:p1',
      source: 'notion',
      title: 'Dictation architecture',
      url: 'https://notion.so/p1',
      symptoms: 'The ERD shows showcase calling speech-orchestrator which fans out to VAD ASR ITN',
      resolutionSteps: [],
      labels: [],
      updatedAt: 111,
    })

    // findable by content words via FTS (content lives in the symptoms column)
    const hits = memory.lexical('ERD')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('notion:p1')

    // url round-trips; corpus row is queued for embedding like any other
    const rec = memory.get('notion:p1')
    expect(rec?.url).toBe('https://notion.so/p1')
    expect(memory.pendingEmbedding(10).map((r) => r.id)).toContain('notion:p1')

    // skip-unchanged contract holds for corpus rows
    expect(memory.updatedAtOf('notion:p1')).toBe(111)
  })
})

// Notion ingestion — a CORPUS source, not an incident source.
//
// Unlike Linear/Slack, Notion pages have no root cause to distill. We pull the
// page's text and store it verbatim so it's searchable (FTS over the whole
// page, embedding over its opening), with the page URL so a hit opens at
// source. Nothing here is distilled and nothing is written back to Notion.
//
// Incremental walk mirrors linear.ts: /v1/search returns pages newest-edited
// first, so we stop as soon as we cross the cursor and return the max
// last_edited_time seen. Cursor advances only after a completed walk (the
// caller enforces that), so a mid-walk crash re-walks rather than stranding
// the older tail behind an advanced cursor.
import type { CorpusDoc } from './types'
import { log } from '../log'

const l = log('sync:notion')
const API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

// Notion allows ~3 requests/second; a page costs 1 search slot + N block reads.
// A small delay between block requests keeps a large workspace under the limit
// without a token bucket. 429s are retried with the Retry-After Notion sends.
const BLOCK_DELAY_MS = 120

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface NotionHttp {
  ok: boolean
  status: number
  json: unknown
  retryAfter?: number
}

async function call(token: string, path: string, init?: RequestInit): Promise<NotionHttp> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const retryAfter = Number(res.headers.get('retry-after')) || undefined
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* empty/non-JSON body */
  }
  return { ok: res.ok, status: res.status, json, retryAfter }
}

/** One request with bounded retry on 429 (rate) and 5xx (transient). */
async function callRetry(token: string, path: string, init: RequestInit | undefined, label: string, attempts = 4): Promise<NotionHttp> {
  for (let i = 1; ; i++) {
    const r = await call(token, path, init)
    if (r.ok) return r
    const transient = r.status === 429 || (r.status >= 500 && r.status < 600)
    if (i >= attempts || !transient) return r
    const wait = r.retryAfter ? r.retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** (i - 1))
    l.warn(`${label}: ${r.status} (attempt ${i}/${attempts}), retrying in ${Math.round(wait / 1000)}s`)
    await sleep(wait)
  }
}

/* ------------------------------------------------------------ block text -- */

interface RichText {
  plain_text?: string
}
export interface Block {
  id: string
  type: string
  has_children?: boolean
  [k: string]: unknown
}

/** Pull plain text out of any block type that carries rich_text, plus the
 *  handful with their own text-bearing shapes (code, callout, to_do…). */
export function blockText(b: Block): string {
  const body = b[b.type] as { rich_text?: RichText[]; caption?: RichText[]; title?: string } | undefined
  if (!body) return ''
  const rt = body.rich_text ?? body.caption
  if (Array.isArray(rt)) {
    const t = rt.map((r) => r.plain_text ?? '').join('')
    // Render checkboxes so a to_do's meaning survives as text.
    if (b.type === 'to_do') {
      const checked = (b.to_do as { checked?: boolean } | undefined)?.checked
      return `${checked ? '[x]' : '[ ]'} ${t}`
    }
    return t
  }
  if (typeof body.title === 'string') return body.title // child_page
  return ''
}

/** Depth-limited recursive block walk → the page's text, one block per line.
 *  Depth is capped: deeply nested toggle trees are rare and unbounded recursion
 *  would multiply request count against the rate budget. */
async function pageText(token: string, pageId: string, depth = 0, maxDepth = 3): Promise<string> {
  const lines: string[] = []
  let cursor: string | undefined
  for (;;) {
    const qs = cursor ? `?start_cursor=${encodeURIComponent(cursor)}&page_size=100` : '?page_size=100'
    const r = await callRetry(token, `/blocks/${pageId}/children${qs}`, undefined, `blocks ${pageId.slice(0, 8)}`)
    if (!r.ok) break
    const data = r.json as { results?: Block[]; has_more?: boolean; next_cursor?: string | null }
    for (const b of data.results ?? []) {
      const t = blockText(b)
      if (t.trim()) lines.push(t)
      if (b.has_children && depth < maxDepth) {
        await sleep(BLOCK_DELAY_MS)
        const nested = await pageText(token, b.id, depth + 1, maxDepth)
        if (nested) lines.push(nested)
      }
    }
    if (!data.has_more || !data.next_cursor) break
    cursor = data.next_cursor
    await sleep(BLOCK_DELAY_MS)
  }
  return lines.join('\n')
}

/* --------------------------------------------------------------- page meta -- */

export interface SearchPage {
  id: string
  url?: string
  last_edited_time?: string
  created_time?: string
  properties?: Record<string, { type?: string; title?: RichText[] }>
}

/** Notion pages carry their title in whichever property has type "title". */
export function pageTitle(p: SearchPage): string {
  for (const prop of Object.values(p.properties ?? {})) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const t = prop.title.map((r) => r.plain_text ?? '').join('').trim()
      if (t) return t
    }
  }
  return 'Untitled'
}

/**
 * Incremental Notion pull: pages edited since `cursor`, newest-first, each with
 * its full text as a corpus doc. Returns the max last_edited_time seen (ISO) so
 * the caller can advance the cursor after a completed walk.
 */
export async function fetchNotionSince(
  token: string,
  cursor: string | undefined,
  onPage: (docs: CorpusDoc[]) => Promise<void>,
): Promise<string | undefined> {
  const since = cursor ? new Date(cursor).getTime() : 0
  let start: string | undefined
  let pages = 0
  let globalMax = since

  for (;;) {
    const body = JSON.stringify({
      filter: { property: 'object', value: 'page' },
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
      page_size: 25,
      ...(start ? { start_cursor: start } : {}),
    })
    const r = await callRetry(token, '/search', { method: 'POST', body }, 'search')
    if (!r.ok) {
      throw new Error(`Notion search failed: ${r.status}${authHint(r)}`)
    }
    const data = r.json as { results?: SearchPage[]; has_more?: boolean; next_cursor?: string | null }
    const results = data.results ?? []
    if (results.length === 0) break

    const docs: CorpusDoc[] = []
    let crossedCursor = false
    for (const p of results) {
      const edited = p.last_edited_time ? new Date(p.last_edited_time).getTime() : 0
      if (edited > globalMax) globalMax = edited
      // Newest-first: once we reach a page at or before the cursor, everything
      // after it is older too — stop the whole walk.
      if (edited <= since) {
        crossedCursor = true
        break
      }
      const text = await pageText(token, p.id)
      await sleep(BLOCK_DELAY_MS)
      // Skip genuinely empty pages — an index page with only links has no text
      // worth embedding, and a blank symptoms column would just be noise.
      if (!text.trim()) continue
      docs.push({
        id: `notion:${p.id}`,
        source: 'notion',
        title: pageTitle(p),
        text,
        url: p.url,
        createdAt: p.created_time ? new Date(p.created_time).getTime() : edited,
        updatedAt: edited || Date.now(),
      })
    }

    if (docs.length > 0) {
      await onPage(docs)
      pages++
    }
    if (crossedCursor || !data.has_more || !data.next_cursor) break
    start = data.next_cursor
    await sleep(BLOCK_DELAY_MS)
  }

  l.info(`fetched ${pages} page(s) of Notion docs since ${cursor ?? 'beginning'}`)
  return globalMax > since ? new Date(globalMax).toISOString() : cursor
}

/** Who does this token belong to? A zero-page walk on a valid token nearly
 *  always means pages were shared with a DIFFERENT integration — naming the
 *  one we authenticated as turns "0 pages" into a fixable statement. */
export async function notionWhoAmI(token: string): Promise<string | null> {
  const r = await call(token, '/users/me')
  if (!r.ok) return null
  const j = r.json as { name?: string; bot?: { workspace_name?: string } }
  const name = j.name ?? 'unnamed integration'
  const ws = j.bot?.workspace_name
  return ws ? `"${name}" in workspace "${ws}"` : `"${name}"`
}

/** 401/403 from Notion almost always means the integration wasn't shared into
 *  the workspace/pages — the single most common setup miss. */
function authHint(r: NotionHttp): string {
  if (r.status === 401 || r.status === 403) {
    return ' — check the integration token, and that it has been shared into the pages you want (Notion → page → ••• → Connections).'
  }
  return ''
}

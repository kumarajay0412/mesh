import { describe, expect, it } from 'vitest'
import { formatHit, formatRecord } from '../engine/memory-tools'
import type { MemoryRecord, MemorySearchHit } from '../../shared/types'

const record = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'linear:abc',
  source: 'linear',
  identifier: 'ENG-3443',
  title: 'Forced logged out while editing a document',
  symptoms: 'session drops mid-edit, user bounced to login',
  rootCause: 'refresh token race in auth middleware',
  resolution: 'serialize refresh; retry once on 401',
  investigationSummary: '',
  resolutionSteps: [],
  labels: ['auth'],
  reportedAt: Date.UTC(2026, 4, 14),
  resolvedAt: Date.UTC(2026, 4, 15),
  updatedAt: Date.UTC(2026, 4, 15),
  ...over,
})

describe('memory-tools formatting', () => {
  it('formats a hit compactly with identifier, source, date and match kind', () => {
    const hit: MemorySearchHit = { record: record(), score: 0.5, matched: 'hybrid' }
    const s = formatHit(hit)
    expect(s).toContain('[ENG-3443]')
    expect(s).toContain('linear · 2026-05-15 · matched: hybrid')
    expect(s).toContain('root cause: refresh token race')
    expect(s).toContain('fix: serialize refresh')
  })

  it('clips long fields instead of flooding the context', () => {
    const hit: MemorySearchHit = { record: record({ symptoms: 'x'.repeat(1000) }), score: 1, matched: 'lexical' }
    const line = formatHit(hit)
      .split('\n')
      .find((l) => l.includes('symptoms:'))!
    expect(line.length).toBeLessThan(280)
    expect(line.endsWith('…')).toBe(true)
  })

  it('omits empty sections and survives a bare record', () => {
    const bare = record({ rootCause: undefined, resolution: undefined, symptoms: '' })
    const s = formatHit({ record: bare, score: 0, matched: 'semantic' })
    expect(s).not.toContain('root cause')
    expect(s).toContain('symptoms: —')
  })

  it('formatRecord includes the discussion block only when present', () => {
    expect(formatRecord(record(), '')).not.toContain('discussion')
    expect(formatRecord(record(), '[dev] fixed by rollback')).toContain('--- discussion (bounded) ---\n[dev] fixed by rollback')
  })
})


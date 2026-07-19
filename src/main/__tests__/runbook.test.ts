import { describe, expect, it } from 'vitest'
import { staticRunbook, buildDynamicContext, buildSystemPrompt } from '../engine/runbook'
import type { MemorySearchHit, ServiceEntry } from '../../shared/types'

const svc = (name: string): ServiceEntry => ({ name, source: 'inferred', aliases: [], ids: {}, knownSolutions: [] })
const hit = (id: string, source: 'linear' | 'mesh'): MemorySearchHit => ({
  record: { id, source, identifier: id, title: 't', symptoms: 's', rootCause: 'rc', resolution: 'fix', labels: [], updatedAt: 1 },
  score: 1,
  matched: 'lexical',
})

describe('prompt-cache boundary split', () => {
  it('staticRunbook is invariant — no per-investigation content leaks in', () => {
    const a = staticRunbook()
    const b = staticRunbook()
    expect(a).toBe(b) // byte-identical → cacheable prefix
    expect(a).not.toMatch(/SIMILAR PAST INCIDENTS|SERVICE REGISTRY|LEARNED CONTEXT|TIME WINDOW/)
    expect(a).toMatch(/mesh-report/) // it IS the runbook
  })

  it('buildDynamicContext holds ONLY per-investigation blocks (no runbook)', () => {
    const ctx = buildDynamicContext([svc('payments-api')], [hit('ENG-1', 'linear')], '02:00-03:00Z', ['check the slowlog first'])
    expect(ctx).toMatch(/SERVICE REGISTRY/)
    expect(ctx).toMatch(/SIMILAR PAST INCIDENTS/)
    expect(ctx).toMatch(/LEARNED CONTEXT/)
    expect(ctx).toMatch(/TIME WINDOW: 02:00-03:00Z/)
    expect(ctx).not.toMatch(/mesh-report/) // runbook is NOT here
  })

  it('mesh-source similar incidents are flagged UNVERIFIED', () => {
    const ctx = buildDynamicContext([], [hit('INV-9', 'mesh')], undefined, [])
    expect(ctx).toMatch(/UNVERIFIED hypothesis/)
    expect(ctx).toMatch(/hypothesized cause/)
  })

  it('buildSystemPrompt (back-compat) still returns runbook + context in one string', () => {
    const full = buildSystemPrompt([svc('x')], [], undefined, [])
    expect(full).toMatch(/mesh-report/)
    expect(full).toMatch(/SERVICE REGISTRY/)
  })
})

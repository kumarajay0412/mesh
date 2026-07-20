import { describe, expect, it } from 'vitest'
import { parseWindow, formatBrief, buildK8sQueries, type PreCollectBrief } from '../engine/precollect'

const anchor = Date.UTC(2026, 6, 8, 6, 0) // Jul 8 2026, 06:00Z — a ticket report time

describe('parseWindow', () => {
  it('parses an explicit ISO range', () => {
    const w = parseWindow('2026-07-08T02:00Z to 2026-07-08T15:00Z', undefined)!
    expect(new Date(w.fromMs).toISOString()).toBe('2026-07-08T02:00:00.000Z')
    expect(new Date(w.toMs).toISOString()).toBe('2026-07-08T15:00:00.000Z')
  })

  it('anchors clock-only times to the ticket report date', () => {
    const w = parseWindow('02:00-15:00Z', anchor)!
    expect(new Date(w.fromMs).toISOString()).toBe('2026-07-08T02:00:00.000Z')
    expect(new Date(w.toMs).toISOString()).toBe('2026-07-08T15:00:00.000Z')
    expect(w.source).toMatch(/clock range/)
  })

  it('expands a single onset to a bracket around it', () => {
    const w = parseWindow('2026-07-08T14:00:00Z', undefined)!
    expect(w.toMs - w.fromMs).toBe(2.5 * 3600_000) // -30m … +2h
  })

  it('falls back to the report time when no window text is usable', () => {
    const w = parseWindow('sometime yesterday', anchor)!
    expect(w.source).toMatch(/ticket report time/)
    expect(w.fromMs).toBe(anchor - 3600_000)
  })

  it('returns null with neither a parseable window nor an anchor', () => {
    expect(parseWindow(undefined, undefined)).toBeNull()
    expect(parseWindow('', 0)).toBeNull()
  })
})

describe('formatBrief', () => {
  const base: PreCollectBrief = {
    window: { fromMs: Date.UTC(2026, 6, 8, 2, 0), toMs: Date.UTC(2026, 6, 8, 15, 0), source: 'stated range' },
    deploys: [{ instance: 'prod', text: 'deploy cmd-batch-asr v2', timeMs: Date.UTC(2026, 6, 8, 6, 41) }],
    errorDeltas: [{ service: 'cmd-batch-asr', instance: 'prod', windowCount: 413, baselineCount: 9 }],
    k8s: [],
    notes: [],
  }

  it('renders window, deploys, and error-rate ratios', () => {
    const s = formatBrief(base)
    expect(s).toMatch(/PRE-COLLECTED BRIEF/)
    expect(s).toMatch(/Onset window/)
    expect(s).toMatch(/deploy cmd-batch-asr v2/)
    expect(s).toMatch(/cmd-batch-asr: 413 vs 9 baseline → 45.9x/)
  })

  it('labels a new-vs-zero-baseline delta and a flat one', () => {
    const s = formatBrief({ ...base, errorDeltas: [{ service: 'x', instance: 'prod', windowCount: 5, baselineCount: 0 }] })
    expect(s).toMatch(/x: 5 vs 0 baseline → new \(baseline 0\)/)
  })

  it('notes an empty deploy set as a weaker prior', () => {
    const s = formatBrief({ ...base, deploys: [] })
    expect(s).toMatch(/none found/)
  })

  it('returns empty string when there is no signal at all', () => {
    expect(formatBrief(null)).toBe('')
    expect(formatBrief({ window: null, deploys: [], errorDeltas: [], k8s: [], notes: ['x'] })).toBe('')
  })

  it('renders kube-state-metrics signals, omitting zero fields', () => {
    const s = formatBrief({
      ...base,
      k8s: [
        { service: 'cmd-batch-asr', instance: 'prod', restarts: 12, ooms: 12, deploys: 1, maxUnavailable: 0 },
        { service: 'quiet-svc', instance: 'prod', restarts: 0, ooms: 0, deploys: 0, maxUnavailable: 0 },
      ],
    })
    expect(s).toMatch(/Kubernetes in the window/)
    expect(s).toMatch(/cmd-batch-asr: 12 pod restart\(s\) · 12 OOMKilled · 1 deploy\(s\)/)
    expect(s).not.toMatch(/unavailable replica/) // maxUnavailable 0 omitted
    expect(s).not.toMatch(/quiet-svc/) // all-zero service produces no line
  })

  it('a brief with ONLY k8s signal still injects', () => {
    const s = formatBrief({ window: null, deploys: [], errorDeltas: [], k8s: [{ service: 'x', instance: 'p', restarts: 3, ooms: null, deploys: null, maxUnavailable: null }], notes: [] })
    expect(s).toMatch(/x: 3 pod restart\(s\)/)
  })
})

describe('buildK8sQueries', () => {
  it('builds prefix-matched kube-state-metrics PromQL with a minute duration', () => {
    const q = buildK8sQueries('cmd-batch-asr', 3 * 3600_000)
    expect(q.restarts).toBe('sum(increase(kube_pod_container_status_restarts_total{pod=~"cmd-batch-asr.*"}[180m]))')
    expect(q.ooms).toMatch(/kube_pod_container_status_last_terminated_reason\{reason="OOMKilled",pod=~"cmd-batch-asr\.\*"\}/)
    expect(q.deploys).toMatch(/changes\(kube_deployment_status_observed_generation\{deployment=~"cmd-batch-asr\.\*"\}\[180m\]\)/)
  })

  it('regex-escapes service names so a dotted name is not a wildcard', () => {
    const q = buildK8sQueries('api.v2', 60_000)
    expect(q.restarts).toContain('pod=~"api\\.v2.*"')
  })

  it('scopes to a namespace when one is known (Phase 2)', () => {
    const q = buildK8sQueries('cmd-batch-asr', 60_000, 'dictation')
    expect(q.restarts).toContain('pod=~"cmd-batch-asr.*",namespace="dictation"')
    expect(q.deploys).toContain('deployment=~"cmd-batch-asr.*",namespace="dictation"')
  })
})

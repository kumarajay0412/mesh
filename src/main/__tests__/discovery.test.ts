// Boot-discovery trigger + service↔repo matching. The predicate exists
// because of a real stuck state: after a DB wipe, discovery ran before
// repoRoot was re-set, matched 185 services against zero repos, and — since
// boot discovery only fired on an EMPTY registry — the all-NULL mapping was
// permanent, so repo syncs built no code graphs.
import { describe, expect, it } from 'vitest'
import { matchRepo, shouldRunBootDiscovery } from '../registry/discovery'

describe('shouldRunBootDiscovery', () => {
  it('empty registry → run (first setup)', () => {
    expect(shouldRunBootDiscovery([], 0)).toBe(true)
    expect(shouldRunBootDiscovery([], 50)).toBe(true)
  })

  it('nothing mapped but clones exist → run (heals the post-wipe state)', () => {
    expect(shouldRunBootDiscovery([{ repo: undefined }, { repo: undefined }], 195)).toBe(true)
  })

  it('nothing mapped and no clones → skip (re-running cannot map anything)', () => {
    expect(shouldRunBootDiscovery([{ repo: undefined }], 0)).toBe(false)
  })

  it('partial mapping → skip (normal: infra pods never map to repos)', () => {
    expect(shouldRunBootDiscovery([{ repo: 'caseflow-service' }, { repo: undefined }], 195)).toBe(false)
  })
})

describe('matchRepo', () => {
  const repos = ['adalat-router', 'caseflow-service', 'speech-orchestrator', 'user-service', 'cryptic']

  it('exact and normalized names', () => {
    expect(matchRepo('caseflow-service', repos)).toBe('caseflow-service')
    expect(matchRepo('Caseflow_Service', repos)).toBe('caseflow-service')
  })

  it('fuzzy containment — namespaced and suffixed k8s names', () => {
    expect(matchRepo('prod/caseflow-service', repos)).toBe('caseflow-service')
    expect(matchRepo('adalat-router-v2', repos)).toBe('adalat-router')
    expect(matchRepo('litiga-speech-orchestrator-dictation', repos)).toBe('speech-orchestrator')
    expect(matchRepo('user-service-signup-reminder-email-cron', repos)).toBe('user-service')
  })

  it('no invented matches', () => {
    expect(matchRepo('calico-typha', repos)).toBeUndefined()
    expect(matchRepo('gke-metadata-server', repos)).toBeUndefined()
  })
})

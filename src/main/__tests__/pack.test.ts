// Team pack round-trip on real migrated :memory: DBs. The invariants that
// matter: import twice = import once; local decisions and manual entries
// survive; tokens only open with the right passphrase; machine-bound fields
// never travel.
import { describe, expect, it } from 'vitest'
import { applyPack, buildPack, decodePack, encodePack, openSecrets, sealSecrets } from '../pack/pack'
import { openTestDb } from './helpers'

const seed = (db: ReturnType<typeof openTestDb>) => {
  db.prepare(
    `INSERT INTO memory (id, source, ticket_id, title, symptoms, root_cause, updated_at, embedded)
     VALUES ('linear:ENG-1', 'linear', 'ENG-1', 'checkout 5xx', 'timeouts calling settle', 'timeout cut to 500ms', 1000, 1)`,
  ).run()
  db.prepare(`INSERT INTO investigations (id, title, status, stage, source, created_at) VALUES ('INV-001', 'demo', 'resolved', 'report', 'manual', 1000)`).run()
  const ses = db
    .prepare(`INSERT INTO sessions (investigation_id, provider, started_at, native_session_id, cost_usd) VALUES ('INV-001', 'claude', 1000, 'sess-abc', 1.25)`)
    .run()
  db.prepare(`INSERT INTO events (investigation_id, ts, type, payload_json, session_id) VALUES ('INV-001', 1001, 'note', '{}', ?)`).run(ses.lastInsertRowid)
  db.prepare(`INSERT INTO learnings (text, investigation_id, status, created_at) VALUES ('settle p95 is 1.2s', 'INV-001', 'accepted', 1000)`).run()
  db.prepare(`INSERT INTO map_nodes (id, label, kind) VALUES ('svc-a', 'Service A', 'backend')`).run()
  db.prepare(`INSERT INTO map_edges (from_id, to_id, label, kind, status) VALUES ('svc-a', 'svc-a', 'self', 'http', 'proposed')`).run()
  db.prepare(`INSERT INTO services (name, repo, source, updated_at) VALUES ('svc-a', 'repo-a', 'inferred', 1000)`).run()
  db.prepare(`INSERT INTO sync_state (source, cursor, status) VALUES ('linear', '2026-08-01', 'running')`).run()
  db.prepare(`INSERT INTO settings (key, value_json) VALUES ('githubOrg', '"adalat-ai-tech"')`).run()
}

describe('pack round-trip', () => {
  it('encode → decode survives; sensitive machine state never travels', () => {
    const src = openTestDb()
    seed(src)
    const pack = decodePack(encodePack(buildPack(src, { vecAvailable: false })))
    expect(pack.data.memory).toHaveLength(1)
    expect(pack.data.sessions[0].native_session_id).toBeNull() // login-bound — nulled
    expect(pack.data).not.toHaveProperty('repos') // paths are machine-specific
    expect(pack.data).not.toHaveProperty('secrets') // table never exported raw
    expect(pack.secrets).toBeUndefined() // no passphrase → no tokens
  })

  it('import merges, remaps session ids, and is idempotent', () => {
    const src = openTestDb()
    seed(src)
    const pack = buildPack(src, { vecAvailable: false })
    const dst = openTestDb()

    const r1 = applyPack(dst, pack, { vecAvailable: false })
    expect(r1.counts.memory.applied).toBe(1)
    expect(r1.counts.investigations.applied).toBe(1)
    // event kept its session link through the autoinc remap
    const ev = dst.prepare('SELECT session_id FROM events').get() as { session_id: number }
    const ses = dst.prepare('SELECT id, native_session_id FROM sessions').get() as { id: number; native_session_id: string | null }
    expect(ev.session_id).toBe(ses.id)
    expect(ses.native_session_id).toBeNull()

    const r2 = applyPack(dst, pack, { vecAvailable: false })
    expect(dst.prepare('SELECT COUNT(*) n FROM events').get()).toEqual({ n: 1 }) // no duplicate timeline
    expect(dst.prepare('SELECT COUNT(*) n FROM learnings').get()).toEqual({ n: 1 }) // deduped
    expect(r2.counts.learnings.skipped).toBe(1)
    // sync status imports as idle even though the exporter was mid-run
    expect(dst.prepare(`SELECT status FROM sync_state WHERE source='linear'`).get()).toEqual({ status: 'idle' })
  })

  it('recipient decisions win: manual services and edge decisions stay', () => {
    const src = openTestDb()
    seed(src)
    const pack = buildPack(src, { vecAvailable: false })

    const dst = openTestDb()
    dst.prepare(`INSERT INTO services (name, repo, source, updated_at) VALUES ('svc-a', 'their-repo', 'manual', 2000)`).run()
    dst.prepare(`INSERT INTO map_edges (from_id, to_id, label, kind, status) VALUES ('svc-a', 'svc-a', 'self', 'http', 'accepted')`).run()

    const r = applyPack(dst, pack, { vecAvailable: false })
    expect(r.counts.services.skipped).toBe(1) // inferred never beats manual
    expect(dst.prepare(`SELECT repo FROM services WHERE name='svc-a'`).get()).toEqual({ repo: 'their-repo' })
    expect(dst.prepare(`SELECT status FROM map_edges`).get()).toEqual({ status: 'accepted' }) // their accept stands
  })

  it('memory import without vectors re-queues local embedding', () => {
    const src = openTestDb()
    seed(src) // exporter had embedded=1
    const dst = openTestDb()
    applyPack(dst, buildPack(src, { vecAvailable: false }), { vecAvailable: false })
    expect(dst.prepare(`SELECT embedded FROM memory WHERE id='linear:ENG-1'`).get()).toEqual({ embedded: 0 })
  })

  it('secrets: seal/open round-trips; wrong passphrase fails closed; existing tokens kept', () => {
    const sealed = sealSecrets({ 'linear.apiKey': 'lin_abc' }, 'court-reporter')
    expect(openSecrets(sealed, 'court-reporter')).toEqual({ 'linear.apiKey': 'lin_abc' })
    expect(() => openSecrets(sealed, 'wrong')).toThrow(/passphrase/)

    const src = openTestDb()
    seed(src)
    const pack = buildPack(src, { vecAvailable: false, passphrase: 'court-reporter', secretValues: { 'linear.apiKey': 'lin_abc', 'slack.token': 'xoxp-1' } })
    expect(pack.secrets).toBeDefined()

    const dst = openTestDb()
    const stored: Record<string, string> = { 'slack.token': 'their-own' }
    const r = applyPack(dst, pack, {
      vecAvailable: false,
      passphrase: 'court-reporter',
      setSecret: (id, v) => (stored[id] = v),
      hasSecret: (id) => id in stored,
    })
    expect(r.secrets).toEqual({ applied: 1, skipped: 1 })
    expect(stored['linear.apiKey']).toBe('lin_abc')
    expect(stored['slack.token']).toBe('their-own') // never clobbered

    // sealed tokens + no passphrase on import → warn, import data anyway
    const dst2 = openTestDb()
    const r2 = applyPack(dst2, pack, { vecAvailable: false })
    expect(r2.warnings.join(' ')).toMatch(/tokens not imported/)
    expect(r2.counts.memory.applied).toBe(1)
  })

  it('rejects non-pack files and future versions', () => {
    expect(() => decodePack(Buffer.from('junk'))).toThrow()
    const src = openTestDb()
    const pack = buildPack(src, { vecAvailable: false })
    expect(() => decodePack(encodePack({ ...pack, version: 99 }))).toThrow(/newer/)
  })
})

// Repos + migrations against :memory: — proves the Section 8 schema, FTS triggers,
// idempotent memory upsert, and the cursor semantics. Runs under plain node
// ABI (vitest), which is why better-sqlite3 must also work outside Electron.
import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openTestDb } from './helpers'
import { migrate } from '../db/migrate'
import { investigationsRepo } from '../db/repos/investigations'
import { eventsRepo } from '../db/repos/events'
import { memoryRepo } from '../db/repos/memory'
import { servicesRepo } from '../db/repos/services'
import { syncStateRepo } from '../db/repos/syncState'
import { settingsRepo } from '../db/repos/settings'
import { sessionsRepo } from '../db/repos/sessions'
import { learningsRepo } from '../db/repos/learnings'

let db: Database.Database

beforeEach(() => {
  db = openTestDb()
})

describe('migrations', () => {
  it('creates the Section 8 tables and is idempotent', () => {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') OR type='table'`).all() as { name: string }[]).map((t) => t.name)
    for (const t of ['services', 'repos', 'investigations', 'events', 'memory', 'sync_state', 'links', 'secrets', 'settings', 'sessions', 'learnings', 'map_nodes', 'map_edges', 'slack_threads']) {
      expect(tables).toContain(t)
    }
    migrate(db) // second run: no-op, no throw
    expect(db.pragma('user_version', { simple: true })).toBe(9)
  })

  it('learnings embedding queue: accept → pending → embedded', () => {
    const learnings = learningsRepo(db)
    learnings.propose('INV-001', ['check acme-charts for memory limits'])
    const proposed = learnings.list('proposed')
    expect(learnings.pendingEmbedding()).toHaveLength(0) // proposed ≠ pending
    learnings.decide(proposed[0].id, true)
    const pending = learnings.pendingEmbedding()
    expect(pending).toHaveLength(1)
    learnings.markEmbedded(pending[0].id)
    expect(learnings.pendingEmbedding()).toHaveLength(0)
    expect(learnings.textsByIds([pending[0].id])[0].text).toContain('acme-charts')
  })
})

describe('investigations + events', () => {
  it('creates, ids sequentially, stages, reports', () => {
    const invs = investigationsRepo(db)
    expect(invs.nextId()).toBe('INV-001')
    invs.create({ id: 'INV-001', title: 'test', status: 'investigating', stage: 'intake', source: 'manual', createdAt: 1 })
    expect(invs.nextId()).toBe('INV-002')

    invs.setStage('INV-001', 'investigate')
    invs.setReport('INV-001', { hypothesis: 'h', confidence: 'probable', suspects: [], evidence: [], timeline: [], suggestedFix: '', unexplored: [] }, 'probable')
    const inv = invs.get('INV-001')!
    expect(inv.stage).toBe('report')
    expect(inv.report?.hypothesis).toBe('h')

    const events = eventsRepo(db)
    events.appendAgentEvent('INV-001', { kind: 'reasoning', text: 'thinking', ts: 2 })
    events.appendAgentEvent('INV-001', { kind: 'done', ts: 3 })
    events.append('INV-001', 'approval.requested', { tool: 'Bash' }) // non-agent event
    const timeline = events.timeline('INV-001')
    expect(timeline).toHaveLength(2) // approval rows are audit, not timeline
    expect(timeline[0]).toMatchObject({ kind: 'reasoning' })
  })
})

describe('memory repo', () => {
  it('upsert is idempotent by id and keeps raw comments on re-distill', () => {
    const memory = memoryRepo(db)
    const base = {
      id: 'linear:abc',
      source: 'linear' as const,
      ticketId: 'abc',
      title: 'OOM in settle',
      symptoms: 'pods OOMKilled during settlement batch',
      resolutionSteps: ['check batch size'],
      labels: ['payments'],
      updatedAt: 10,
      rawCommentsJson: '{"n":100}',
    }
    memory.upsert(base)
    memory.upsert({ ...base, symptoms: 'updated symptoms', updatedAt: 20, rawCommentsJson: undefined })
    expect(memory.count()).toBe(1)
    const rec = memory.get('linear:abc')!
    expect(rec.symptoms).toBe('updated symptoms')
    // raw preserved when the update carries none
    const raw = (db.prepare('SELECT raw_comments_json r FROM memory').get() as { r: string }).r
    expect(raw).toBe('{"n":100}')
  })

  it('FTS triggers keep memory_fts in sync through update', () => {
    const memory = memoryRepo(db)
    memory.upsert({ id: 'm1', source: 'slack', title: 'ingress 502s', symptoms: 'keepalive mismatch resets', resolutionSteps: [], labels: [], updatedAt: 1 })
    expect(memory.lexical('"keepalive"').map((r) => r.id)).toContain('m1')
    memory.upsert({ id: 'm1', source: 'slack', title: 'ingress 502s', symptoms: 'totally different words now', resolutionSteps: [], labels: [], updatedAt: 2 })
    expect(memory.lexical('"keepalive"')).toHaveLength(0)
    expect(memory.lexical('"different"').map((r) => r.id)).toContain('m1')
  })

  it('signature lookup + embedding queue lifecycle', () => {
    const memory = memoryRepo(db)
    memory.upsert({ id: 'm2', source: 'linear', title: 't', symptoms: 's', errorSignature: 'OOMKilled:settle', resolutionSteps: [], labels: [], updatedAt: 1 })
    expect(memory.bySignature('OOMKilled:settle')).toHaveLength(1)
    const pending = memory.pendingEmbedding()
    expect(pending.map((p) => p.id)).toContain('m2')
    memory.markEmbedded(pending[0].rowid)
    expect(memory.pendingEmbedding()).toHaveLength(0)
  })
})

describe('services repo', () => {
  it('manual wins over inferred on conflict (Section 4)', () => {
    const services = servicesRepo(db)
    services.upsert({ name: 'payments-api', source: 'manual', aliases: ['payments'], ids: {}, knownSolutions: [], repo: 'hand-set' })
    services.upsert({ name: 'payments-api', source: 'inferred', aliases: [], ids: {}, knownSolutions: [], repo: 'guessed' })
    expect(services.get('payments-api')?.repo).toBe('hand-set')
  })

  it('resolves mentions via aliases', () => {
    const services = servicesRepo(db)
    services.upsert({ name: 'payments-api', source: 'inferred', aliases: ['payments', 'pay-svc'], ids: {}, knownSolutions: [] })
    expect(services.resolveMention('payments is down')?.name).toBe('payments-api')
    expect(services.resolveMention('pay-svc')?.name).toBe('payments-api')
    expect(services.resolveMention('search')).toBeNull()
  })
})

describe('sync state + settings', () => {
  it('cursor advances per page; finishRun stamps the run', () => {
    const sync = syncStateRepo(db)
    sync.markRunning('linear')
    sync.setCursor('linear', '2026-07-01T00:00:00Z')
    sync.setCursor('linear', '2026-07-02T00:00:00Z')
    expect(sync.get('linear').cursor).toBe('2026-07-02T00:00:00Z')
    sync.finishRun('linear', 'idle')
    const st = sync.get('linear')
    expect(st.status).toBe('idle')
    expect(st.lastRunAt).toBeTypeOf('number')
  })

  it('cursor is monotonic — newest-first pages cannot regress it', () => {
    const sync = syncStateRepo(db)
    sync.setCursor('linear', '2026-07-06T12:00:00Z') // page 1 (newest)
    sync.setCursor('linear', '2026-06-30T06:00:00Z') // later page, older items
    expect(sync.get('linear').cursor).toBe('2026-07-06T12:00:00Z')
  })

  it('resetStale unwedges a killed run', () => {
    const sync = syncStateRepo(db)
    sync.markRunning('linear')
    sync.resetStale()
    expect(sync.get('linear').status).toBe('idle')
  })

  it('remove drops a stale source row (renamed channel) without touching others', () => {
    const sync = syncStateRepo(db)
    sync.finishRun('slack:#reporting', 'needs-connection', 'no Slack token')
    sync.finishRun('slack:juda-reporting-prod', 'idle')
    sync.remove('slack:#reporting')
    const sources = sync.list().map((s) => s.source)
    expect(sources).not.toContain('slack:#reporting')
    expect(sources).toContain('slack:juda-reporting-prod')
  })

  it('permissionMode defaults to approve and rejects unknown values', () => {
    const settings = settingsRepo(db)
    expect(settings.get().permissionMode).toBe('default')
    const out = settings.set({ permissionMode: 'yolo' as never, provider: 'codex' })
    expect(out.permissionMode).toBe('default') // invalid mode ignored
    expect(out.provider).toBe('codex')
    expect(settings.set({ permissionMode: 'auto' }).permissionMode).toBe('auto')
  })

  it('sessions ledger: start → events tagged → end with outcome', () => {
    const sessions = sessionsRepo(db)
    const events = eventsRepo(db)
    const sid = sessions.start('INV-001', 'claude', 'opus', 'high', 'default')
    events.appendAgentEvent('INV-001', { kind: 'reasoning', text: 'step', ts: 1 }, sid)
    sessions.setNativeId(sid, 'native-abc')
    sessions.end(sid, 'report')
    const rows = sessions.forInvestigation('INV-001')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ provider: 'claude', model: 'opus', outcome: 'report' })
    const tagged = db.prepare('SELECT count(*) c FROM events WHERE session_id = ?').get(sid) as { c: number }
    expect(tagged.c).toBe(1)
  })
})

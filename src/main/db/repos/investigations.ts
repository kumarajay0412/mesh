import type { Database } from 'better-sqlite3'
import type { Confidence, Investigation, InvestigationStatus, Report, SourceKind, Stage } from '../../../shared/types'

interface Row {
  id: string
  title: string
  service: string | null
  status: string
  stage: string
  confidence: string | null
  source: string
  ticket_ref: string | null
  similar_json: string
  report_json: string | null
  session_id: string | null
  created_at: number
  closed_at: number | null
}

function toInvestigation(r: Row): Investigation {
  return {
    id: r.id,
    title: r.title,
    service: r.service ?? undefined,
    status: r.status as InvestigationStatus,
    stage: r.stage as Stage,
    confidence: (r.confidence ?? undefined) as Confidence | undefined,
    source: r.source as SourceKind,
    ticketRef: r.ticket_ref ?? undefined,
    similarTo: JSON.parse(r.similar_json),
    report: r.report_json ? (JSON.parse(r.report_json) as Report) : undefined,
    createdAt: r.created_at,
    closedAt: r.closed_at ?? undefined,
  }
}

export function investigationsRepo(db: Database) {
  return {
    list(): Investigation[] {
      return (db.prepare('SELECT * FROM investigations ORDER BY created_at DESC').all() as Row[]).map(toInvestigation)
    },

    get(id: string): Investigation | null {
      const r = db.prepare('SELECT * FROM investigations WHERE id = ?').get(id) as Row | undefined
      return r ? toInvestigation(r) : null
    },

    nextId(): string {
      const r = db
        .prepare(`SELECT id FROM investigations WHERE id LIKE 'INV-%' ORDER BY CAST(substr(id, 5) AS INTEGER) DESC LIMIT 1`)
        .get() as { id: string } | undefined
      const n = r ? parseInt(r.id.slice(4), 10) + 1 : 1
      return `INV-${String(n).padStart(3, '0')}`
    },

    create(inv: Investigation): void {
      db.prepare(
        `INSERT INTO investigations (id, title, service, status, stage, confidence, source, ticket_ref, similar_json, report_json, session_id, created_at, closed_at)
         VALUES (@id, @title, @service, @status, @stage, @confidence, @source, @ticketRef, @similar, @report, NULL, @createdAt, NULL)`,
      ).run({
        id: inv.id,
        title: inv.title,
        service: inv.service ?? null,
        status: inv.status,
        stage: inv.stage,
        confidence: inv.confidence ?? null,
        source: inv.source,
        ticketRef: inv.ticketRef ?? null,
        similar: JSON.stringify(inv.similarTo ?? []),
        report: inv.report ? JSON.stringify(inv.report) : null,
        createdAt: inv.createdAt,
      })
    },

    setStage(id: string, stage: Stage): void {
      db.prepare('UPDATE investigations SET stage = ? WHERE id = ?').run(stage, id)
    },

    setStatus(id: string, status: InvestigationStatus, closedAt?: number): void {
      db.prepare('UPDATE investigations SET status = ?, closed_at = coalesce(?, closed_at) WHERE id = ?').run(status, closedAt ?? null, id)
    },

    setSessionId(id: string, sessionId: string): void {
      db.prepare('UPDATE investigations SET session_id = ? WHERE id = ?').run(sessionId, id)
    },

    getSessionId(id: string): string | null {
      const r = db.prepare('SELECT session_id FROM investigations WHERE id = ?').get(id) as { session_id: string | null } | undefined
      return r?.session_id ?? null
    },

    setReport(id: string, report: Report, confidence: Confidence): void {
      db.prepare('UPDATE investigations SET report_json = ?, confidence = ?, stage = ?, status = ? WHERE id = ?').run(
        JSON.stringify(report),
        confidence,
        'report',
        'report',
        id,
      )
    },

    setService(id: string, service: string): void {
      db.prepare('UPDATE investigations SET service = ? WHERE id = ?').run(service, id)
    },

    setSimilar(id: string, similar: { id: string; note: string }[]): void {
      db.prepare('UPDATE investigations SET similar_json = ? WHERE id = ?').run(JSON.stringify(similar), id)
    },
  }
}

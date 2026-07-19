import type { Database } from 'better-sqlite3'
import type { MemoryRecord } from '../../../shared/types'

export interface MemoryRow {
  rowid: number
  id: string
  source: string
  ticket_id: string | null
  identifier: string | null
  slack_url: string | null
  title: string
  symptoms: string
  root_cause: string | null
  resolution: string | null
  investigation_summary: string | null
  resolution_steps_json: string
  error_signature: string | null
  raw_comments_json: string | null
  labels_json: string
  priority: string | null
  reported_at: number | null
  resolved_at: number | null
  updated_at: number
  embedded: number
  linked_id: string | null
}

export function rowToRecord(r: MemoryRow): MemoryRecord {
  return {
    id: r.id,
    source: r.source as MemoryRecord['source'],
    ticketId: r.ticket_id ?? undefined,
    identifier: r.identifier ?? undefined,
    slackUrl: r.slack_url ?? undefined,
    title: r.title,
    symptoms: r.symptoms,
    rootCause: r.root_cause ?? undefined,
    resolution: r.resolution ?? undefined,
    investigationSummary: r.investigation_summary ?? undefined,
    resolutionSteps: JSON.parse(r.resolution_steps_json),
    errorSignature: r.error_signature ?? undefined,
    labels: JSON.parse(r.labels_json),
    priority: r.priority ?? undefined,
    reportedAt: r.reported_at ?? undefined,
    resolvedAt: r.resolved_at ?? undefined,
    updatedAt: r.updated_at,
    linkedId: r.linked_id ?? undefined,
  }
}

export function memoryRepo(db: Database) {
  return {
    /** Idempotent upsert keyed by (source, ticket_id) when a ticket id exists,
     *  else by primary id — re-running ingestion never duplicates (Section 7.1). */
    upsert(rec: MemoryRecord & { rawCommentsJson?: string }): void {
      db.prepare(
        `INSERT INTO memory (id, source, ticket_id, identifier, slack_url, title, symptoms, root_cause, resolution,
                             investigation_summary, resolution_steps_json, error_signature, raw_comments_json,
                             labels_json, priority, reported_at, resolved_at, updated_at, embedded)
         VALUES (@id, @source, @ticketId, @identifier, @slackUrl, @title, @symptoms, @rootCause, @resolution,
                 @summary, @steps, @signature, @raw, @labels, @priority, @reportedAt, @resolvedAt, @updatedAt, 0)
         ON CONFLICT(id) DO UPDATE SET
           identifier = excluded.identifier, slack_url = excluded.slack_url, title = excluded.title,
           symptoms = excluded.symptoms, root_cause = excluded.root_cause, resolution = excluded.resolution,
           investigation_summary = excluded.investigation_summary, resolution_steps_json = excluded.resolution_steps_json,
           error_signature = excluded.error_signature, raw_comments_json = coalesce(excluded.raw_comments_json, memory.raw_comments_json),
           labels_json = excluded.labels_json, priority = excluded.priority,
           reported_at = excluded.reported_at, resolved_at = excluded.resolved_at,
           updated_at = excluded.updated_at, embedded = 0`,
      ).run({
        id: rec.id,
        source: rec.source,
        ticketId: rec.ticketId ?? null,
        identifier: rec.identifier ?? null,
        slackUrl: rec.slackUrl ?? null,
        title: rec.title,
        symptoms: rec.symptoms,
        rootCause: rec.rootCause ?? null,
        resolution: rec.resolution ?? null,
        summary: rec.investigationSummary ?? null,
        steps: JSON.stringify(rec.resolutionSteps ?? []),
        signature: rec.errorSignature ?? null,
        raw: rec.rawCommentsJson ?? null,
        labels: JSON.stringify(rec.labels ?? []),
        priority: rec.priority ?? null,
        reportedAt: rec.reportedAt ?? null,
        resolvedAt: rec.resolvedAt ?? null,
        updatedAt: rec.updatedAt,
      })
    },

    findIdByTicket(source: string, ticketId: string): string | null {
      const r = db.prepare('SELECT id FROM memory WHERE source = ? AND ticket_id = ?').get(source, ticketId) as { id: string } | undefined
      return r?.id ?? null
    },

    /** Skip-unchanged fast path: the stored updated_at for a record, or null.
     *  A re-walk compares the source's updatedAt against this — equal means
     *  nothing changed, so hydrate/distill/upsert are all skippable. */
    updatedAtOf(id: string): number | null {
      const r = db.prepare('SELECT updated_at FROM memory WHERE id = ?').get(id) as { updated_at: number } | undefined
      return r?.updated_at ?? null
    },

    /** Cheap metadata refresh for skip-unchanged rows — labels can gain new
     *  derived tags (e.g. project:<slugId>) without re-distilling anything. */
    updateLabels(id: string, labels: string[]): void {
      db.prepare('UPDATE memory SET labels_json = ? WHERE id = ?').run(JSON.stringify(labels), id)
    },

    get(id: string): MemoryRecord | null {
      const r = db.prepare('SELECT rowid, * FROM memory WHERE id = ?').get(id) as MemoryRow | undefined
      return r ? rowToRecord(r) : null
    },

    /** Lookup by human identifier (ENG-2903) — how tickets arrive at intake. */
    byIdentifier(identifier: string): (MemoryRecord & { rawCommentsJson?: string }) | null {
      const r = db.prepare('SELECT rowid, * FROM memory WHERE upper(identifier) = upper(?)').get(identifier) as MemoryRow | undefined
      if (!r) return null
      return { ...rowToRecord(r), rawCommentsJson: r.raw_comments_json ?? undefined }
    },

    /** Lookup by row id (slack:<ts>, mesh:INV-…), raw content included —
     *  how sources without human identifiers arrive at get_incident. */
    getWithRaw(id: string): (MemoryRecord & { rawCommentsJson?: string }) | null {
      const r = db.prepare('SELECT rowid, * FROM memory WHERE id = ?').get(id) as MemoryRow | undefined
      if (!r) return null
      return { ...rowToRecord(r), rawCommentsJson: r.raw_comments_json ?? undefined }
    },

    /** Does a row with this id exist? (cheap existence check for cross-linking) */
    exists(id: string): boolean {
      return db.prepare('SELECT 1 FROM memory WHERE id = ?').get(id) !== undefined
    },

    /** Cross-link two memory rows as the same incident, both directions. */
    linkTo(a: string, b: string): void {
      const stmt = db.prepare('UPDATE memory SET linked_id = ? WHERE id = ?')
      stmt.run(b, a)
      stmt.run(a, b)
    },

    /** Slack rows whose text/thread mentions a ticket identifier (ENG-1234). */
    slackIdsMentioning(identifier: string): string[] {
      const like = `%${identifier.toUpperCase()}%`
      return (
        db
          .prepare(`SELECT id FROM memory WHERE source = 'slack' AND (upper(title) LIKE ? OR upper(coalesce(raw_comments_json,'')) LIKE ?)`)
          .all(like, like) as { id: string }[]
      ).map((r) => r.id)
    },

    bySignature(signature: string, limit = 5): MemoryRow[] {
      return db.prepare('SELECT rowid, * FROM memory WHERE error_signature = ? ORDER BY updated_at DESC LIMIT ?').all(signature, limit) as MemoryRow[]
    },

    /** FTS5 BM25 over (symptoms×10, title×3, root_cause×1). */
    lexical(matchExpr: string, limit = 20): (MemoryRow & { rank: number })[] {
      return db
        .prepare(
          `SELECT m.rowid, m.*, bm25(memory_fts, 10.0, 3.0, 1.0) AS rank
           FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
           WHERE memory_fts MATCH ?
           ORDER BY rank LIMIT ?`,
        )
        .all(matchExpr, limit) as (MemoryRow & { rank: number })[]
    },

    /** Rows still waiting for an embedding — the backfill queue (Section 7.1). */
    pendingEmbedding(limit = 64): MemoryRow[] {
      return db.prepare('SELECT rowid, * FROM memory WHERE embedded = 0 ORDER BY updated_at DESC LIMIT ?').all(limit) as MemoryRow[]
    },

    markEmbedded(rowid: number): void {
      db.prepare('UPDATE memory SET embedded = 1 WHERE rowid = ?').run(rowid)
    },

    byRowids(rowids: number[]): MemoryRow[] {
      if (rowids.length === 0) return []
      const q = `SELECT rowid, * FROM memory WHERE rowid IN (${rowids.map(() => '?').join(',')})`
      return db.prepare(q).all(...rowids) as MemoryRow[]
    },

    count(): number {
      return (db.prepare('SELECT count(*) c FROM memory').get() as { c: number }).c
    },
  }
}

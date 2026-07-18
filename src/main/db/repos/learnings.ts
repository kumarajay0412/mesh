import type { Database } from 'better-sqlite3'
import type { Learning } from '../../../shared/types'

/** Learned context (Section 7 extension): operational knowledge proposed by the
 *  agent at report time, gated by the user, injected into future prompts. */
export function learningsRepo(db: Database) {
  return {
    propose(investigationId: string, texts: string[]): void {
      const stmt = db.prepare('INSERT INTO learnings (investigation_id, text, status, created_at) VALUES (?, ?, ?, ?)')
      const tx = db.transaction(() => {
        for (const text of texts) {
          const t = text.trim()
          if (!t) continue
          // dedupe: identical accepted/proposed text is not proposed again
          const dup = db.prepare(`SELECT 1 FROM learnings WHERE text = ? AND status IN ('proposed','accepted')`).get(t)
          if (!dup) stmt.run(investigationId, t, 'proposed', Date.now())
        }
      })
      tx()
    },

    decide(id: number, accept: boolean): void {
      db.prepare('UPDATE learnings SET status = ?, decided_at = ? WHERE id = ?').run(accept ? 'accepted' : 'rejected', Date.now(), id)
    },

    list(status?: Learning['status']): Learning[] {
      const rows = (
        status
          ? db.prepare('SELECT * FROM learnings WHERE status = ? ORDER BY id DESC').all(status)
          : db.prepare('SELECT * FROM learnings ORDER BY id DESC').all()
      ) as { id: number; investigation_id: string | null; text: string; status: string; created_at: number; decided_at: number | null }[]
      return rows.map((r) => ({
        id: r.id,
        investigationId: r.investigation_id ?? undefined,
        text: r.text,
        status: r.status as Learning['status'],
        createdAt: r.created_at,
        decidedAt: r.decided_at ?? undefined,
      }))
    },

    /** Accepted learnings, newest first — the small-N fallback path. */
    acceptedTexts(limit = 40): string[] {
      return (db.prepare(`SELECT text FROM learnings WHERE status = 'accepted' ORDER BY id DESC LIMIT ?`).all(limit) as { text: string }[]).map(
        (r) => r.text,
      )
    },

    acceptedCount(): number {
      return (db.prepare(`SELECT count(*) c FROM learnings WHERE status = 'accepted'`).get() as { c: number }).c
    },

    /** accepted-but-unembedded — the embedding queue (mirrors memory). */
    pendingEmbedding(limit = 64): { id: number; text: string }[] {
      return db.prepare(`SELECT id, text FROM learnings WHERE status = 'accepted' AND embedded = 0 LIMIT ?`).all(limit) as { id: number; text: string }[]
    },

    markEmbedded(id: number): void {
      db.prepare('UPDATE learnings SET embedded = 1 WHERE id = ?').run(id)
    },

    textsByIds(ids: number[]): { id: number; text: string }[] {
      if (ids.length === 0) return []
      return db
        .prepare(`SELECT id, text FROM learnings WHERE status = 'accepted' AND id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as { id: number; text: string }[]
    },

    proposedFor(investigationId: string): Learning[] {
      return this.list().filter((l) => l.investigationId === investigationId && l.status === 'proposed')
    },
  }
}

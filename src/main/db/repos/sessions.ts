import type { Database } from 'better-sqlite3'

/** The session ledger: one row per provider session (a retry = a new row),
 *  with every event carrying its session_id — full replayable history. */
export function sessionsRepo(db: Database) {
  return {
    start(investigationId: string, provider: string, model?: string, effort?: string, permissionMode?: string): number {
      const r = db
        .prepare(
          `INSERT INTO sessions (investigation_id, provider, model, effort, permission_mode, started_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(investigationId, provider, model ?? null, effort ?? null, permissionMode ?? null, Date.now())
      return Number(r.lastInsertRowid)
    },

    setNativeId(id: number, nativeSessionId: string): void {
      db.prepare('UPDATE sessions SET native_session_id = ? WHERE id = ?').run(nativeSessionId, id)
    },

    end(
      id: number,
      outcome: 'report' | 'no-report' | 'error' | 'abandoned' | 'wedge-retried',
      usage?: { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; costUsd: number | null; numTurns: number | null } | null,
    ): void {
      db.prepare(
        `UPDATE sessions SET ended_at = ?, outcome = ?,
           input_tokens = coalesce(?, input_tokens), cache_write_tokens = coalesce(?, cache_write_tokens),
           cache_read_tokens = coalesce(?, cache_read_tokens), output_tokens = coalesce(?, output_tokens),
           cost_usd = coalesce(?, cost_usd), num_turns = coalesce(?, num_turns)
         WHERE id = ?`,
      ).run(
        Date.now(),
        outcome,
        usage?.inputTokens ?? null,
        usage?.cacheWriteTokens ?? null,
        usage?.cacheReadTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.costUsd ?? null,
        usage?.numTurns ?? null,
        id,
      )
    },

    forInvestigation(investigationId: string): { id: number; provider: string; model: string | null; outcome: string | null; started_at: number; ended_at: number | null }[] {
      return db.prepare('SELECT id, provider, model, outcome, started_at, ended_at FROM sessions WHERE investigation_id = ? ORDER BY id').all(investigationId) as never
    },
  }
}

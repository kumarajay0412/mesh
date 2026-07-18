import type { Database } from 'better-sqlite3'
import type { SyncSourceState } from '../../../shared/types'

interface Row {
  source: string
  cursor: string | null
  last_run_at: number | null
  status: string
  message: string | null
}

/** Cursor per source — the heart of incremental ingest (Section 7.1). */
export function syncStateRepo(db: Database) {
  return {
    get(source: string): SyncSourceState {
      const r = db.prepare('SELECT * FROM sync_state WHERE source = ?').get(source) as Row | undefined
      return r
        ? { source: r.source, cursor: r.cursor ?? undefined, lastRunAt: r.last_run_at ?? undefined, status: r.status as SyncSourceState['status'], message: r.message ?? undefined }
        : { source, status: 'idle' }
    },

    list(): SyncSourceState[] {
      return (db.prepare('SELECT * FROM sync_state ORDER BY source').all() as Row[]).map((r) => ({
        source: r.source,
        cursor: r.cursor ?? undefined,
        lastRunAt: r.last_run_at ?? undefined,
        status: r.status as SyncSourceState['status'],
        message: r.message ?? undefined,
      }))
    },

    /** Drop a source's row entirely — for sources that no longer exist
     *  (renamed Slack channel, removed integration). Losing the cursor is
     *  safe: re-adding the source re-walks, absorbed by skip-unchanged. */
    remove(source: string): void {
      db.prepare('DELETE FROM sync_state WHERE source = ?').run(source)
    },

    /** Persist the cursor per PAGE, not per run — a crash mid-backfill resumes
     *  where it left off instead of refetching hours of work (plan risk #5).
     *  MONOTONIC: sources may deliver pages newest-first, so a later page can
     *  carry an older max-timestamp — the cursor only ever moves forward.
     *  (ISO timestamps and Slack ts both compare correctly as strings.) */
    setCursor(source: string, cursor: string): void {
      db.prepare(
        `INSERT INTO sync_state (source, cursor, status) VALUES (?, ?, 'running')
         ON CONFLICT(source) DO UPDATE SET
           cursor = CASE WHEN excluded.cursor > coalesce(sync_state.cursor, '') THEN excluded.cursor ELSE sync_state.cursor END`,
      ).run(source, cursor)
    },

    finishRun(source: string, status: 'idle' | 'error' | 'needs-connection', message?: string): void {
      db.prepare(
        `INSERT INTO sync_state (source, last_run_at, status, message) VALUES (?, ?, ?, ?)
         ON CONFLICT(source) DO UPDATE SET last_run_at = excluded.last_run_at, status = excluded.status, message = excluded.message`,
      ).run(source, Date.now(), status, message ?? null)
    },

    markRunning(source: string): void {
      db.prepare(
        `INSERT INTO sync_state (source, status) VALUES (?, 'running')
         ON CONFLICT(source) DO UPDATE SET status = 'running', message = NULL`,
      ).run(source)
    },

    /** Crash recovery, called once at boot: a killed process leaves 'running'
     *  rows behind, and the scheduler skips running sources — without this
     *  reset a crashed sync would never run again. The true mutual exclusion
     *  is the in-process single-flight map, not this column. */
    resetStale(): void {
      db.prepare(`UPDATE sync_state SET status = 'idle', message = 'interrupted — resuming from cursor' WHERE status = 'running'`).run()
    },
  }
}

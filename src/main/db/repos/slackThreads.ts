import type { Database } from 'better-sqlite3'

/** Per-thread reply-count tracker (migration v7). Lets the Slack walk re-fetch
 *  replies (and re-distill) only when a thread has actually gained replies —
 *  the head timestamp never changes, so it can't be the freshness signal. */
export function slackThreadsRepo(db: Database) {
  return {
    /** True if this thread is new or its reply count changed since last sync —
     *  i.e. worth fetching replies and re-distilling. */
    changed(ts: string, replyCount: number): boolean {
      const r = db.prepare('SELECT reply_count FROM slack_threads WHERE ts = ?').get(ts) as { reply_count: number } | undefined
      return r === undefined || r.reply_count !== replyCount
    },

    /** Record the reply count we just ingested, so the next walk can skip it. */
    record(ts: string, replyCount: number): void {
      db.prepare(
        `INSERT INTO slack_threads (ts, reply_count, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(ts) DO UPDATE SET reply_count = excluded.reply_count, updated_at = excluded.updated_at`,
      ).run(ts, replyCount, Date.now())
    },
  }
}

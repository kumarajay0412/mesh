import type { Database } from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

/** PRAGMA user_version runner: applies every migration past the stored version,
 *  each inside a transaction. Idempotent across launches. */
export function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v])
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}

import Database from 'better-sqlite3'
import { migrate } from './migrate'
import { log } from '../log'

const l = log('db')

export const EMBEDDING_DIMS = 384

export interface Db {
  handle: Database.Database
  /** false → sqlite-vec failed to load; memory search degrades to FTS-only */
  vecAvailable: boolean
}

/**
 * Opens (or creates) the database, applies PRAGMAs + migrations, and
 * feature-detects sqlite-vec. Never throws on vec failure — degraded search
 * beats a dead app (plan risk #2).
 *
 * Packaging note (later phase): sqlite-vec's dylib cannot dlopen from inside
 * asar — asarUnpack the sqlite-vec platform package and re-sign, or add the
 * disable-library-validation entitlement.
 */
export function openDb(dbPath: string): Db {
  const handle = new Database(dbPath)
  handle.pragma('journal_mode = WAL')
  handle.pragma('foreign_keys = ON')
  handle.pragma('synchronous = NORMAL')

  migrate(handle)

  let vecAvailable = false
  try {
    // Dynamic require keeps a broken/missing extension from crashing startup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const require_ = createRequire()
    const sqliteVec = require_('sqlite-vec') as { load: (db: Database.Database) => void }
    sqliteVec.load(handle)
    handle.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(memory_rowid integer primary key, embedding float[${EMBEDDING_DIMS}])`,
    )
    handle.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS learnings_vec USING vec0(learning_id integer primary key, embedding float[${EMBEDDING_DIMS}])`,
    )
    const v = handle.prepare('SELECT vec_version() v').get() as { v: string }
    vecAvailable = true
    l.info(`sqlite-vec loaded (${v.v}) — hybrid search enabled`)
  } catch (e) {
    l.warn('sqlite-vec unavailable — memory search degrades to FTS-only:', (e as Error).message)
  }

  return { handle, vecAvailable }
}

// ESM-safe require for the CJS sqlite-vec loader.
import { createRequire as nodeCreateRequire } from 'node:module'
function createRequire() {
  return nodeCreateRequire(import.meta.url)
}

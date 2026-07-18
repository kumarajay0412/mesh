// Test DB opener: vitest runs under plain Node while the default
// better_sqlite3.node is built for Electron's ABI — so tests load the
// Node-ABI copy stashed by scripts/rebuild-native.mjs.
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { migrate } from '../db/migrate'

const require = createRequire(import.meta.url)
const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const nodeBinding = join(pkgDir, 'build', 'Release', 'node', 'better_sqlite3.node')

export function openTestDb(): Database.Database {
  const db = existsSync(nodeBinding) ? new Database(':memory:', { nativeBinding: nodeBinding }) : new Database(':memory:')
  migrate(db)
  return db
}

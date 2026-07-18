// Shared DB access for bench scripts — runs under plain Node, so it loads the
// Node-ABI better-sqlite3 stash (scripts/rebuild-native.mjs maintains it).
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

const require = createRequire(import.meta.url)
const pkgDir = dirname(require.resolve('better-sqlite3/package.json'))
const nodeBinding = join(pkgDir, 'build', 'Release', 'node', 'better_sqlite3.node')

export const DB_PATH = join(homedir(), 'Library', 'Application Support', 'mesh-ai', 'mesh.db')
export const BENCH_DIR = join(process.cwd(), 'scripts', 'bench')
export const RESULTS_DIR = join(BENCH_DIR, 'results')

export function openDb(readonly = false) {
  const opts = { readonly }
  if (existsSync(nodeBinding)) opts.nativeBinding = nodeBinding
  return new Database(DB_PATH, opts)
}

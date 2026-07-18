// The leakage guard: hide a ticket's memory row (it contains the answer)
// before a trial; restore after. Siblings stay — they ARE the product.
//
//   node scripts/bench/guard.mjs hide ENG-2903
//   node scripts/bench/guard.mjs restore ENG-2903
//   node scripts/bench/guard.mjs status
import { openDb } from './db.mjs'

const [cmd, identifier] = process.argv.slice(2)
const db = openDb()

db.exec(`CREATE TABLE IF NOT EXISTS bench_hidden AS SELECT * FROM memory WHERE 0`)

if (cmd === 'hide') {
  const row = db.prepare('SELECT rowid, * FROM memory WHERE upper(identifier) = upper(?)').get(identifier)
  if (!row) {
    console.error(`no memory row for ${identifier} (already hidden?)`)
    process.exit(1)
  }
  const { rowid, ...cols } = row
  const names = Object.keys(cols)
  db.transaction(() => {
    db.prepare(`INSERT INTO bench_hidden (${names.join(',')}) VALUES (${names.map((n) => `@${n}`).join(',')})`).run(cols)
    try {
      db.prepare('DELETE FROM memory_vec WHERE memory_rowid = ?').run(rowid)
    } catch {
      /* vec module not loadable under plain node — the app rebuilds vectors */
    }
    db.prepare('DELETE FROM memory WHERE rowid = ?').run(rowid) // FTS triggers clean up
  })()
  console.log(`hidden: ${identifier} (memory + index rows). RESTORE AFTER THE TRIAL.`)
} else if (cmd === 'restore') {
  const row = db.prepare('SELECT * FROM bench_hidden WHERE upper(identifier) = upper(?)').get(identifier)
  if (!row) {
    console.error(`nothing hidden for ${identifier}`)
    process.exit(1)
  }
  const names = Object.keys(row)
  db.transaction(() => {
    db.prepare(`INSERT INTO memory (${names.join(',')}) VALUES (${names.map((n) => `@${n}`).join(',')})`).run({ ...row, embedded: 0 })
    db.prepare('DELETE FROM bench_hidden WHERE upper(identifier) = upper(?)').run(identifier)
  })()
  console.log(`restored: ${identifier} (embedded=0 — the app re-vectorizes on next drain)`)
} else if (cmd === 'status') {
  const rows = db.prepare('SELECT identifier, title FROM bench_hidden').all()
  console.log(rows.length ? rows.map((r) => `hidden: ${r.identifier}  ${r.title}`).join('\n') : 'nothing hidden')
} else {
  console.log('usage: guard.mjs hide|restore|status [IDENTIFIER]')
}

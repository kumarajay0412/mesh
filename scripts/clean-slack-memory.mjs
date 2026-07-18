// One-off cleanup of already-ingested Slack memory rows (mirrors
// src/main/sync/slack-clean.ts, which now cleans at ingest time):
//   1. DELETE bot noise (Slackbot reminders, join/leave, empty standalone)
//      + their vectors; FTS rows follow via triggers.
//   2. Strip Slack API markup from title/symptoms/root_cause/resolution/
//      investigation_summary on the rest; changed rows get embedded=0 so the
//      worker re-embeds them with clean text. updated_at is NOT touched —
//      the sync skip-unchanged contract depends on it.
// Plain Node (bench Node-ABI binding). Safe to re-run; second run is a no-op.
import { openDb } from './bench/db.mjs'
import { load } from 'sqlite-vec'

// — mirrored from src/main/sync/slack-clean.ts —
function stripSlackMarkup(text) {
  return text
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+>/g, '@user')
    .replace(/<!subteam\^[A-Z0-9]+\|@?([^>]+)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+>/g, '@team')
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<#[A-Z0-9]+>/g, '#channel')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/<mailto:([^|>]+)(\|[^>]*)?>/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}
function isNoiseRow(title, symptoms, rawCommentsJson) {
  const t = (title ?? '').trim()
  let replies = 0
  try {
    replies = (JSON.parse(rawCommentsJson ?? '{}').threadReplies ?? []).length
  } catch {}
  if (t === '' && (symptoms ?? '').trim() === '' && replies === 0) return true
  if (/^Reminder:/i.test(t)) return true
  if (/^<?@?[^\s>]*>?\s*has (joined|left) the channel$/i.test(t)) return true
  return false
}

const db = openDb()
db.pragma('busy_timeout = 10000')
load(db)

const rows = db.prepare(`SELECT rowid, id, title, symptoms, root_cause, resolution, investigation_summary, raw_comments_json FROM memory WHERE source = 'slack'`).all()
console.log(`slack rows: ${rows.length}`)

const delMem = db.prepare('DELETE FROM memory WHERE rowid = ?')
const delVec = db.prepare('DELETE FROM memory_vec WHERE memory_rowid = ?')
const update = db.prepare(
  `UPDATE memory SET title = ?, symptoms = ?, root_cause = ?, resolution = ?, investigation_summary = ?, embedded = 0 WHERE rowid = ?`,
)

let deleted = 0
let cleaned = 0
let untouched = 0

const run = db.transaction(() => {
  for (const r of rows) {
    if (isNoiseRow(r.title, r.symptoms, r.raw_comments_json)) {
      delVec.run(BigInt(r.rowid))
      delMem.run(r.rowid) // FTS row removed by the AFTER DELETE trigger
      deleted++
      continue
    }
    const next = {
      title: stripSlackMarkup(r.title ?? ''),
      symptoms: stripSlackMarkup(r.symptoms ?? ''),
      root_cause: r.root_cause == null ? null : stripSlackMarkup(r.root_cause),
      resolution: r.resolution == null ? null : stripSlackMarkup(r.resolution),
      investigation_summary: r.investigation_summary == null ? null : stripSlackMarkup(r.investigation_summary),
    }
    const changed =
      next.title !== r.title ||
      next.symptoms !== r.symptoms ||
      next.root_cause !== r.root_cause ||
      next.resolution !== r.resolution ||
      next.investigation_summary !== r.investigation_summary
    if (changed) {
      update.run(next.title, next.symptoms, next.root_cause, next.resolution, next.investigation_summary, r.rowid)
      cleaned++
    } else {
      untouched++
    }
  }
})
run()

console.log(`deleted (noise): ${deleted}`)
console.log(`cleaned (markup stripped, queued for re-embed): ${cleaned}`)
console.log(`already clean: ${untouched}`)
const pend = db.prepare(`SELECT COUNT(*) c FROM memory WHERE embedded = 0`).get()
console.log(`embedding queue now: ${pend.c} (drains while the app runs)`)

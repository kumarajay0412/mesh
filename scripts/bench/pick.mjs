// Pick benchmark tickets: resolved incidents with a KNOWN root cause
// (the gold label). Emits scripts/bench/tickets.json.
//
//   node scripts/bench/pick.mjs [count=15]
//
// IMPORTANT: the input each arm receives is title+symptoms ONLY — the
// distilled resolution/root_cause (and raw comment threads, which contain
// the answer) never enter any prompt. They are the grading key.
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, BENCH_DIR } from './db.mjs'

const count = Number(process.argv[2] ?? 15)
const db = openDb(true)

const rows = db
  .prepare(
    `SELECT identifier, title, symptoms, root_cause, resolution,
            datetime(resolved_at/1000,'unixepoch') AS resolved
     FROM memory
     WHERE source = 'linear'
       AND identifier IS NOT NULL
       AND root_cause IS NOT NULL AND length(root_cause) > 40
       AND resolution IS NOT NULL AND length(resolution) > 20
       AND length(symptoms) > 60
     ORDER BY resolved_at DESC
     LIMIT ?`,
  )
  .all(count * 3)

// diversity: max 2 per team prefix, newest first
const byTeam = new Map()
const picked = []
for (const r of rows) {
  const team = r.identifier.split('-')[0]
  const n = byTeam.get(team) ?? 0
  if (n >= 2) continue
  byTeam.set(team, n + 1)
  picked.push(r)
  if (picked.length >= count) break
}

mkdirSync(BENCH_DIR, { recursive: true })
writeFileSync(
  join(BENCH_DIR, 'tickets.json'),
  JSON.stringify(
    picked.map((r) => ({
      identifier: r.identifier,
      title: r.title,
      // ARM INPUT (safe): what a reporter knew at incident time
      input: `Ticket ${r.identifier}: ${r.title}\n\nSymptoms: ${r.symptoms}`,
      // GRADING KEY (never prompt material)
      gold: { rootCause: r.root_cause, resolution: r.resolution, resolved: r.resolved },
    })),
    null,
    2,
  ),
)

console.log(`picked ${picked.length} tickets → scripts/bench/tickets.json`)
for (const r of picked) console.log(`  ${r.identifier}  ${r.title.slice(0, 70)}`)

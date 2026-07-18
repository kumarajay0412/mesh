// Build the scorecard from results/: objective columns filled, judgment
// columns left blank for BLIND human grading (system labels are in the
// key file, not the grading sheet).
//
//   node scripts/bench/score.mjs
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { BENCH_DIR, RESULTS_DIR } from './db.mjs'

const tickets = JSON.parse(readFileSync(join(BENCH_DIR, 'tickets.json'), 'utf8'))
const files = existsSync(RESULTS_DIR) ? readdirSync(RESULTS_DIR).filter((f) => f.endsWith('.json')) : []
const results = files.map((f) => JSON.parse(readFileSync(join(RESULTS_DIR, f), 'utf8')))

const ARMS = ['A', 'B0', 'B1']
let grading = `# Bench grading sheet (BLIND — do not open key.md while grading)\n\n`
let key = `# Key: which output is which system\n\n`
let summary = `# Bench summary (objective columns)\n\n| ticket | arm | min | tool calls/turns | culprit emitted | evidence |\n|---|---|---|---|---|---|\n`

let blindIdx = 0
for (const t of tickets) {
  const armResults = ARMS.map((a) => results.find((r) => r.identifier === t.identifier && r.arm === a)).filter(Boolean)
  if (armResults.length === 0) continue

  grading += `\n---\n## ${t.identifier} — ${t.title}\n\n**GOLD root cause:** ${t.gold.rootCause}\n\n**GOLD resolution:** ${t.gold.resolution}\n`
  const shuffled = [...armResults].sort(() => Math.random() - 0.5)
  for (const r of shuffled) {
    const label = `Output ${String.fromCharCode(88 + (blindIdx % 3))}${Math.floor(blindIdx / 3) + 1}` // X1,Y1,Z1,X2…
    blindIdx++
    key += `- ${t.identifier} · ${label} = arm ${r.arm}\n`
    grading += `\n### ${label}\n- culprit: \`${r.culprit ?? '(none)'}\`\n- root cause: ${r.rootCause ?? '(none)'}\n`
    grading += `- **GRADE root-cause correct? [ ] 0  [ ] 0.5  [ ] 1**\n- **GRADE culprit tier? [ ] none [ ] repo [ ] file [ ] commit**\n`
  }

  for (const r of armResults) {
    summary += `| ${t.identifier} | ${r.arm} | ${r.wallMin ?? ''} | ${r.toolCalls ?? r.numTurns ?? ''} | ${r.culprit ? 'yes' : 'no'} | ${r.evidenceCount ?? '—'} |\n`
  }
}

writeFileSync(join(BENCH_DIR, 'grading.md'), grading)
writeFileSync(join(BENCH_DIR, 'key.md'), key)
writeFileSync(join(BENCH_DIR, 'summary.md'), summary)
console.log(`wrote grading.md (blind), key.md (labels), summary.md (objective)\n${results.length} results across ${new Set(results.map((r) => r.identifier)).size} tickets`)

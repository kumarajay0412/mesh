// Collect the Mesh arm (arm A) for a trial: after you run the investigation
// in the app, this pulls the report + timings from the sessions/events ledger.
//
//   node scripts/bench/collect-mesh.mjs ENG-2903 INV-009
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb, BENCH_DIR, RESULTS_DIR } from './db.mjs'

const [identifier, invId] = process.argv.slice(2)
if (!identifier || !invId) {
  console.error('usage: collect-mesh.mjs <TICKET-ID> <INV-ID>')
  process.exit(1)
}

const tickets = JSON.parse(readFileSync(join(BENCH_DIR, 'tickets.json'), 'utf8'))
const t = tickets.find((x) => x.identifier.toUpperCase() === identifier.toUpperCase())
if (!t) {
  console.error(`ticket ${identifier} not in tickets.json`)
  process.exit(1)
}

const db = openDb(true)
const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get(invId)
if (!inv?.report_json) {
  console.error(`${invId} has no report yet`)
  process.exit(1)
}
const report = JSON.parse(inv.report_json)

const sessions = db
  .prepare(
    `SELECT id, started_at, ended_at, model, permission_mode, outcome,
            input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_usd, num_turns
     FROM sessions WHERE investigation_id = ? ORDER BY id`,
  )
  .all(invId)
const wallMs = sessions.reduce((acc, s) => acc + ((s.ended_at ?? Date.now()) - s.started_at), 0)
// Usage lands via migration v6 — null for sessions that predate it.
const sumTok = (k) => sessions.reduce((acc, s) => acc + (s[k] ?? 0), 0)
const costUsd = sessions.some((s) => s.cost_usd != null) ? +sessions.reduce((acc, s) => acc + (s.cost_usd ?? 0), 0).toFixed(4) : null
const toolCalls = db
  .prepare(`SELECT count(*) c FROM events WHERE investigation_id = ? AND type = 'agent.tool_call'`)
  .get(invId).c
const evidenceCount = Array.isArray(report.evidence) ? report.evidence.length : 0

mkdirSync(RESULTS_DIR, { recursive: true })
const out = {
  identifier: t.identifier,
  arm: 'A',
  investigationId: invId,
  wallMs,
  wallMin: +(wallMs / 60000).toFixed(1),
  toolCalls,
  sessions: sessions.length,
  model: sessions[0]?.model ?? 'default',
  costUsd,
  tokens: { input: sumTok('input_tokens'), cacheWrite: sumTok('cache_write_tokens'), cacheRead: sumTok('cache_read_tokens'), output: sumTok('output_tokens'), turns: sumTok('num_turns') },
  culprit: report.culprit ? `repo=${report.culprit.repo} file=${report.culprit.path} commit=${report.culprit.sha}` : null,
  rootCause: report.hypothesis?.slice(0, 800) ?? null,
  confidence: report.confidence,
  evidenceCount,
  suspects: (report.suspects ?? []).map((s) => `${s.sha?.slice(0, 7)} ${s.title}`).slice(0, 5),
}
writeFileSync(join(RESULTS_DIR, `${t.identifier}.A.json`), JSON.stringify(out, null, 2))
console.log(`collected ${invId} → results/${t.identifier}.A.json`)
console.log(`  ${out.wallMin} min · ${toolCalls} tool calls · ${evidenceCount} evidence · CULPRIT: ${out.culprit ?? '(none)'}`)
console.log(`\nREMINDER: node scripts/bench/guard.mjs restore ${t.identifier}`)

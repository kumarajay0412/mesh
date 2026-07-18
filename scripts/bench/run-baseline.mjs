// Baseline arms: plain Claude Code on the same ticket text, same repos.
//   B0 — bare prompt
//   B1 — bare prompt + Mesh's runbook pasted (isolates prompt vs context)
//
//   node scripts/bench/run-baseline.mjs ENG-2903 [b0|b1]
//
// Runs `claude -p --output-format json` with cwd = the repo folder. Read-only
// by intent; permissions bypassed so the run is headless (your own machine,
// your own repos — same trust level as a terminal claude session).
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { BENCH_DIR, RESULTS_DIR } from './db.mjs'

const REPO_ROOT = join(homedir(), 'Documents', 'GitHub')
const [identifier, arm = 'b0'] = process.argv.slice(2)

const tickets = JSON.parse(readFileSync(join(BENCH_DIR, 'tickets.json'), 'utf8'))
const t = tickets.find((x) => x.identifier.toUpperCase() === identifier?.toUpperCase())
if (!t) {
  console.error(`ticket ${identifier} not in tickets.json — run pick.mjs first`)
  process.exit(1)
}

const RUNBOOK = `Follow this method strictly, in order:
1. Establish the symptom-onset window; anchor queries to it.
2. Note deploy timing only — do not read code yet.
3. Triage signals broad→narrow before hypothesizing.
4. Follow the strongest signal to the failing code path.
5. Only then open repos: git log/blame the implicated paths; name the commit.
6. Verify with a second independent signal; try to refute your own candidate.
7. Every claim must carry a source (query, command output, or SHA).
8. If no signal after two passes, say "no root cause found" honestly.`

const prompt = [
  'You are investigating a production incident for adalat-ai. All org repos are',
  `checked out as subdirectories of the current directory. Investigate using`,
  `read-only means (git log/show/blame, rg, reading files).`,
  arm === 'b1' ? `\n${RUNBOOK}\n` : '',
  `\n${t.input}\n`,
  'End your answer with EXACTLY these two lines:',
  'CULPRIT: repo=<name> file=<path or unknown> commit=<sha or unknown>',
  'ROOT CAUSE: <one concise paragraph>',
].join('\n')

mkdirSync(RESULTS_DIR, { recursive: true })
const started = Date.now()
console.log(`[${identifier} · ${arm.toUpperCase()}] running claude -p … (this can take minutes)`)

execFile(
  'claude',
  ['-p', prompt, '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--max-turns', '60'],
  { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60_000 },
  (err, stdout, stderr) => {
    const wallMs = Date.now() - started
    let parsed = null
    try {
      parsed = JSON.parse(stdout)
    } catch {
      /* keep raw */
    }
    const text = parsed?.result ?? stdout
    const culprit = /CULPRIT:\s*(.+)/i.exec(text)?.[1]?.trim() ?? null
    const rootCause = /ROOT CAUSE:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().slice(0, 800) ?? null

    const out = {
      identifier: t.identifier,
      arm: arm.toUpperCase(),
      wallMs,
      wallMin: +(wallMs / 60000).toFixed(1),
      numTurns: parsed?.num_turns ?? null,
      costUsd: parsed?.total_cost_usd ?? parsed?.cost_usd ?? null,
      culprit,
      rootCause,
      error: err ? String(err).slice(0, 300) : null,
      stderrTail: stderr?.slice(-300) || null,
      resultText: String(text).slice(0, 6000),
    }
    writeFileSync(join(RESULTS_DIR, `${t.identifier}.${arm.toUpperCase()}.json`), JSON.stringify(out, null, 2))
    console.log(`done in ${out.wallMin} min → results/${t.identifier}.${arm.toUpperCase()}.json`)
    console.log(`  CULPRIT: ${culprit ?? '(none emitted)'}`)
  },
)

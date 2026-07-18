# Bench: Mesh vs plain Claude Code

Paired trials on your own resolved incidents. Same model, same repos, same
ticket text — the variable is Mesh's context machinery. Gold labels come from
the tickets' real resolutions; they are used ONLY for grading, never in any
prompt.

## Per-trial flow (one ticket)

```bash
# 0 · once: pick the ticket set (writes tickets.json)
node scripts/bench/pick.mjs 15

# 1 · hide the answer from Mesh's memory (leakage guard)
node scripts/bench/guard.mjs hide ENG-2903

# 2 · baselines (each takes minutes; run both arms)
node scripts/bench/run-baseline.mjs ENG-2903 b0   # bare Claude Code
node scripts/bench/run-baseline.mjs ENG-2903 b1   # + runbook prompt (no org context)

# 3 · Mesh arm: open the app → New investigation → paste EXACTLY the
#     "input" field from tickets.json for this ticket → run to report.
#     Then collect from the ledger:
node scripts/bench/collect-mesh.mjs ENG-2903 INV-009

# 4 · restore memory (always!)
node scripts/bench/guard.mjs restore ENG-2903

# 5 · after all tickets: build the scorecard
node scripts/bench/score.mjs
```

Outputs in `scripts/bench/`:
- `summary.md` — objective table (time, tool calls, culprit emitted, evidence count)
- `grading.md` — BLIND sheet: shuffled outputs vs gold, grade each 0/0.5/1 and
  culprit tier (none/repo/file/commit) without knowing which system it is
- `key.md` — open only after grading; maps blind labels → arms

## Fair-play rules baked in

- Both arms receive identical input: title + distilled symptoms (what a
  reporter knew). Raw comment threads and resolutions never enter prompts.
- The target incident is hidden from memory during the Mesh run; sibling
  incidents remain — that history IS the product being measured.
- Same model/effort in both arms (set Mesh's Settings → Model/Effort to match
  your CLI default, or vice versa).
- Keep permission mode = Approve in Mesh but expect no writes (read-only
  investigation); baselines bypass permissions to run headless.
- Grade blind; report per-ticket wins/losses. At N≈15 a sign test is the most
  honesty the sample supports.

## Caveats to report alongside results

- Near-duplicate siblings of a hidden ticket may remain in memory (only the
  exact ticket is hidden). If a sibling is a re-occurrence of the same
  incident, note it — that trial measures recall, not generalization.
- Repos are checked out at TODAY'S HEAD, not the incident-time commit; both
  arms share this handicap equally, but very old tickets may be unfair to both.
- Mesh cost isn't captured per-run yet (sessions ledger has time/steps; token
  usage capture is a TODO) — compare time and outcome quality first.

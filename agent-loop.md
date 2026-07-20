# How the Mesh agent works — the agentic loop

Mesh is not a chatbot with a search box. Each investigation is a long-running **agent session**: a Claude Code instance spawned inside your repos folder with an SRE runbook, org context assembled from memory, and a permission gate on every mutating action. This doc walks the full loop, grounded in the actual code.

```
you                    Mesh (Electron main process)                agent (Claude Code session)
 │                          │                                          │
 │  ticket / symptom        │                                          │
 ├─────────────────────────▶│ 1 INTAKE   extract symptoms (one-shot)   │
 │                          │            match vs memory (vector+FTS)  │
 │                          │ 2 SCOPE    resolve service mentions      │
 │                          │ 3 ASSEMBLE runbook + learnings +         │
 │                          │            similar incidents + map +     │
 │                          │            repos list + ticket content   │
 │                          ├─────────────────────────────────────────▶│ session starts (read-only)
 │                          │                                          │ ┌──────────────────────┐
 │                          │   streamed events (timeline)             │ │ think → ONE tool call │
 │◀─────────────────────────┤◀─────────────────────────────────────────┤ │ → read result → think │
 │                          │                                          │ └──────────┬───────────┘
 │  steer mid-flight        │                                          │            │ repeat
 ├─────────────────────────▶├─────────────────────────────────────────▶│            │
 │                          │                                          │            │
 │  approve / deny ◀────────┤◀──── mutating tool? blocks on the gate ──┤            │
 │                          │                                          │            ▼
 │                          │◀───── ```mesh-report block (validated) ──┤ session ends
 │                          │ 4 REPORT   save to memory · propose      │
 │◀─────────────────────────┤            learnings + map edges         │
 │                          │                                          │
 │  feedback comment        │                                          │
 ├─────────────────────────▶├── resumes the SAME session ─────────────▶│ may emit a REVISED report
 │  approve learnings/edges │                                          │
 ├─────────────────────────▶│ approved items ride in every FUTURE prompt
```

---

## Stage 1 — Intake (`src/main/engine/intake.ts`)

Input is a Linear ticket reference, a pasted alert, or free text. Two things happen before any agent exists:

1. **Field extraction** — a one-shot LLM call pulls out `{title, symptoms, serviceMentions, timeWindow}`. It runs on Haiku at low effort with `tools: []` — zod-validated JSON extraction is Haiku work, and `tools: []` (unlike `allowedTools: []`, which only gates permissions) stops shipping a ~10–15K-token tool schema the call could never use. The ingest-side distill pass uses the same cheap path. If the call fails, honest heuristics take over (first line as title, kebab-case tokens as service mentions, a time-phrase regex) — intake never blocks an investigation.
2. **Ticket hydration** — if the reference matches an ingested ticket (`ENG-1234`), its distilled record is pulled from memory by identifier. The agent must **never** fetch linear.app (auth-walled SPA); the full ticket content travels in the prompt instead.

Then memory is searched for **similar past incidents** (`src/main/memory/search.ts`): error-signature exact match → FTS5 keyword search (BM25, title weighted 10×) → vector KNN over local embeddings → rank fusion. The top 3 hits become priors in the prompt.

Memory spans three sources, all in one `memory` table with identical columns — search never knows or cares which is which: **Linear** tickets (+ comment threads), **Slack** threads (one sync source per channel, so the RCA/postmortem channels come in alongside the reporting ones), and **Mesh**'s own finished investigations.

## Stage 2 — Scope

Service mentions are resolved against the service registry (`services.resolveMention`). Whatever resolves becomes the candidate-service list; the first one is pinned to the investigation row. This stage is deliberately v1-lite — the agent re-scopes itself during the run when the evidence points elsewhere.

## Stage 3 — Context assembly (`src/main/engine/runbook.ts` → `buildSystemPrompt`)

The system prompt is assembled fresh per investigation, in this order:

| Block | Source | Why it's there |
|---|---|---|
| **Runbook** | versioned constant (`RUNBOOK_VERSION = 1`) | the 8-step investigation method (below) + evidence discipline + report schema |
| **Learned context** | user-approved learnings, relevance-selected | ≤15 learnings inject whole; above that, top-12 by embedding similarity + a newest-5 floor. Each line caps at 200 chars — these ride in *every* prompt |
| **Service registry** | candidate services | name → repo → how to find it in Grafana/k8s, plus known solutions |
| **Similar past incidents** | memory search (any source) | symptoms, root cause, and the fix that worked — flagged "strong priors, verify before trusting". Fields clip at ~250 chars with a pointer to `get_incident <id>`: depth is one tool call away, not pre-paid on every turn |
| **System map** | Knowledge Map, accepted edges only | the org topology (who calls whom, over what) so the agent starts knowing the flows |
| **Repos available** | live scan of the repo root | the ~182 local checkouts it may `git log/blame/show` and `rg` through |
| **Pre-collected brief** | `src/main/engine/precollect.ts`, best-effort | runbook steps 1–3 run *as code* before the session: the onset window normalized to epoch, Grafana deploy annotations in that window, and Loki error-rate deltas (in-window vs the same window 24h earlier) per candidate service. The agent audits it and starts at step 4 instead of doing the epoch math and annotation lookups by hand — the deterministic-precollect move. Absent Grafana or on any failed query it degrades to a note and the agent does that part itself |
| **The ticket under investigation** | ingested memory record | full title/symptoms/labels + a head-and-tail-bounded slice of the comment thread (6 KB budget — resolution talk lives at the end) |
| **Sentry note** | only when a token is connected | tells the agent live Sentry MCP tools exist |

The prompt is split at `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`: the invariant prefix (runbook + system map + repos list) is prompt-cached cross-session; everything per-investigation (learnings, registry, similar incidents, the pre-collected brief, the ticket) is the dynamic suffix. The initial user turn is short — symptoms, onset window, ticket ref, and "end with the ` ```mesh-report ` block."

## The agentic loop itself (`src/main/providers/claude.ts`)

Mesh embeds the **Claude Agent SDK** and runs `query()` in *streaming-input mode*: the prompt argument is an async iterable (`UserTurnQueue`) rather than a string, which is what makes mid-flight steering possible.

The loop, as the SDK runs it:

1. The model receives the system prompt + user turn and **thinks**, then either writes text or requests a **tool call** (Bash, Read, Grep, Glob, WebFetch, Sentry MCP tools, and the in-process memory tools below).
2. Every tool call passes through **`canUseTool`** — Mesh's permission gate (next section). Allowed calls execute inside `cwd` = your repos folder; the result is fed back to the model as the next message.
3. The model reads the results and decides the next step. The runbook keeps the **method steps strictly sequential**, but within a step it batches independent read-only lookups (2–4 parallel calls — triage fan-out, parallel git log/read/grep); hypothesis testing and mutations stay one-at-a-time. Oversized tool results (>20KB) are head+tail-capped by a PostToolUse hook before they enter the transcript — the runbook's OUTPUT DISCIPLINE tells the agent to re-query narrower.
4. This repeats until the model writes its final text ending in the fenced `mesh-report` JSON block — bounded by a 60-turn ceiling (hitting it is user-visible; the session is resumable via feedback).
5. The SDK emits a `result` message. Mesh **closes the turn queue** on it — in streaming-input mode the session would otherwise wait for more user turns forever. This close-on-result is what lets `finalize()` run.

Every SDK message is defensively mapped (`mapMessage`) into a typed `AgentEvent` — `reasoning`, `tool_call`, `tool_result`, `status`, `error`, `done` — each one **persisted to the `events` table** (tagged with the sessions-ledger row) and streamed to the renderer timeline over IPC. Kill the app mid-run; the transcript survives.

**Mid-session memory access** (`src/main/engine/memory-tools.ts`): the session carries two in-process MCP tools backed by the same SQLite file —

- `mcp__memory__search_memory {query}` — the full hybrid search (signature → BM25 → vector KNN → fusion), callable *during* the run. The intake similar-incidents block was matched against the opening symptoms only; once the agent extracts a sharper signature, stack frame, or service name, it re-queries. The runbook tells it to do this before deep code archaeology. The ticket under investigation is filtered out of its own results.
- `mcp__memory__get_incident {id}` — one record in full, by whichever id memory uses: a ticket identifier (`ENG-3443`), or a raw memory id exactly as search returned it (`slack:<ts>`, `mesh:INV-016`). Returns the distilled record plus a bounded slice of its discussion thread. (Before this accepted raw ids, the agent could surface a Slack hit and then be unable to open it.)

Both are read-only by construction, auto-allowed by the gate, and appear on the timeline as ordinary tool calls — so memory lookups are now *visible* in the transcript, not just implicit in the prompt.

**Steering:** anything you type into the running investigation is pushed onto the same `UserTurnQueue` and becomes the next user turn — the agent course-corrects without losing state. **Interrupt** aborts the controller and closes the queue.

## The permission gate (`canUseTool` + `src/main/ipc/approvals.ts`)

Order of checks on every tool call:

1. **linear.app / slack.com fetches → hard deny**, with a message pointing the agent at the injected ticket content.
2. **Read-only tools → auto-allow** (Read/Grep/Glob/WebFetch/Task/…, the in-process `mcp__memory__*` tools — the whole prefix trusted, read-only by construction — plus `Bash` commands that pass a deny-by-default read-only regex: `git log` yes, `git push` never, smuggling like `$(...)` or `;` rejected).

   **A wrinkle worth knowing:** the SDK's `mcpServers` option is *additive*, not exclusive — Mesh sets neither `strictMcpConfig` nor `settingSources`, so every session also inherits whatever MCP servers exist in your own Claude Code environment (project `.mcp.json`, user settings, claude.ai cloud connectors). If you have a Slack connector configured personally, its tools ride along uninvited — this is *not* something Mesh wires (`engine.ts` only ever sets `memory` and `sentry`). Because that connector can both read (`slack_search_public`, `slack_read_thread`, …) and write (`slack_send_message`, `slack_schedule_message`, `slack_create_canvas`, …), inherited tools are matched by **exact tool-name suffix**, not by prefix: `src/main/providers/readonly.ts`'s `EXTERNAL_READ_ONLY_TOOL_NAMES` allowlists the eight known-safe Slack read/search tool names — the write-shaped ones from that same connector always stay behind the approval broker, in every mode. The server segment of `mcp__<server>__<tool>` is unstable (a UUID in one environment, a human-readable name like `claude_ai_Slack` in another), so matching is done on the tool name alone, after the last `__`.
3. External MCP servers Mesh doesn't recognize (Sentry included, despite being deliberately wired) are **not** prefix-allowed; they stay mode-gated.
4. **Everything else is mode-aware**, mirroring Claude Code's modes:
   - `default` — blocks on the approval broker: a modal in the UI with tool name + args preview. **10-minute timeout = deny. Window close/app quit = deny-all** (a dangling promise would wedge the SDK). Every request and decision is appended to `events`.
   - `acceptEdits` — file edits auto-allowed, other writes still gated.
   - `plan` — all mutations quietly refused ("describe the change instead").
   - `auto` / `bypassPermissions` — you opted out of per-action gating.
5. One SDK footgun, encoded in the adapter: on allow you **must** return `updatedInput` — the runtime zod schema requires it even though the type says optional; omitting it fails every permission check.

## Stage 4 — Report (`src/main/engine/engine.ts` → `finalize`)

The `mesh-report` block is treated as plumbing, not conversation:

- The moment a reasoning chunk contains ` ```mesh-report `, the **raw text is persisted** to `events` (`report.raw`, scoped to this session row). The in-memory transcript dies if the session respawns; the events table doesn't.
- When the session finishes, `extractReport` parses and zod-validates the block (with a tolerant preprocessor — agents emit `"ts": null` and ISO strings; both coerce instead of rejecting the whole report).
- **Wedge-retry:** if the session died on the SDK's duplicate-`tool_use`-id glitch before reporting, Mesh restarts it once **fresh** (no resume — the corrupted history *is* the disease), then gives up honestly.

A validated report contains: hypothesis + confidence tier (`suspected/probable/confirmed`), the culprit `repo/sha/path`, ranked suspects with signals, an **evidence chain where every claim carries its source** (query, command + output, or SHA), a symptom-vs-deploy timeline, a suggested fix (description only — never applied), unexplored branches, two proposal lists (below), and the structured root cause:

**`rootCauseDetail` — the version the team reads.** The `hypothesis` is the headline; this is the story, and it renders both in the Report screen (`RootCauseCard`) and in the posted Linear comment:

- `points[]` — the causal chain in order, plain language, `**bold**` numbers and `` `code` `` rendered inline
- `services[]` — one panel per service with a verdict: **culprit** / **contributing** / **affected** / **cleared**. Naming the cleared ones (and why) is what stops the next incident re-litigating them
- `metrics[]` — up to 2 small charts drawn from **numbers the agent actually measured in a cited query** (the runbook forbids sketched curves), rendered as SVG bars with the incident bucket highlighted in coral
- `redHerrings[]` — signals that looked causal and are not, with the reason
- `unknowns[]` — what could not be pinned down, and what was ruled out trying

Every part is optional and independently validated (`.catch(undefined)`): a malformed section drops out rather than sinking the report, and pre-existing reports without it still render the hypothesis alone.

## After the report — the loops that make the next run smarter

- **Memory write-back** — the finished investigation is upserted as a memory record (`mesh:INV-xxx`) with symptoms, root cause, and fix, then embedded. The next incident that looks like this one finds it.
- **Learnings (user-gated)** — the report's `learnings[]` (reusable operational knowledge only: where the logs live, which repo owns what, naming gotchas) land as *proposed*. You accept or dismiss each on the Report screen; only accepted ones ever reach a future prompt.
- **Map updates (user-gated)** — `mapUpdates[]` may only contain edges the agent **verified in code/config during this run** that are missing from the system map it was given. They land as dashed *proposed* edges on the Knowledge Map (unknown node ids get stub nodes); you accept or dismiss. Only accepted edges ride in future prompts.
- **Post to Linear (gated)** — formats the report as a comment signed `🕵️ Investigated by Mesh — internal tool`, shows the approval modal with a preview, and only writes on approve.
- **Fix-session handoff (gated)** — writes `.mesh/FIX-<id>.md` (report + evidence + task list) into the culprit repo and opens *your own* `claude` in Terminal there on a new `fix/` branch. Mesh steps back; it never applies fixes itself.

## The feedback loop (`comment`)

Commenting on a finished report **resumes the actual session** by its native session id — the agent gets your verdict with its full investigation context intact. The contract in the prompt: if the feedback changes the conclusion, re-investigate that point and emit a *REVISED* `mesh-report` (which flows through the same `finalize` path, replacing the report); if not, defend the original in 2–3 sentences citing evidence — no new report block. If no native session survives, the old report is injected as context instead. Feedback on a still-running investigation is just steering.

## The method the agent follows (the runbook, condensed)

1. **Establish the window** — pin symptom onset; anchor every query to it, never "last hour".
2. **Deploy timing only** — note rollouts in the window but do **not** read diffs yet; anchoring on a plausible commit early corrupts every judgment after it.
3. **Triage broad → narrow** — errors → restarts/OOM → memory/CPU → latency; compare against the same window yesterday.
4. **Follow the strongest signal** — logs for the anomalous service; extract the failing path from stack traces.
5. **Only now, the code** — git log/blame the implicated paths; the evidence constrains which commits are even candidates. That is why commits come *last*.
6. **Verify with a second independent signal** — one signal = suspected/probable, two = confirmed; actively try to refute your own candidate.
7. **Evidence discipline** — a claim without a source does not go in the report.
8. **Know when to stop** — two dry triage passes → report "no root cause found" with the evidence of absence. A truthful dead-end beats a confident guess.

## A real run, mapped to the method (INV-016, "forced logout")

73 tool calls — Bash 46 · Sentry 16 · ToolSearch 7 · Slack 3 · Grafana 1. In order:

1. **Window first** (runbook step 1): the ticket embedded a Sentry replay URL → resolve replay → issue → breadcrumbs → replay details → `search_events replay_id:82f3…` → two `python3` epoch conversions. Onset pinned to a 7-second window: four `OperationError`s at 09:44:07/08/10/14 UTC — React Query's initial try + 3 retries.
2. **Deploy timing only** (step 2): loads the Grafana tools via ToolSearch, one `get_annotations` call over the window for deploy markers. No diffs opened yet.
3. **Strongest signal** (step 4): Sentry trace details → events by `trace:1b86…` → span filter, following the failing request. Plus two live Slack searches and a thread read (the user's own Slack connector rides into the session) looking for user reports around onset.
4. **Only now, code** (step 5): `git log` in `adalat-showcase`, then reads along the stack path — `crypto-ops-util.ts` → `key-operations.ts` → `document-editor` → `redirect-to-logout.ts` → `fetcher.ts` → `query-client.ts`.
5. **Attribution** (step 6): `git log --follow -L 170,182` and `git blame -L 174,181` on the implicated lines → commit named with line-level evidence.

Note the tool sources: Bash/Read/ToolSearch are Claude Code built-ins; `mcp__sentry__*` is injected by Mesh (stdio server, your token); `mcp__grafana-v2__*` and the Slack tools came from **the user's own Claude Code MCP config** — the session runs on your login, so your connectors ride along. The memory tools (`mcp__memory__*`) shipped after INV-016 ran; later investigations also show memory lookups here.

## Everything is on the ledger

Each spawn writes a row in `sessions` (provider, model, effort, permission mode, outcome: `report / no-report / abandoned / wedge-retried`); every `AgentEvent` and approval decision lands in `events` tagged with that row. This is what the benchmark harness reads (`scripts/bench/collect-mesh.mjs`) — the audit trail and the evaluation data are the same table.

---

*Code map: engine orchestration `src/main/engine/engine.ts` · runbook + prompt assembly `src/main/engine/runbook.ts` · intake `src/main/engine/intake.ts` · deterministic pre-collect `src/main/engine/precollect.ts` · in-session memory tools `src/main/engine/memory-tools.ts` · SDK adapter + gate `src/main/providers/claude.ts` · read-only policy `src/main/providers/readonly.ts` · approval broker `src/main/ipc/approvals.ts` · report schema `src/main/engine/report-schema.ts` · report → Linear markdown `src/main/engine/report-format.ts` · memory search `src/main/memory/search.ts` · ingestion `src/main/sync/` (`linear.ts` · `slack.ts` + `slack-clean.ts` · `distill.ts`).*

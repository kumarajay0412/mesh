# Mesh — Incident Investigation, Built as an Internal Tool

> Hand Mesh a Linear ticket, a Sentry error, or a symptom in plain words.
> It investigates across your observability, your incident history, and your
> actual repos — and returns an **evidence-linked root cause**, down to the
> commit and line. Every write it ever makes passes through your approval.

```
Linear ticket ──▶ memory: "has this happened before?"   (3,000+ ingested incidents)
              ──▶ registry: which service, which repo
              ──▶ agent session: Grafana · Sentry · kubectl · git blame · rg
              ──▶ report: hypothesis + culprit commit + evidence chain
              ──▶ your feedback + approved learnings ──▶ smarter next time
```

---

## 1 · The Design System — PRESS

**"Four colours, full stop":** Ink · Signal Yellow · White · Card. Everything
else is a tint of these or a strictly-scoped accent.

| Token family | Values | Role |
| --- | --- | --- |
| **Ink** | `#0e0e0e → #3a3a3a` (6 steps) | the dark ground, panels, hairlines |
| **Signal Yellow** | `#f5c518` (+5 steps) | THE accent — brand, live states, primary actions |
| **Card / Paper** | `#f4f4f2`, `#f7f4ee` | panel fill; the light "reading" ground |
| **Neutrals** | `#ececea → #202020` (9 steps) | text & lines |
| **Semantic** | teal = success · gold = warning · coral = danger · sky = info | functional UI only |

- **Typography — two fonts, full stop.** Aptos Display for titles and big
  numbers; Aptos for body; `ui-monospace` for everything technical (SHAs,
  queries, service names, log lines). Eyebrow labels run mono, uppercase,
  `0.18em` tracking.
- **Spacing/radii on a 4px base**; warm-black elevation shadows; motion is
  deferential — 140ms hovers, ~1.4s pulses for "working", no bounces.
- **Dark-first, with a true light mode.** Every surface uses semantic CSS
  variables (`--ada-bg`, `--ada-surface`, `--ada-ink-*`); light mode remaps the
  *ink scale itself* under `[data-ada-theme="light"]`, so the entire app flips
  to the warm-paper variant without touching a component.
- **Evidence-forward layout.** The investigation screen is an instrument
  panel, not a chatbot: live timeline left, an accumulating **evidence rail**
  right — every claim visibly carries its source (query, command output, SHA).
- **The mark:** a woven-X in signal yellow — sidebar brand, macOS dock icon
  (rendered from the SVG by Chromium itself at build/run time), and the
  pulsing "agent is working" indicator.
- **Trust as a visual pattern.** One global approval modal — tool name, exact
  payload preview, "unanswered = denied". Deliberate friction, styled as a
  first-class citizen, never a nag.

## 2 · How It's Built

### Process model

```
┌─ Electron ──────────────────────────────────────────────────┐
│ Renderer (React + Vite)     ← pure UI, backend-agnostic     │
│   └── MeshApi interface: MockApi (browser) / IpcApi (real)  │
│ Preload (CJS, allowlisted)  ← mesh.invoke / mesh.on only    │
│ Main (TypeScript, ESM, esbuild-bundled)                     │
│   ├── SQLite: one file, versioned migrations (v4)           │
│   ├── Sync engine: Linear · Slack · repos (cursors)         │
│   ├── Investigation engine: intake→scope→investigate→report │
│   ├── Providers: Claude Agent SDK · Codex CLI               │
│   ├── Approval broker (timeout-deny, deny-on-close)         │
│   └── utilityProcess: embeddings worker (MiniLM, ONNX)      │
└──────────────────────────────────────────────────────────────┘
```

- **Typed IPC contract** (`src/shared/ipc.ts`) — one channel map imported by
  all three layers; the preload allowlists every channel at runtime.
- **Mock-first UI.** The renderer runs standalone in a browser against a
  scripted MockApi (including a fake streaming investigation) — every screen
  was built and verified before the backend existed, and still works that way.
- **One local SQLite file** holds everything: incidents, embeddings, sessions,
  events (append-only flight recorder), learnings, registry, encrypted
  secrets. `PRAGMA user_version` migrations; FTS5 + `sqlite-vec` in-file.
- **Cursor-based sync.** First run = full backfill; every run after pulls only
  what changed. Cursors are monotonic and only advance after a *complete*
  walk; upserts are idempotent — crashes and reruns are free. One GraphQL
  request hydrates 25 tickets with comments (rate-limit-proof).
- **Hybrid retrieval, three signals:** exact error-signature match → FTS5
  BM25 (exact tokens: codes, SHAs, paths) → vector KNN (paraphrase: "pods
  dying" ≈ "OOMKilled"), fused with signature-pinned Reciprocal Rank Fusion.
- **The knowledge loop.** Every report proposes 2–4 reusable **learnings**
  ("where the logs live, who owns what"). User-approved lines are embedded
  and **relevance-selected** into future prompts (small library → inject all;
  large → top-12 for the current symptoms + newest 5).
- **Feedback resumes the actual session.** Post-report, "you were wrong,
  check X" reopens the same provider session (native session id) — the agent
  re-investigates or defends with citations; a revised report flows through
  the same pipeline.
- **Fix handoff, not fix autonomy.** Approving "Open fix session" writes the
  investigation to `<repo>/.mesh/FIX-<id>.md` and opens *your* Claude Code in
  a Terminal at the culprit repo on a new branch. Review and push stay human.
- **Safety model:** read-only by default (read commands auto-approved via a
  deny-by-default classifier), every mutation gated by the approval broker —
  timeout = deny, window-closed = deny-all, everything audited to `events`.
  Claude-Code-style permission modes (Approve / Accept-edits / Auto / Plan /
  Bypass) are explicit user opt-ins.

### Build approach

Design-doc first (`ideation.md`, `architecture.md`) → high-fidelity design
(Claude Design, PRESS system) → planned phased build, each step leaving the
app runnable: tooling → renderer restructure → all screens on mock → typed
contract → SQLite → sync → retrieval → providers → engine → verify (typecheck
× 2, 33 unit tests on `:memory:`, browser + Electron smoke, screenshots) →
DMG packaging. Real-world hardening came from live use the same day: SDK
transcript bugs, rate limits, asar spawn traps, keychain identity changes —
each fixed with a regression guard.

## 3 · Technology Choices

| Layer | Choice | Why |
| --- | --- | --- |
| Shell | **Electron 33** | long-lived child processes + streaming are its home turf |
| UI | **React 18 + Vite + Tailwind** | HMR renderer that also runs in a plain browser |
| State | **Zustand** | small stores per domain, no ceremony |
| Main build | **esbuild** (ESM, `packages:'external'`) | ~10ms rebuilds; native modules never bundled |
| Database | **better-sqlite3 (WAL)** | synchronous, in-process, one file, zero ops |
| Vectors | **sqlite-vec** | KNN inside the same SQLite file — no vector DB |
| Lexical search | **SQLite FTS5** (porter) | BM25 + stemming, built in |
| Embeddings | **transformers.js + MiniLM-L6-v2 (q8, 384d)** in a **utilityProcess** | fully local, crash-isolated, ~25MB model |
| Agent | **Claude Agent SDK** (primary) · **Codex CLI** (read-only alt) | streaming, steering, resume, `canUseTool` permission hook |
| Agent tools | **Sentry MCP** (per-token) · git/kubectl/rg · in-prompt ticket + memory | live issues/traces without leaving the session |
| Sources | **@linear/sdk** (raw GraphQL for bulk) · **@slack/web-api** · **gh CLI** | user's own credentials; Mesh stores no secrets of its own |
| Secrets | **Electron safeStorage** → OS keychain | encrypted blobs in the DB, keys never in code |
| Validation | **zod v4** | report schema, distill output, settings |
| Tests | **vitest** (33) | pure modules + repos against `:memory:` (dual-ABI native setup) |
| Packaging | **electron-builder → DMG** | natives asar-unpacked; CLI binary path passed explicitly |

## 4 · Where It Stands

- **3,000+ incidents** ingested from Linear (comments included), distilled by
  LLM where a narrative exists, 100% embedded — semantic + lexical search live
- **172 org repos** cloned/fetched by the in-app repo sync; agent sessions run
  `git log/blame` against real checkouts to name the culprit commit and line
- **Sessions ledger**: every run, model, permission mode, step, and outcome
  persisted — nothing about an investigation is ephemeral
- Installable **DMG**; dark and light themes; the same UI demoable in any
  browser on mock data

*Built as an internal tool at Adalat — investigation-first, evidence-always,
human-approved writes only.*

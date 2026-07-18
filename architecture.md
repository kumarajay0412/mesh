# Mesh AI — Architecture (v1: Investigation Desktop App)

> Companion to `[ideation.md](./ideation.md)`. Where ideation defines *why* Mesh exists, this doc defines *how* we build v1. The original org-scale design (Temporal, Docker sandboxes, K8s, Postgres, six-layer graph) is preserved as the production target in [Section 12](#12-production-target-deferred).

---

## 1. Architectural Stance

v1 is a **local-only desktop app** for a single user. It ships to users as an **Incident Tracker** — that is the product surface and the wedge — while *Mesh AI* is the platform name it grows into (see `[ideation.md](./ideation.md)`). Two capabilities:

1. **Investigation** — hand Mesh a Linear ticket, an alert, or a Grafana link; get back an evidence-linked root-cause report identifying the culprit repo, commit, and code path.
2. **Fix handoff** — optionally end an investigation by opening a Claude Code / Codex session in the culprit repo, seeded with the full investigation as context.

Core design decisions:

- **Don't build an agent loop.** Claude Code and Codex CLI already are investigation agents. Mesh is the *harness*: session management, MCP wiring, the investigation runbook, steering, evidence collection, and report rendering.
- **No orchestration heavyweight.** No Temporal, no Docker sandboxes, no K8s, no Postgres. A SQLite state machine per investigation, plus natively resumable provider sessions (`claude --resume`), covers durability for one user on one machine.
- **No ownership layer.** Replaced by a **service registry** — a service → repo lookup table, mostly inferred, hand-corrected via `services.yaml`. Ownership contracts are dropped entirely (stale everywhere; in a single-user app the owner is you).
- **Interactive first, autonomous later.** The agent streams its steps; the user can steer mid-flight ("no, check the ingress logs instead"). Autonomy is just "don't touch the steering wheel" — same architecture, no extra work.
- **Read-only by default, no auto mode.** Investigation touches production observability and repo checkouts in read mode. Mesh performs **no create/update/delete operation on any connected system without an explicit, per-action user approval** — there is no autonomous write mode. The only write path is the explicit fix-handoff session, which behaves like a normal Claude Code session in one repo.

---

## 2. Top-Level Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  Mesh Desktop App (Electron)                                  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ Renderer (React + Vite + Tailwind + shadcn/ui)          │  │
│  │  · Investigations list  · Timeline / evidence view      │  │
│  │  · Steering input       · Report view  · Registry editor│  │
│  └───────────────▲─────────────────────────────────────────┘  │
│                  │ Electron IPC (typed events)                │
│  ┌───────────────┴─────────────────────────────────────────┐  │
│  │ Main process — Agent Runtime (TypeScript)               │  │
│  │                                                         │  │
│  │  Provider adapters            Investigation engine      │  │
│  │  ┌──────────────────────┐     ┌───────────────────────┐ │  │
│  │  │ Claude Agent SDK     │     │ Intake → Scope →      │ │  │
│  │  │ Codex `exec --json`  │◄────│ Investigate → Report  │ │  │
│  │  │ (one Provider iface) │     │ (state machine/SQLite)│ │  │
│  │  └──────────┬───────────┘     └───────────────────────┘ │  │
│  │             │ spawns w/ MCP config + runbook prompt      │  │
│  └─────────────┼───────────────────────────────────────────┘  │
│                │                                              │
│  ┌─────────────▼───────────────────────────────────────────┐  │
│  │ Local data                                              │  │
│  │  SQLite: registry · investigations · events · memory    │  │
│  │  Repo checkouts: ~/mesh/repos/<repo> (read-only fetch)  │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                │ (agent's tool calls, via MCP + local CLIs)
                ▼
   Grafana MCP (Loki · Prometheus · dashboards · deeplinks)
   Linear MCP · Slack MCP · Sentry MCP · Jira MCP · kubectl (user's kubeconfig) · git
```

---

## 2.1 First-Run Onboarding & Connections

Before any investigation runs, Mesh must be wired to the org's systems *and* learn what the org is. Onboarding is a guided, sequential connect flow — each step validated with a read-only call before it's marked done, and each unlocking the next. **Grafana comes first**, because service discovery seeds everything downstream.

1. **Connect Grafana (required, first).** User enters the **Grafana URL** and a **service-account token**. Mesh validates read access to Loki / Prometheus / dashboards.
2. **Discover services.** From Grafana datasources + label values (and `kubectl get deployments` if kube access is set up), Mesh enumerates the running services and drafts the service registry (Section 4): which services exist, their namespaces, **how each is served**, and the **identifiers they go by** in logs and dashboards — pod labels, dashboard UIDs, and tenant / **KKC** IDs.
3. **Build service knowledge cards.** For each service Mesh records *what it does, how it's served, and its identifiers* into the registry — hand-correctable like `services.yaml` (Section 4). This is the "know what is where, and what solution applies to it" layer the investigation prompt draws on.
4. **Connect issue trackers & chat.** Linear and the Slack **#reporting** channel (memory seeding, Section 7.1); **Jira** if the org uses it. These are the historical-incident sources.
5. **Connect identity / SSO.** **Google SSO** (and any other org login) so Mesh operates with the user's own access to every connected system.
6. **Pick your agent.** Choose the provider — **Claude Code** or **Codex**. For personal use Mesh rides your existing local CLI login (your own subscription) — no key to enter. (Only a distributed build asks each user for their own API key — BYOAK, Section 3.)

All credentials belong to the user; Mesh stores none of its own (Section 10). Every connection is read-scoped at onboarding — write access is never requested here; mutations are gated per-action at use time (Section 10). Unmapped or unreachable systems surface as warnings — "investigation quality degraded for these services" — never silent failures.

---

## 3. Stack (Locked for v1)


| Layer          | Choice                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell          | **Electron**                                                                              | The app's core job is managing long-lived child processes and streaming their output. Node `child_process`/`node-pty` in the main process is trivial and battle-tested (VS Code's model). Tauri would push subprocess/PTY management into Rust and put an IPC boundary on every agent event — wrong trade for a TS team. ~150MB footprint is a non-issue for a dev tool. |
| UI             | React + **Vite** + Tailwind + shadcn/ui                                                   | Transfers wholesale from the original design. Vite replaces Next.js — no SSR or routing middleware needed in a desktop shell.                                                                                                                                                                                                                                            |
| Client state   | Zustand (ephemeral UI) + TanStack Query (data)                                            | Unchanged from original design.                                                                                                                                                                                                                                                                                                                                          |
| Agent adapters | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) + **Codex** (`codex exec --json`) | Embed Claude Code as a library — sessions, streaming, MCP config, permission control as APIs instead of stdio parsing. Codex behind the same `Provider` interface — the user picks which in Section 9 Settings; neither is hardcoded.                                                                                                                                                                                                       |
| Provider auth  | **Personal use: your own Claude Code / Codex login** (rides your existing subscription, like Conductor/Crystal). **Distributed: BYOAK** (each user's own API key). | For personal use Mesh drives the user's *already-authenticated local CLI* — subscription auth is fine. The subscription-OAuth restriction (Anthropic/OpenAI ToS, 2026) only bites when the app is shipped to *other* users offering login; then API-key auth is required. Either way Mesh holds no provider key of its own (Section 10). |
| Concurrency    | Plain async/await + `AbortController`                                                     | Effect TS was justified by Temporal-scale orchestration; a handful of local subprocesses doesn't need it. Revisit at fleet scale.                                                                                                                                                                                                                                        |
| Storage        | **SQLite** (better-sqlite3) + **`sqlite-vec`**                                                               | Registry, investigations, event log, memory. `sqlite-vec` adds vector search **in the same file** (Section 7.1) for hybrid lexical + semantic retrieval — still single-file, zero ops.                                                                                                                                                                                                                                                                                                      |
| Repo access    | Plain local clones under `~/mesh/repos/`                                                  | Worktrees return when parallel write-agents return (Section 12).                                                                                                                                                                                                                                                                                                                |
| Integrations   | MCP servers: Grafana, Linear, Sentry; `kubectl` via user's kubeconfig                     | Auth stays with the user's existing credentials; Mesh never stores secrets of its own.                                                                                                                                                                                                                                                                                   |


### Provider interface

```ts
interface Provider {
  start(opts: {
    cwd: string;                 // repo checkout or scratch dir
    systemPrompt: string;        // runbook + registry context
    mcpServers: McpConfig[];     // grafana, linear, sentry
    permissionMode: 'readOnly' | 'default';  // investigation vs fix session
  }): Session;
}

interface Session {
  send(userTurn: string): void;            // initial task + steering messages
  events: AsyncIterable<AgentEvent>;       // tokens, tool calls, results
  interrupt(): void;
  resume(sessionId: string): Session;      // durability without Temporal
}
```

`send()` doubles as the steering channel — both Claude Code and Codex are session-oriented, so mid-flight steering is just appending a user turn. No new protocol.

---

## 4. The Service Registry (v1 of the Org Graph)

Investigation is impossible without knowing that the `payments-api` pod in Grafana maps to the `payments-service` repo. That's a lookup table, not an ownership contract.

### Inference pipeline (run on registry sync)

```
kubectl get deployments (all namespaces)
   ↓  Deployment name + container image
image name  ←→  repo that builds it
   (match against each registered repo's Dockerfile / CI config /
    image-name conventions)
   ↓
services.yaml  (generated entries marked `source: inferred`)
```

### `services.yaml` — the hand-editable source of truth

```yaml
services:
  - name: payments-api            # k8s Deployment / Grafana label value
    repo: payments-service        # under ~/mesh/repos/
    namespace: prod
    source: inferred              # or `manual` — manual wins on conflict
    aliases: [payments, pay-svc]  # names it goes by in logs/dashboards/tickets
    does: "Checkout + settlement; owns the payments Postgres."   # service knowledge card
    serving: "Deployment, 4 replicas behind payments-api Service; ingress /api/pay"
    ids:                          # how to find it in observability
      dashboard_uid: pay-main
      loki_label: "app=payments-api"
      tenant_key: KKC             # tenant / KKC identifier it partitions data by
    known_solutions:              # recurring failures + the standing fix (grows via memory, Section 7.1)
      - symptom: "OOMKilled under settlement batch load"
        fix: "raise memory limit / check batch size regression — see INV-042"
  - name: auth-gateway
    repo: auth-gateway
    namespace: prod
    source: manual
```

Rules:

- Inference never overwrites a `source: manual` entry.
- Unmatched deployments surface in the UI as "unmapped — investigation quality degraded for these services" rather than failing silently.
- `aliases` is what makes ticket text ("payments is down") resolvable to a service, then to a repo.

### Service knowledge cards

The `does` / `serving` / `ids` / `known_solutions` fields are the **service knowledge card** — populated at onboarding (Section 2.1, from Grafana discovery) and enriched over time. They answer the two questions an investigation opens with: *what is this service and where does it live?* and *what solution do we already know applies to it?* `known_solutions` is the bridge to memory (Section 7.1): a confirmed root cause + fix for a recurring symptom is written back here, so the standing answer travels with the service, not just the incident record.

This registry is the seed of the org graph. Layers get added to it (dependencies, contracts, CI) only when the write path returns (Section 12) — not before.

---

## 5. Investigation Engine

A four-stage state machine per investigation, persisted to SQLite after every transition. Crash recovery = reload state + `session.resume()`.

```
INTAKE → SCOPE → INVESTIGATE → REPORT   (any stage → ABANDONED)
```

### Stage 1 · Intake

Input: Linear ticket ID, pasted alert text, or a Grafana link.

- Linear MCP pulls the ticket (title, description, comments, labels).
- A small extraction pass produces: **symptoms** (error messages, metric anomalies), **service mentions** (raw strings), **time window** (explicit, or inferred from ticket timestamps).
- Memory lookup: query past investigations for similar symptoms (see Section 7). Matches are attached as context, shown in the UI ("similar to INV-042").

### Stage 2 · Scope

- Resolve raw service mentions → registry entries (via names + aliases).
- Expand candidates: services whose Grafana labels appear in linked dashboards; services named in Sentry issues for the window.
- Ensure candidate repos are cloned/fetched under `~/mesh/repos/`.
- Output: candidate service list + repos + time window. Shown to the user for a quick confirm/edit before spending agent time — this is the only mandatory gate.

### Stage 3 · Investigate

Spawn one provider session with:

- **cwd**: a scratch dir with read-only access to candidate repo checkouts.
- **MCP servers**: Grafana, Linear, Sentry.
- **CLI access**: `kubectl` (read verbs), `git` (log/show/diff), `rg`.
- **System prompt**: the runbook (Section 6) + registry context (candidate services, repo paths, time window, similar past investigations).

The session streams to the timeline UI. The user can steer at any point by typing — delivered as a user turn via `session.send()`. Interventions for v1: **steer** (message), **interrupt**, **abandon**. (The original eight-signal table returns with fleets, Section 12.)

### Stage 4 · Report

Structured output, enforced by schema:

```
- Root-cause hypothesis (with confidence: confirmed / probable / suspected)
- Culprit: repo · commit SHA · code path
- Evidence chain: each claim → source link
    (Grafana deeplink · LogQL query · kubectl output · commit SHA)
- Timeline: symptom onset vs deploys vs anomalies
- Suggested fix (description only — no code changes)
- Unexplored branches (what the agent didn't check and why)
```

Report actions: **post to Linear** (as a comment, via MCP — with user confirmation), **open fix session** (spawns a provider session in the culprit repo, `permissionMode: default`, seeded with the report), **save to memory** (automatic on completion).

---

## 6. The Investigation Runbook (the product IP)

The runbook is a structured system prompt encoding the SRE method. Agents flail on observability without this discipline; with it they're very good. Kept as a versioned markdown file in the app bundle, user-extensible per org.

Skeleton:

```
1. ESTABLISH THE WINDOW
   Fix the symptom-onset timestamp from the ticket/alert. All queries
   anchor to it. Never query "last hour" — query around onset.

2. WHAT CHANGED
   Deploy markers / rollout events for candidate services in the window
   (kubectl rollout history, Grafana annotations, recent commits in
   mapped repos via git log --since). A symptom that starts at a deploy
   boundary is the strong prior.

3. TRIAGE SIGNALS, BROAD → NARROW
   Error rates → pod restarts/OOMKills → memory/CPU trends → latency
   percentiles, across candidate services. Compare against the same
   window yesterday/last week before calling something an anomaly.

4. FOLLOW THE STRONGEST SIGNAL
   Loki logs for the anomalous service, filtered to the window and to
   error/warn. Extract the failing code path from stack traces; open
   the mapped repo and read the actual code.

5. CORRELATE TO A CHANGE
   git log the implicated paths. Name the commit if it exists. If no
   code change fits, widen: config, infra, upstream dependency, data.

6. VERIFY WITH A SECOND INDEPENDENT SIGNAL
   A hypothesis is "probable" with one signal, "confirmed" with two
   independent ones (e.g. log evidence + metric inflection at the same
   timestamp). Say which tier you reached.

7. EVIDENCE DISCIPLINE (hard requirement)
   Every claim in the report carries a source: a Grafana deeplink
   (generate_deeplink), the exact LogQL/PromQL query, a kubectl
   command + output snippet, or a commit SHA. A claim without a
   source does not go in the report.

8. KNOW WHEN TO STOP
   If two triage passes produce no signal, report "no root cause
   found" with the evidence of absence and the unexplored branches.
   A truthful dead-end beats a confident guess.
```

---

## 6.1 Culprit Commit Localization

Runbook steps 4–6 end at "name the commit." This is the mechanism — how a Sentry error is narrowed to a specific suspect commit, ranked, as a **hypothesis** ("just a hunch"), never an auto-applied conclusion.

The chain, from error to blame:

```
Sentry issue
  → stack trace: top frames = file + line + release/version
  → release ↔ commit range      (Sentry release tags, or deploy window → git SHAs)
  → git blame <file> -L <line>   on the faulting frames
        = the commit that last touched the exact failing lines
  → git log --since=<onset> -- <faulting paths>
        = commits on those paths inside the suspect window
  → intersect + rank
```

A commit is a stronger suspect the more of these it satisfies:

- **Touches a faulting line** — `git blame` on a top stack frame points straight at it.
- **Lands in the blame window** — after the last release where the error was absent, at or before the release where it first appeared (Sentry `firstSeen`).
- **Coincides with onset** — merged/deployed at the symptom-onset boundary (the strong prior from runbook step 2).

Output is a **ranked suspect list**, each carrying the confidence tiers already defined (Section 4): one signal → `suspected` ("a hunch — this commit last touched the line that threw"); blame + release-window agreement → `probable`; blame + window + a second independent signal (metric inflection at the same deploy, or the diff plainly introduces the fault) → `confirmed`.

Notes:

- **Sentry's own suspect-commit / release tracking is a prior, not a verdict.** Mesh takes it as a candidate and re-derives via blame + window, because that mapping is only as good as the release→commit metadata the build shipped with.
- **Evidence discipline still holds** (runbook Section 6, step 7): every suspect names its blame line, its release delta, and its onset correlation. A commit with no linkable evidence does not get ranked.
- **It points; it does not push.** The top suspect flows into the Report's culprit field (Section 5, Stage 4) and can seed the fix session — but that fix session is the explicit, per-action-approved write path (Section 10). No blame ever triggers an automatic change.

---

## 7. Investigation Memory (v1 of Architectural Memory)

Every completed investigation is stored: symptoms, candidate services, evidence chain, root cause, fix outcome. Retrieval happens at intake:

- **v1 retrieval**: hybrid — SQLite **FTS5** (lexical) + **`sqlite-vec`** (semantic embeddings) over symptoms, plus an exact **error-signature** match, merged and reranked (Section 7.1). All in the one local file.
- Embeddings are generated by a **local** model, so nothing leaves the machine — both lexical and semantic search ship in v1 (this supersedes the earlier "FTS-only, embeddings later" plan).

Matches surface as context to both the user ("similar to INV-042: memory leak in gRPC connection pool") and the agent (injected into the runbook prompt). Feedback loop: if a past investigation's fix is confirmed as the same root cause, link the two records — recurrence patterns are themselves evidence ("third OOM in payments-api since May").

---

## 7.1 Memory Ingestion & Seeding

Section 7 grows memory from investigations Mesh itself runs — which means a **cold start**: on day one the memory is empty, even though the org already has years of resolved incidents in Linear and the Slack **#reporting** channel. Ingestion seeds memory from that history and keeps it current, so "has this happened before?" works from the *first* investigation, not the fiftieth.

### Sources → the three questions

Each thing a user asks of memory maps to a concrete field, which tells us exactly what to extract:


| Question                        | Field                                    | Extracted from                                                            |
| ------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------- |
| *Has this happened before?*     | `symptoms`                               | Slack #reporting opening message + Linear/Jira title & description        |
| *How did we resolve it?*        | `resolution`                             | Closing comments + final state of the ticket                              |
| *How did the investigation go?* | `investigation_summary` (+ raw timeline) | The ticket's **comment thread** and the linked Slack **thread**, in order |


The investigation narrative lives in the **comments**, not the ticket body — ingestion must pull comments, not just issues.

### Linking

A Slack thread and a Linear/Jira ticket usually describe the same incident from two angles. Mesh links them, most-reliable-signal first:

1. Ticket link/attachment containing the Slack permalink (most reliable).
2. Ticket identifier (`ENG-123`) mentioned in the Slack thread.
3. Fallback: timestamp proximity + text similarity.

Each linked pair collapses into one memory record.

### Incremental sync (the daily refresh)

Ingestion is **cursor-based** so a refresh pulls only what changed — this is the flow behind the "Refresh" button:

```
for each source in (linear, slack:#reporting, jira?):
  cursor ← sync_state[source]              # empty on first run = full backfill
  fetch items updated since cursor         # Linear: updatedAt > cursor
                                           # Slack: conversations.history oldest=cursor + thread replies
  link → distill                           # one LLM pass → symptoms / root_cause /
                                           #   resolution / investigation_summary
  upsert into memory keyed by ticket id    # idempotent — re-runs never duplicate
  cursor ← max(updatedAt seen); persist
```

- **First run = backfill; every run after = incremental.** Same code path, no separate importer.
- **Upsert by ticket id** makes refresh idempotent and lets reopened/edited tickets update in place.
- The **distill pass** is what turns a wall of comments into the four structured fields — done once at ingest, not at query time.

### Webhooks vs. poll (decision)

A local desktop app has **no public URL for a webhook to reach**, so Linear/Slack cannot push events to it. The refresh-button poll *is* the sync model, and it matches the "no hosted service" stance (Section 11). **Decision: backfill once + incremental poll on refresh.** Webhooks return only if/when a hosted relay exists (production target, Section 12) — not in v1.

### Retrieval

- **At intake (automatic):** a new ticket's symptoms query memory and surface "similar to INV-042" to both user and agent (Section 5, Stage 1) — now backed by the whole history, not an empty table.
- **On demand (manual):** the memory-search surface (Section 9).
- **To the agent:** memory is exposed as a local MCP tool — `search_memory(query, filters)` / `get_memory(id)` — so Claude Code / Codex retrieves and cites past incidents itself. `get_memory` returns the distilled fields *and* `raw_comments_json`, so the agent can read how the investigation actually went, not just its summary.

### Retrieval quality (hybrid: FTS5 + sqlite-vec, in v1)

Retrieval combines three signals, strongest first, merged and reranked in app code:

1. **Error signature** — exact match on a normalized `(exception type + top stack frame)` fingerprint (`error_signature`, Section 8). A b-tree lookup, highest precision, no ranking.
2. **FTS5 / BM25** — lexical similarity, unbeatable on exact tokens: error codes, commit SHAs, service names, `settle.py:88`.
3. **`sqlite-vec`** — semantic similarity over `symptoms` embeddings, catching paraphrase FTS misses ("pods dying" ≈ "OOMKilled", "pool exhausted" ≈ "too many open sockets").

Lexical and semantic are complementary — FTS nails identifiers, vectors nail reworded prose — so v1 ships **both** and reranks the union, rather than the earlier "FTS now, embeddings later" plan.

**Embeddings are generated locally.** A small on-device embedding model turns `symptoms` into a vector at ingest (once per record) and at query time (once per search). This keeps the "nothing leaves the machine" guarantee (Section 11) and avoids a second API key — the alternative, an embeddings API, would send symptom text off-device, which memory's whole-history sensitivity argues against.

---

## 8. Storage Schema (SQLite)

```sql
services        (name PK, repo, namespace, source, aliases_json, updated_at)
repos           (name PK, path, remote_url, last_fetched_at)
investigations  (id PK, ticket_ref, status, time_window_start/end,
                 candidates_json, report_json, session_id, created_at, closed_at)
events          (id PK, investigation_id FK, ts, type, payload_json)
                -- append-only: intake.parsed, scope.confirmed, agent.tool_call,
                -- agent.steered, report.ready, report.posted, ...
memory          (id PK, source, linear_id, linear_identifier, slack_thread_url,
                 title, symptoms, root_cause, resolution, investigation_summary,
                 error_signature, raw_comments_json, labels_json, priority,
                 reported_at, resolved_at, updated_at)
                -- seeded from Linear/Slack/Jira history (Section 7.1) AND Mesh's own
                -- investigations; `source` distinguishes them. Upsert by ticket id.
                -- error_signature = hash(exception type + top stack frame) for exact match
sync_state      (source PK, cursor, last_run_at)
                -- 'linear' | 'slack:C0XXXX' | 'jira' — incremental-ingest cursor
memory_fts      (FTS5 virtual table over memory: symptoms, title, root_cause)
memory_vec      (sqlite-vec virtual table: memory_id, embedding[N])
                -- semantic search over symptoms; embeddings generated locally (Section 7.1)
links           (investigation_id, related_investigation_id, relation)
```

The `events` table is the same "selective replay, never full replay" design from the original architecture — one user, one file, same queries.

---

## 9. UI Surfaces (v1)

1. **Onboarding / Connections** — the first-run connect flow (Section 2.1): Grafana URL + service-account token, service-discovery review, then Linear / Slack #reporting / Jira / Google SSO. Re-openable to add a source, re-auth, or run the memory **Refresh** (Section 7.1).
2. **Investigations list** — open/closed, status, similar-to badges.
3. **Investigation view** — the core screen: left = live agent timeline (tool calls, findings, streamed reasoning) with a steering input pinned at the bottom; right = evidence rail (every sourced claim accumulates here as it's made, each linked out to Grafana/Sentry/commit).
4. **Report view** — the structured report, with post-to-Linear and open-fix-session actions.
5. **Registry editor** — `services.yaml` with inferred/manual markers and the unmapped-deployments warning list.
6. **Memory search** — free-text search over seeded + accumulated memory (Section 7.1): type a symptom, get past incidents with their resolution and links back to Linear/Slack. Hosts the daily **Refresh** action and shows last-sync state per source.
7. **Settings** — provider choice (Claude Code / Codex) + BYOAK API keys, MCP endpoints, kubeconfig context, repo roots.

---

## 10. Security Posture (v1)

- All credentials are the user's own: Grafana service-account token, Linear/Slack/Jira/Sentry MCP auth, Google SSO, kubeconfig, git. Mesh stores no secrets of its own; access is **inherited** from the user's existing logins.
- **Provider auth follows the deployment.** Personal use (you, your machine) rides your own Claude Code / Codex login — no key to manage, subscription auth is fine. Distributing to others requires bring-your-own-key (each user's own Anthropic/OpenAI API key), because a third-party app may not use subscription OAuth (Section 3). Either way Mesh holds no provider key of its own; a BYOAK key lives in the OS keychain and is used only to call the provider.
- **No autonomous writes, ever.** Every create/update/delete on any connected system — Linear/Jira comment or state change, git push, file edit, config change — requires an explicit, per-action user approval in the UI. There is no auto/unattended mode. Read paths are the default; each write path is individually gated at the moment it's taken.
- Investigation sessions run `permissionMode: readOnly`: read-only kubectl verbs, no `git push`, no file writes outside the scratch dir. Enforced via the Agent SDK's permission hooks (and an allowlist wrapper for Codex).
- Fix sessions are explicitly opt-in, scoped to one repo, and behave like a normal Claude Code session — the user reviews and pushes manually.
- Posting anything outward (Linear comments) always requires a confirmation click.

---

## 11. What We Are NOT Building in v1

- **An agent loop or model runtime.** Providers are commodity inputs; the harness and accumulated knowledge are the product.
- **The six-layer org graph.** The service registry is the seed; layers return with the write path.
- **Ownership resolution.** Dropped, not deferred-as-is: if it ever returns, it returns as on-call lookup (who to page), not code-ownership contracts.
- **Multi-agent fleets, worktree parallelism, sandboxed containers.** One interactive session per investigation.
- **Heavy *code* indexing (SCIP, tree-sitter, code embeddings).** `git log`, `rg`, and the agent's own code reading are enough for investigation. Indexing earns its keep when the write path returns. (Distinct from *memory-retrieval* embeddings via `sqlite-vec`, which **are** in v1 — see Section 7.1.)
- **A hosted service.** Everything is local; the desktop app is the deployment.
- **Autonomous or unattended writes.** No auto mode; every mutation on a connected system is user-approved per action (Section 10). Webhook-driven ingestion is likewise deferred — v1 syncs by poll-on-refresh (Section 7.1).

---

## 12. Production Target (Deferred)

The original org-scale architecture remains the destination once the wedge proves out. Preserved decisions, to be revisited in roughly this order:


| Capability    | v1 form                                   | Production form (original design)                                                  |
| ------------- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Org knowledge | Service registry (`services.yaml`)        | Six-layer org graph (code/dep/contract/deploy/CI; ownership → on-call lookup only) |
| Memory        | SQLite + FTS5 + `sqlite-vec` (local embeddings) | Postgres + pgvector, event store with selective replay                       |
| Orchestration | SQLite state machine + resumable sessions | Temporal (or Inngest/Restate) workflows, signal-based steering (8-signal table)    |
| Execution     | One local session, user's machine         | Docker-sandboxed agent fleet, K8s scheduling, worktree isolation                   |
| Write path    | Single-repo fix handoff                   | Blast-radius report → coordinated multi-repo PRs → validation agent                |
| Indexing      | git log + rg                              | Tree-sitter → SCIP → embeddings, three-tier live indexing (T1/T2/T3)               |
| Surface       | Desktop app                               | Web app (Next.js) + gateway (Hono) + WebSocket/NDJSON                              |


Trigger for starting the production build: investigations regularly end in fix sessions, and the fix sessions start needing cross-repo coordination. That's the signal the wedge has pulled the write path into demand — build it then, not before.
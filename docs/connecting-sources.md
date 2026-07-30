# Connecting your tools to Mesh

> Paste-ready for Notion: copy this whole file into a Notion page — headings, tables and code blocks convert to native blocks. The in-app version of every guide lives in **Connections → Connect → "How to generate this token"**; if this page and the app ever disagree, the app is newer.

Mesh connects to your tools with **read-scoped tokens that you create and can revoke at any time**. Tokens are encrypted with your OS keychain (`safeStorage`) before they touch disk. Mesh never writes to any connected tool except one action — posting a report comment to Linear — and that single write always sits behind an approval dialog.

The general flow is the same for every source:

1. **Connections** → pick the source → **Connect**
2. Open **"How to generate this token"** inside the dialog — it names the exact menu path, the scopes, and has an *Open* button to the right page
3. Create the token in the provider, paste it into Mesh
4. **Memory → Refresh** (or wait — auto-sync catches up within a minute)
5. Watch the connection card: it reports what actually arrived (*"3,520 tickets in memory"*), not just "connected"

---

## What each connection yields

| Source | What Mesh does with it | Pipeline | Token type |
|---|---|---|---|
| **Grafana** | Service discovery from Loki labels; pre-collected incident brief (annotations, error deltas, k8s signals); live queries during investigations | direct reads | Service-account token, **Viewer** role |
| **Linear** | Every ticket + comment thread distilled into searchable incident memory (symptoms · root cause · fix · error signature) | incident (LLM distill) | Personal API key |
| **Slack** | Chosen incident/RCA channels: threads distilled into incident memory | incident (LLM distill) | Bot token (`xoxb-`) or user token (`xoxp-`) |
| **Notion** | Every shared page ingested **verbatim** — full-text + semantic search, each hit links back to the page | corpus (no LLM, free) | Internal integration secret |
| **Sentry** | Live issue/event/stack-trace tools inside every agent session | live MCP | User auth token |
| **Clusters** | Read-only `kubectl` during investigations, routed per service | ambient (your gcloud/az login — no token stored) | none |

---

## Per-source setup

### Grafana

*Grafana → Administration → Users and access → Service accounts*

1. Add service account — name it `mesh`, role **Viewer**
2. Add a service-account token; copy it immediately (shown once)
3. In Mesh, add the instance URL + token — repeat per Grafana (prod, azure, …)

Token looks like `glsa_…`. Viewer is enough: Mesh only reads dashboards, Loki and Prometheus.

### Linear

*Linear → Settings → Security & access → Personal API keys* — <https://linear.app/settings/api>

1. New API key, label it `Mesh`, copy it now (not shown again)

Token looks like `lin_api_…`. The key inherits **your** access — Mesh sees exactly the teams you do.

### Slack

*<https://api.slack.com/apps> → Create New App → From scratch*

1. OAuth & Permissions → **Bot Token Scopes**: `channels:history`, `channels:read` (+ `groups:history`, `groups:read` for private channels)
2. Install to Workspace, copy the **Bot User OAuth Token** (`xoxb-…`)
3. **Invite the bot to each channel you sync**: `/invite @your-app` — a bot cannot read a channel it isn't in (the error is `not_in_channel`)
4. In Mesh, paste the token, then pick channels from the live list

A user token (`xoxp-…`) with the same scopes skips the invite step but carries your own access rather than the app's.

### Notion

*<https://www.notion.so/my-integrations>*

1. New integration — type **Internal**, capability **Read content** only (Mesh never writes to Notion)
2. Copy the Internal Integration Secret (`ntn_…` / `secret_…`)
3. **Share pages with it** — this is the step everyone misses: a Notion token starts with access to *zero* pages. Open each top-level page → `•••` → **Connections** → add your integration. Children inherit, so a handful of top-level shares covers the workspace.

If a sync completes with nothing, Mesh tells you which integration the token belongs to — e.g. *“token is "Ajay api" in workspace "Adalat AI" — 0 pages shared with it”* — so you can check you shared with **that** one, not a similarly-named neighbour.

### Sentry

*Sentry → Settings → Account → API → User Auth Tokens* — <https://sentry.io/settings/account/api/auth-tokens/>

1. Create New Token, name it `Mesh`, scopes: `org:read`, `project:read`, `event:read`

Token looks like `sntryu_…`. Self-hosted Sentry: same menu path on your own host.

### Kubernetes clusters (no token)

Mesh stores **no cloud credentials**. It reads what your machine already has: run `gcloud container clusters get-credentials …` / `az aks get-credentials …` once, and the Connections → Kubernetes card shows what's reachable — including honest failure states (expired gcloud login, missing `gke-gcloud-auth-plugin`, a registry mapping pointing at a context that doesn't exist) with a **Run** button that executes the fix in Mesh's embedded terminal.

---

## Troubleshooting, in the order people hit things

| Symptom | Cause | Fix |
|---|---|---|
| Notion card: *0 pages — share pages with the integration* | Token valid, nothing shared with it | Share top-level pages with the integration **named in the sync message** |
| Slack sync error `not_in_channel` | Bot not invited to that channel | `/invite @your-app` in the channel |
| Slack channel missing from the picker | Missing `channels:read`, or private channel without `groups:*` | Add the scope, reinstall the app to the workspace |
| Search finds nothing it should | Embedding drain still running | Memory screen tiles show *“N embedded — indexing…”*; wait for the drain |
| Card says *stored token unreadable* | OS keychain identity changed (app re-signed) | Re-enter the token |
| Grafana discovery finds 0 services | Token lacks datasource read, or no Loki labels | Check Viewer role; discovery reads Loki label values |

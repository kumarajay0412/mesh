# Building a connector for Mesh

> Paste-ready for Notion (code blocks convert cleanly). Audience: someone adding a new source — Confluence, Google Drive, Jira, a wiki. The Notion connector (`src/main/sync/notion.ts`, shipped in commit `061d012`) is the worked example; every step below points at the real file it touches.

## 1 · First decision: which pipeline is this source?

Every source flows into the same memory store, but through one of two pipelines. Pick before writing code — it decides everything else.

| | **Incident pipeline** | **Corpus pipeline** |
|---|---|---|
| For | things with a root cause: tickets, incident threads, RCAs | knowledge: docs, wikis, design pages, general channels |
| Steps | fetch → link → **LLM distill** → embed | fetch → clean → embed |
| Cost | one LLM call per item (gated: short items take a heuristic path) | **zero** — embeddings are local MiniLM |
| What's stored | structured fields: symptoms · root cause · resolution · error signature | the **verbatim text** in `symptoms`, plus a `url` back to source |
| Search behaviour | signature exact-match participates; siblings cross-linked | full-text over the whole body; hit opens at source |
| Examples | `linear.ts`, `slack.ts` | `notion.ts` |

Rule of thumb: if summarising an item into `{symptoms, root_cause, resolution}` would *destroy* what makes it useful, it's corpus. Don't run both pipelines on the same item — it doubles cost and storage for nothing.

## 2 · The fetch client (`src/main/sync/<source>.ts`)

One file, no Electron imports (so it's unit-testable under plain vitest). Its contract, copied from `linear.ts`/`notion.ts`:

```ts
export async function fetch<Source>Since(
  token: string,
  cursor: string | undefined,                    // ISO time of last completed walk
  onPage: (items: CorpusDoc[] /* or RawTicket[] */) => Promise<void>,
): Promise<string | undefined>                   // new cursor, or old one unchanged
```

**The cursor contract — the part that must not be improvised:**

- Walk **newest-first**, stop as soon as you cross the cursor
- Emit items in pages via `onPage` (ingestion is incremental — a crash keeps what landed)
- Track the max timestamp seen, **return it at the end** — never persist it yourself
- The orchestrator advances the cursor **only after the walk completes**. A mid-walk crash therefore re-walks — which is safe, because upserts are idempotent and the skip-unchanged fast path absorbs re-seen items

Also expected of a well-behaved client:

- **Pace and retry**: respect the provider's rate limit (Notion: ~3 rps + `Retry-After` on 429); bounded retry on 429/5xx only — auth errors fail fast
- **Actionable errors**: a 401/403 message should say what to *do* (`notion.ts` appends "…check that it has been shared into the pages you want")
- **Identify on empty**: if a valid token yields nothing, name the identity the token belongs to (`notionWhoAmI` → *"token is X in workspace Y — 0 pages shared with it"*). This one habit turned a real "it doesn't work" into a ten-second fix.

## 3 · The touchpoint checklist

Nine places, in dependency order. TypeScript enforces most of them — after step 1 the compiler literally lists the rest (`Record<SourceId, …>` types fail to build until every UI map has your entry).

| # | File | Change |
|---|---|---|
| 1 | `src/shared/types.ts` | add to `SourceId` (and `SourceKind`, `MemoryRecord['source']` if it stores memory) |
| 2 | `src/main/db/migrations.ts` | only if you need a new column — corpus sources got `url` in v9; you likely need nothing |
| 3 | `src/main/sync/<source>.ts` | the fetch client (§2) |
| 4 | `src/main/sync/index.ts` | `knownSources()`: include when the token exists · `syncOne()`: the fetch→ingest branch (corpus sources call `ingestCorpus`, done) |
| 5 | `src/main/ipc/register.ts` | `SOURCE_META` name · live card detail in `connections:list` (count from memory, `lastSyncAt`) |
| 6 | `src/renderer/…/ConnectWizard.tsx` | the connect form fields (`FORMS`) |
| 7 | `src/renderer/…/token-guides.ts` | the in-app "how to generate this token" guide — menu path, scopes, what the token looks like, the gotcha |
| 8 | `src/renderer/src/lib/mock-api.ts` | mock connection card + any mock records, so browser dev shows your source |
| 9 | `src/main/__tests__/<source>.test.ts` | see §4 |

Secrets are automatic: the wizard stores fields as `<source>.<field>` (e.g. `notion.token`) via the generic `secrets:set` path — keychain-encrypted, nothing to add.

The scheduler is automatic too: once `knownSources()` includes you, catch-up-on-launch and interval re-sync just happen.

## 4 · Tests that matter (copy `notion.test.ts`)

1. **Pure extraction** — provider payload → text, every block/field type you claim to handle
2. **Cursor semantics with a mocked `fetch`** — proves: emits docs with url+title; returns max edited time; **stops at the cursor without fetching bodies for older items** (count the mock's calls); keeps the cursor unchanged when nothing is newer
3. **Storage round-trip against `:memory:`** — upsert a record, prove it's FTS-searchable by body words, url round-trips, row queues for embedding, skip-unchanged holds
4. **The error path** — the actionable 401/403 message actually fires

## 5 · What you get for free

Because everything downstream keys off the memory row, a connector ends at `ingestCorpus`/`ingestPage` — no further wiring:

- **Hybrid search** (FTS5 BM25 + local vector KNN + signature pinning) over your records
- **Embeddings** — the drain picks up any row with `embedded = 0`, batched, locally
- **Agent access** — `search_memory` surfaces your records mid-investigation; `get_incident` reads one in full (corpus records return up to 6K chars of body + url)
- **UI** — Memory search results (with *open in <source>* links), the store counter tile, the sync panel row with progress/error states, connection-card live stats
- **Ops** — per-source cursor, single-flight, crash recovery, the Refresh button, auto-sync

## 6 · Posture rules (non-negotiable)

- **Read-only.** A connector never writes to the provider. The one sanctioned outbound write in all of Mesh (Linear report comment) is approval-gated; don't add a second without the same gate.
- **Tokens through `secrets`** — never in settings, files, or logs.
- **No hosted dependency.** A connector talks to the user's own account with the user's own token. If your source requires routing data through a third-party service, that's an architecture conversation, not a connector.
- **Errors must say what to do.** "0 items" with a healthy token is a *state to explain*, not a success to report.

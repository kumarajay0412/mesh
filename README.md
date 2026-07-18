# Mesh AI — Incident Tracker (desktop app)

Local, single-user incident-tracker / investigation desktop app. See
[`ideation.md`](./ideation.md) and [`architecture.md`](./architecture.md) for the
product and technical design; this README covers running and hacking on it.

## Stack

Electron (ESM main, TypeScript) · Vite + React + TS + Tailwind (renderer) · Zustand ·
better-sqlite3 + **sqlite-vec** (one local `mesh.db`, hybrid lexical+semantic memory) ·
`@huggingface/transformers` (local MiniLM embeddings in a utilityProcess worker) ·
**Claude Agent SDK** / Codex CLI behind one `Provider` interface — on the **PRESS / Ada**
design system (dark-first, ink `#0e0e0e` + signal-yellow `#f5c518`).

## Run

```bash
npm install          # postinstall fetches BOTH native prebuilds (see below)
npm run dev          # UI only, in the browser at :5173 — MockApi with a scripted investigation
npm run electron:dev # the real desktop app (Vite + esbuild-watch + Electron, auto-respawn)
npm run typecheck    # renderer + main tsconfigs
npm test             # vitest — pure modules + repos on :memory:
npm run build        # production renderer + main bundles
```

Browser mode runs on **MockApi** (sample data, a scripted live investigation, fake sync)
— fast visual iteration, no Electron needed. Inside Electron the same UI talks to the
real backend over typed IPC (`src/shared/ipc.ts`).

### Native modules (the one sharp edge)

better-sqlite3 needs a binary per ABI. `scripts/rebuild-native.mjs` (runs on postinstall)
fetches **two prebuilds**: the Node-ABI one (stashed at
`better-sqlite3/build/Release/node/`, used by vitest) and the Electron-ABI one (default
path, used by the app). No compiler toolchain needed. If Electron ever bumps:
`npm run rebuild:native`.

## Layout

```
scripts/           build-main.mjs (esbuild: ESM main + worker, CJS preload) · dev-electron.mjs · rebuild-native.mjs
src/
  shared/          types.ts · ipc.ts            ← the one vocabulary + typed channel contract
  preload/         index.ts                     ← mesh.invoke / mesh.on, allowlisted
  main/
    index.ts                                    ← window + wiring only
    ipc/           register.ts · approvals.ts   ← typed handlers · the Section 10 approval broker
    db/            index.ts (open+vec+migrate) · migrations.ts (Section 8 schema) · repos/*
    sync/          linear.ts · slack.ts · link.ts · distill.ts · scheduler.ts · index.ts (runSync)
    providers/     claude.ts (Agent SDK) · codex.ts (exec --json, read-only) · readonly.ts
    engine/        machine.ts · intake.ts · runbook.ts (Section 6) · report-schema.ts · engine.ts
    memory/        signature.ts · rank.ts (RRF) · search.ts (hybrid) · embeddings.ts · embed-worker.ts
    security/      secrets.ts (safeStorage → OS keychain)
    __tests__/     machine · link · signature · rank · repos (29 tests)
  renderer/src/
    lib/           api.ts (MeshApi) · ipc-api.ts · mock-api.ts · format.ts
    stores/        app · investigations · memory · registry · connections · settings · approvals
    components/    ui/* · layout/* · investigation/* · report/* · registry/* · memory/* ·
                   connections/* · approval/ApprovalModal.tsx
    screens/       thin composition only (7 screens)
```

## How it fits together

- **Investigation flow (Section 5):** New investigation → intake extraction (+ similar-incident
  lookup from memory) → registry scope → a **read-only provider session** streams to the
  timeline (steer/interrupt/abandon) → structured ```mesh-report``` block → report view →
  saved back into memory.
- **Approvals (Section 10):** every mutating tool call blocks on the ApprovalModal via the
  broker — timeout(10m)=deny, deny-all on window close. Codex runs read-only (no
  approval channel in exec mode). `requireApproval` is not a setting; it's constitutional.
- **Memory (Section 7.1):** Refresh (or the while-app-open scheduler with catch-up-on-launch)
  pulls Linear/Slack incrementally by cursor → links tickets↔threads → LLM distill
  (heuristic fallback) → idempotent upsert → FTS5 + local embeddings. Search is
  signature-exact → BM25 → vec-KNN, RRF-merged; the UI says honestly whether semantic
  search participated.
- **Auth:** personal use rides your existing `claude` login (Agent SDK) / Codex login.
  Source tokens (Grafana/Linear/Slack) are safeStorage-encrypted into the local DB.

## Status

- **Done:** full componentized UI (7 screens + approval modal), typed IPC, SQLite schema
  + repos, sync engine + scheduler, hybrid memory search + embed worker, both provider
  adapters, investigation engine, 29 unit tests, browser + Electron verified.
- **Next:** Grafana service discovery (registry auto-draft), the Linear write client
  (post-report actually posts after approval), fix-session spawning, source-token
  validation pings, packaging (asarUnpack sqlite-vec + signing entitlement).

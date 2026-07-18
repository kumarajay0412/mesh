# Mesh AI — Ideation

## 1. The One-Line Thesis

> Move AI software development from **isolated code generation** to **organization-wide engineering orchestration** — starting with the safest, highest-frequency entry point: **investigation**.

Today, AI agents generate code. Tomorrow, they will need to reason about *systems* — graphs of repositories, services, schemas, and deployments. Mesh AI is the layer that makes that possible. But the layer is not built graph-first; it is built **wedge-first**, and the wedge is production investigation.

---

## 2. The Wedge: Investigation-First

The original Mesh concept led with cross-repo change orchestration (one intent → many synchronized PRs). That remains the destination, but it is the wrong first product:

- The write path is **high-risk** — the worst failure mode is a broken change across 8 repos.
- It requires the full org graph to exist before delivering any value.
- It is used occasionally (migrations), not daily.

Investigation inverts all three:

| Property           | Cross-repo edits (old v1)         | Investigation (new v1)                        |
| ------------------ | --------------------------------- | --------------------------------------------- |
| Risk               | High — writes across repos        | Low — read-only; worst case is a wrong hypothesis |
| Prerequisite       | Full six-layer org graph          | A service → repo mapping + observability access |
| Frequency          | Occasional (migrations)           | Daily (every on-call ticket, every alert)     |
| Trust building     | Must be trusted before first use  | Earns trust one evidence-linked report at a time |

**The insight: investigation exercises the same cross-repo knowledge that is Mesh's moat — without the scary write path.** Every investigation traverses services, repos, deploys, logs, and metrics. The knowledge Mesh accumulates doing that is exactly the substrate the write path needs later. And the write path becomes a natural *ending* to an investigation ("here's the root cause — open a fix session?") rather than a separate product asking for blind trust.

### What v1 investigation looks like

You hand Mesh a ticket (Linear), an alert, or a Grafana link. Mesh:

1. Extracts the symptoms, affected services, and time window.
2. Resolves symptoms → services → repos via its service registry.
3. Runs an agent (Claude Code or Codex CLI) armed with Grafana, Sentry, Linear, and kubectl access, plus read-only checkouts of the candidate repos, following a structured investigation runbook.
4. Produces a root-cause report where **every claim is linked to evidence** — a Grafana deeplink, a LogQL query, a commit SHA.
5. Optionally hands off to a fix session: Claude Code opened in the culprit repo with the full investigation as context.

---

## 3. The Landscape (Where Mesh Fits)

The AI-for-developers space has split into distinct layers:

| Layer                       | Example                     | Optimizes               | Mental Model                  |
| --------------------------- | --------------------------- | ----------------------- | ----------------------------- |
| **Interface / Aggregation** | Multi-model chat clients    | Human ↔ AI interaction  | "Better ChatGPT"              |
| **IDE / Single-Repo Agent** | Cursor, Copilot             | Developer ↔ single repo | "Better IDE"                  |
| **Agent Orchestration**     | Conductor                   | AI ↔ AI coordination    | "AI engineering manager"      |
| **Org-Scale Orchestration** | **Mesh AI**                 | Organization ↔ AI       | "Engineering control plane"   |

- **Aggregation tools** are an *interface* play — moat is UX and the bet that models commoditize.
- **Conductor-style tools** are an *agent management* play — workflow design for teams of agents inside a project.
- **Mesh** is an *organizational reasoning* play — the moat is the accumulated map of how the org's systems connect and how they have failed before.

There is also a direct new-competitor set for the wedge itself: AI SRE tools (incident copilots). Mesh's difference is that investigation is not the end product — it is how the organizational map gets built, one ticket at a time, on the way to org-wide change orchestration.

---

## 4. The Problem

Modern software organizations operate across dozens or hundreds of interconnected repositories, services, and deployment systems. AI coding tools operate in isolation — one repo, one branch, one developer at a time.

> **AI agents can generate code, but they cannot reason about organizational architecture.**

Today's tools are blind to:

- Which repo a misbehaving production service maps to
- Cross-repository dependencies and shared SDKs
- What was deployed when, and what changed in that window
- Downstream impact of changes
- Coordinated migrations across systems
- Persistent architectural context that survives sessions

Engineers manually do the work models should be doing: log spelunking, deploy correlation, dependency tracing, impact analysis, cross-repo synchronization. The burden grows with org size, and no system today closes the gap between **a single agent's output** and **the organization's reality**.

---

## 5. The Mesh AI Platform (v1 framing)

Four pillars, each with a deliberately small v1 form and a known production form:

### Pillar 1 — The Service Registry (v1 of the Org Graph)
Not a six-layer graph yet. A **service → repo mapping**: k8s Deployment name → container image → repo that builds it, inferred automatically and corrected by a hand-editable `services.yaml`. This is the minimum organizational knowledge investigation needs, and it is the seed the full graph grows from.

**Explicitly dropped: the ownership layer.** CODEOWNERS and service catalogs are stale in almost every real org, and in a single-user desktop app the answer to "who owns this?" is *you*. Mesh needs a lookup table, not an ownership contract.

### Pillar 2 — Investigation Memory (v1 of Architectural Memory)
Every completed investigation — symptoms, evidence, root cause, fix — is stored and retrieved when a similar ticket arrives ("this looks like INV-042, memory leak in the gRPC connection pool"). The compounding moat, achieved with a table instead of a graph.

### Pillar 3 — Agent Harness (v1 of Multi-Agent Orchestration)
Mesh does **not** build its own agent loop. Claude Code and Codex CLI already are capable investigation agents. Mesh is the harness: session management, MCP wiring (Grafana / Linear / Sentry / kubectl), the investigation runbook, steering, and evidence collection. One interactive agent per investigation in v1; fleets come later.

### Pillar 4 — Evidence Discipline (v1 of Impact & Validation)
Every claim in a report must carry a source: a Grafana deeplink, a log query, a commit SHA. This is what separates a trustworthy investigation from a hallucinated narrative — and it is the validation muscle that later gates the write path.

---

## 6. Strategic Positioning

### What Mesh is NOT
- Not another chat UI
- Not another IDE plugin
- Not a from-scratch agent runtime (providers are commodity inputs; the harness and the accumulated knowledge are the product)

### What Mesh IS
- The **control plane** above coding agents
- The **map and memory** that make any agent org-aware
- v1: the tool that turns a ticket into an evidence-linked root cause across all your repos

### The Defensible Moat
- The service registry gets richer with every investigation
- The memory gets deeper with every resolved ticket
- The integrations (Grafana, Linear, Sentry, k8s) create switching cost
- The org's operational truth accumulates inside Mesh

Closer to a **system of record** than a **tool**. Tools get replaced; systems of record get extended.

---

## 7. Philosophical Bet

| View          | Thesis                                              | Example       |
| ------------- | --------------------------------------------------- | ------------- |
| **Amplifier** | Humans stay central; AI makes them superhuman       | Cursor        |
| **Delegator** | Humans become orchestrators of autonomous agents    | Conductor     |
| **Mesh's Bet**| The bottleneck is *organizational context*, not raw model capability | Mesh AI       |

Even with perfect models, an org-blind agent cannot debug a production incident spanning three services, let alone ship safely across 50 repos. The next 10× does not come from a smarter model — it comes from giving models the **organization** as context. Investigation is how that context gets built while paying for itself from day one.

---

## 8. The Shift

```
   Isolated AI code generation
              ↓
   Org-aware AI investigation          ← v1 (the wedge)
              ↓
   Organization-wide AI engineering orchestration
```

Single-agent tools optimize the *file*. IDE-agents optimize the *repo*. Mesh AI optimizes the **organization** — starting where the organization hurts every day: production.

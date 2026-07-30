// Shared domain types — the single vocabulary used by renderer, preload and
// main. No imports, no runtime code: this file must stay dependency-free so
// both the browser bundle and the Electron main bundle can use it verbatim.

export type Stage = 'intake' | 'scope' | 'investigate' | 'report'
export const STAGES: Stage[] = ['intake', 'scope', 'investigate', 'report']

export type InvestigationStatus = 'open' | 'investigating' | 'report' | 'closed' | 'abandoned' | 'failed'
export type Confidence = 'suspected' | 'probable' | 'confirmed'
export type SourceKind = 'linear' | 'slack' | 'sentry' | 'grafana' | 'notion' | 'manual'

/* ---------------------------------------------------------------- agent -- */

/** Normalized event stream every provider adapter emits (Section 3). */
export type AgentEvent =
  | { kind: 'status'; text: string; ts: number }
  | { kind: 'stage'; stage: Stage; ts: number }
  | { kind: 'reasoning'; text: string; ts: number }
  | { kind: 'tool_call'; id: string; tool: string; title: string; args: Record<string, unknown>; ts: number }
  | { kind: 'tool_result'; id: string; ok: boolean; summary: string; detail?: string; ts: number }
  | { kind: 'finding'; text: string; evidenceId?: string; ts: number }
  | { kind: 'evidence'; evidence: EvidenceItem; ts: number }
  | { kind: 'steered'; text: string; ts: number }
  | { kind: 'error'; text: string; ts: number }
  | { kind: 'done'; ts: number }

export type EvidenceType = 'grafana' | 'logql' | 'promql' | 'kubectl' | 'commit' | 'sentry' | 'file' | 'memory'

export interface EvidenceItem {
  id: string
  type: EvidenceType
  claim: string
  source: string
  href?: string
  snippet?: string
  ts: number
}

/* ------------------------------------------------------- investigations -- */

export interface Investigation {
  id: string
  title: string
  service?: string
  status: InvestigationStatus
  stage: Stage
  confidence?: Confidence
  source: SourceKind
  ticketRef?: string
  createdAt: number
  closedAt?: number
  similarTo?: { id: string; note: string }[]
  report?: Report
  /** API spend for this investigation, summed across its provider sessions.
   *  Reported by the SDK (`total_cost_usd`) rather than computed from a price
   *  table, so it stays correct as model pricing changes. */
  cost?: InvestigationCost
}

/** What an investigation actually cost. Tokens are kept alongside the dollar
 *  figure because the split is the interesting part: cache reads bill at ~0.1x,
 *  so a large `cacheReadTokens` is the prompt-cache boundary paying for itself. */
export interface InvestigationCost {
  usd: number | null
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  turns: number
  /** sessions that predate token accounting contribute tokens but no usd */
  partial: boolean
}

/** An image the user attached to an investigation turn. Stored on disk under
 *  userData; the agent receives it as a base64 image content block. */
export interface Attachment {
  id: string
  /** image/png, image/jpeg, image/gif, image/webp */
  mediaType: string
  /** original filename, when the user dropped a file rather than pasting */
  name?: string
  bytes: number
}

export interface SuspectCommit {
  sha: string
  repo: string
  path?: string
  title: string
  author?: string
  confidence: Confidence
  signals: string[]
}

/** A small measured series the agent charted during the investigation —
 *  e.g. failed batches per day around the incident. Real numbers only. */
export interface RootCauseMetric {
  label: string
  unit?: string
  points: { x: string; y: number }[]
  /** x bucket to visually highlight (the spike / incident window) */
  highlightX?: string
  note?: string
}

export interface RootCauseService {
  name: string
  verdict: 'culprit' | 'contributing' | 'affected' | 'cleared'
  points: string[]
}

/** Structured root cause for humans: the story in bullets, a per-service
 *  breakdown, honest red herrings + unknowns, and measured charts. Optional
 *  everywhere — older reports render the hypothesis paragraph alone. */
export interface RootCauseDetail {
  points: string[]
  services?: RootCauseService[]
  redHerrings?: string[]
  unknowns?: string[]
  metrics?: RootCauseMetric[]
}

export interface Report {
  hypothesis: string
  confidence: Confidence
  culprit?: { repo: string; sha: string; path: string }
  suspects: SuspectCommit[]
  evidence: EvidenceItem[]
  timeline: { ts: number; label: string; kind: 'symptom' | 'deploy' | 'anomaly' | 'action' }[]
  suggestedFix: string
  unexplored: string[]
  /** structured, team-readable root cause (points · services · charts) */
  rootCauseDetail?: RootCauseDetail
  /** proposed operational learnings (user-gated before entering context) */
  learnings?: string[]
  /** structural discoveries — edges the system map lacks (user-gated) */
  mapUpdates?: { from: string; to: string; label?: string; kind?: MapEdge['kind'] }[]
}

/* ----------------------------------------------------------------- memory -- */

export interface MemoryRecord {
  id: string
  source: 'linear' | 'slack' | 'mesh' | 'notion'
  ticketId?: string
  identifier?: string
  slackUrl?: string
  /** general source link — a Notion page URL, so a search hit opens at origin.
   *  (slackUrl predates this and stays Slack-specific for cross-link parsing.) */
  url?: string
  title: string
  symptoms: string
  rootCause?: string
  resolution?: string
  investigationSummary?: string
  resolutionSteps?: string[]
  errorSignature?: string
  labels: string[]
  priority?: string
  reportedAt?: number
  resolvedAt?: number
  updatedAt: number
  /** cross-source sibling: the Slack thread for a Linear ticket, or vice versa */
  linkedId?: string
}

export interface MemorySearchHit {
  record: MemoryRecord
  score: number
  matched: 'signature' | 'lexical' | 'semantic' | 'hybrid'
}

export interface MemorySearchResult {
  hits: MemorySearchHit[]
  /** whether semantic (vector) search participated — false = lexical only */
  semantic: boolean
}

/* --------------------------------------------------------------- registry -- */

export interface ServiceEntry {
  name: string
  repo?: string
  namespace?: string
  source: 'inferred' | 'manual'
  aliases: string[]
  does?: string
  serving?: string
  /** observability identifiers: dashboard_uid, loki_label, tenant_key ... */
  ids: Record<string, string>
  knownSolutions: { symptom: string; fix: string; ref?: string }[]
}

/* ---------------------------------------------------------- sync + conns -- */

export type SourceId = 'grafana' | 'linear' | 'slack' | 'sentry' | 'notion'
export type ConnStatus = 'connected' | 'pending' | 'error' | 'needs-connection'

export interface ConnectionInfo {
  id: SourceId
  name: string
  status: ConnStatus
  /** live substance, not boilerplate: what this connection has actually
   *  yielded — "3,520 tickets", "2 channels · 2,300 threads", "128 pages" */
  detail: string
  /** completion time of the source's last sync — renderer formats it */
  lastSyncAt?: number
  requiredFirst?: boolean
}

export interface SyncSourceState {
  source: string
  lastRunAt?: number
  cursor?: string
  status: 'idle' | 'running' | 'error' | 'needs-connection'
  message?: string
}

export interface SyncProgressEvent {
  runId: string
  source: string
  phase: 'fetch' | 'link' | 'distill' | 'upsert' | 'done' | 'error'
  done: number
  total?: number
  message?: string
}

/* -------------------------------------------------------------- approvals -- */

export interface ApprovalRequest {
  id: string
  investigationId?: string
  tool: string
  title: string
  description: string
  payloadPreview: string
  requestedAt: number
  expiresAt: number
}

export type ApprovalOutcome = 'approved' | 'denied' | 'timeout' | 'window-closed'

/* -------------------------------------------------------------- learnings -- */

/** One line of learned operational context ("mobile upload issues → check
 *  speech-orchestrator logs in Grafana"). Proposed by the agent at report
 *  time; only user-accepted lines enter future prompts. */
export interface Learning {
  id: number
  investigationId?: string
  text: string
  status: 'proposed' | 'accepted' | 'rejected'
  createdAt: number
  decidedAt?: number
}

/** One Grafana deployment (orgs often run several). Token lives in secrets. */
export interface GrafanaInstance {
  name: string
  url: string
  hasToken: boolean
}

/* ------------------------------------------------------------ system map -- */

export type MapNodeKind = 'frontend' | 'edge' | 'backend' | 'ml' | 'external' | 'datastore' | 'infra'

export interface MapNode {
  id: string // kebab name, e.g. 'speech-orchestrator'
  label: string
  kind: MapNodeKind
  repo?: string
  grafana?: string // which instance watches it
  notes?: string
}

export interface MapEdge {
  id: number
  from: string
  to: string
  label?: string // 'ws: all dictation modes', 'GraphQL: updateNode'
  kind: 'http' | 'ws' | 'graphql' | 'queue' | 'db' | 'deploys' | 'observes' | 'other'
  status: 'accepted' | 'proposed'
}

/* ----------------------------------------------------------------- misc -- */

export interface ModelStatus {
  state: 'idle' | 'downloading' | 'ready' | 'error' | 'unavailable'
  progress?: number
  message?: string
}

export interface ProviderInfo {
  id: 'claude' | 'codex'
  label: string
  available: boolean
  authMode: 'subscription' | 'api-key'
  capabilities: { approvals: boolean; steering: boolean }
}

export type MeshPermissionMode = 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface SettingsState {
  theme?: 'dark' | 'light'
  provider: 'claude' | 'codex'
  /** model override; empty/undefined = provider default */
  model?: string
  /** reasoning effort; undefined = provider default */
  effort?: EffortLevel
  /** mirrors Claude Code: default = approve writes per action (Section 10 posture);
   *  auto/bypass are the user's explicit opt-out of that gate */
  permissionMode: MeshPermissionMode
  syncIntervalMin: number
  /** first-run tour dismissed/completed — the Tutorial button reopens it anytime */
  onboardingSeen?: boolean
  autoSync: boolean
  repoRoot: string
  /** GitHub org for repo sync; inferred from local remotes on first run */
  githubOrg?: string
  /** "context to add later" — the user's own checklist on the Knowledge Map
   *  panel; never injected into prompts */
  contextBacklog?: string[]
}

export interface IntakeInput {
  title?: string
  ticketRef?: string
  pasted?: string
}

/** Whether the Claude CLI this app runs on is signed in. Mesh uses the user's
 *  own `claude` login rather than holding an API key, so a logged-out CLI means
 *  no investigation can start — worth catching before they try. */
export interface ClaudeAuth {
  /** false when the `claude` binary isn't on PATH at all */
  installed: boolean
  loggedIn: boolean
  email?: string
  authMethod?: string
  subscriptionType?: string
  /** why we couldn't tell, when we couldn't */
  error?: string
}

/** Request to open a terminal session. `command` runs one command and keeps the
 *  shell open; omitting it gives a plain interactive login shell. */
export interface PtySpawnRequest {
  command?: string
  cwd?: string
  shell?: string
  cols?: number
  rows?: number
}

export interface PtyExit {
  id: string
  exitCode: number
  signal?: number
}

/** Provider CLI login state.
 *  - `absent`  the binary isn't installed
 *  - `none`    installed, but no account has ever been logged in
 *  - `stale`   an account exists but its token no longer refreshes (re-login)
 *  - `ok`      a token was minted just now
 *  - `unknown` the probe failed for a reason that isn't an auth problem
 *              (offline, timeout) — never nag the user on this one */
export type CliAuth = 'absent' | 'none' | 'stale' | 'ok' | 'unknown'

/** A kubectl context plus how it proves identity. Contexts that delegate to a
 *  provider CLI (GKE's gke-gcloud-auth-plugin, AKS's kubelogin) break the
 *  moment that CLI's login goes stale; contexts carrying embedded credentials
 *  keep working regardless, so they must not be flagged for a CLI re-login. */
export interface K8sContext {
  name: string
  provider: 'gcp' | 'azure' | 'other'
  /** true when reads through this context depend on `gcloud`/`az` being logged in */
  needsCliLogin: boolean
  /** the exec credential plugin this context shells out to, if any */
  execBin?: string
  /** true when that plugin isn't resolvable on PATH — reads fail with
   *  "executable … not found" even though the CLI login itself is fine */
  execBinMissing?: boolean
}

/** Local Kubernetes tooling + cluster wiring status — the Connections →
 *  Kubernetes card. Mesh stores no cloud creds; it reads what your machine
 *  already has (gcloud/az/kubectl on your own login). */
export interface K8sStatus {
  kubectl: boolean
  gcloud: boolean
  az: boolean
  /** login state of each provider CLI — drives the "run gcloud auth login" hint */
  gcloudAuth: CliAuth
  azAuth: CliAuth
  contexts: K8sContext[]
  /** true when the kubeconfig couldn't be enumerated/parsed. Suppresses any
   *  "this context doesn't exist" claim, which would otherwise be a false alarm. */
  contextsDegraded: boolean
  /** registry services that already route to a context. `contextExists` is
   *  false when the mapping points at a context the kubeconfig doesn't have —
   *  a silently broken wiring, since live reads fail with "no context exists". */
  mapped: { service: string; context: string; namespace?: string; contextExists: boolean }[]
  unmappedServices: string[] // candidate services with no k8s_context yet
}

/** One knowledge store's counter: id, human name, one-line nature, row count,
 *  and (for embedded stores) how much of it is semantically indexed. */
export interface KnowledgeStore {
  id: string
  label: string
  /** what this store IS — "distilled tickets", "verbatim pages" */
  desc: string
  count: number
  /** rows with a vector — absent for stores that aren't embedded (repos, map) */
  embedded?: number
}

/** Everything Mesh has inferred so far — the transparency view behind the
 *  Knowledge Map's "What Mesh knows" panel. */
export interface ContextSummary {
  memory: { total: number; bySource: Record<string, number>; embedded: number }
  /** local git checkouts kept fresh for the agent's blame/log reads */
  repos: { count: number; lastFetchedAt?: number }
  /** one tile per knowledge store: what it is, how many rows, how indexed */
  stores: KnowledgeStore[]
  registry: { total: number; manual: number }
  map: { nodes: number; edges: number; proposed: number }
  learnings: { accepted: number; proposed: number }
  /** the exact SYSTEM MAP block injected into every agent prompt */
  mapPrompt: string
  /** accepted learning lines, exactly as they ride in prompts */
  learningTexts: string[]
}

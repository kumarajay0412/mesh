// Shared domain types — the single vocabulary used by renderer, preload and
// main. No imports, no runtime code: this file must stay dependency-free so
// both the browser bundle and the Electron main bundle can use it verbatim.

export type Stage = 'intake' | 'scope' | 'investigate' | 'report'
export const STAGES: Stage[] = ['intake', 'scope', 'investigate', 'report']

export type InvestigationStatus = 'open' | 'investigating' | 'report' | 'closed' | 'abandoned' | 'failed'
export type Confidence = 'suspected' | 'probable' | 'confirmed'
export type SourceKind = 'linear' | 'slack' | 'sentry' | 'grafana' | 'manual'

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
  source: 'linear' | 'slack' | 'mesh'
  ticketId?: string
  identifier?: string
  slackUrl?: string
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

export type SourceId = 'grafana' | 'linear' | 'slack' | 'sentry'
export type ConnStatus = 'connected' | 'pending' | 'error' | 'needs-connection'

export interface ConnectionInfo {
  id: SourceId
  name: string
  status: ConnStatus
  detail: string
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

/** Everything Mesh has inferred so far — the transparency view behind the
 *  Knowledge Map's "What Mesh knows" panel. */
export interface ContextSummary {
  memory: { total: number; bySource: Record<string, number>; embedded: number }
  registry: { total: number; manual: number }
  map: { nodes: number; edges: number; proposed: number }
  learnings: { accepted: number; proposed: number }
  /** the exact SYSTEM MAP block injected into every agent prompt */
  mapPrompt: string
  /** accepted learning lines, exactly as they ride in prompts */
  learningTexts: string[]
}

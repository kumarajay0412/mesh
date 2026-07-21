import type {
  AgentEvent,
  ContextSummary,
  ClaudeAuth,
  K8sStatus,
  PtyExit,
  PtySpawnRequest,
  ApprovalRequest,
  ConnectionInfo,
  GrafanaInstance,
  IntakeInput,
  Investigation,
  InvestigationStatus,
  Learning,
  MapEdge,
  MapNode,
  MemorySearchResult,
  ModelStatus,
  ServiceEntry,
  SettingsState,
  SourceId,
  Stage,
  SyncProgressEvent,
  SyncSourceState,
} from '@shared/types'

/**
 * The renderer's single data boundary. Two implementations:
 *  - MockApi   — browser dev: sample data + scripted agent stream
 *  - IpcApi    — Electron: typed IPC to the main process
 * Everything above this interface (stores, components) is backend-agnostic.
 */
export interface MeshApi {
  readonly isElectron: boolean

  // investigations
  listInvestigations(): Promise<Investigation[]>
  getInvestigation(id: string): Promise<Investigation | null>
  startInvestigation(input: IntakeInput): Promise<{ id: string }>
  getTimeline(id: string): Promise<AgentEvent[]>
  steer(id: string, text: string): Promise<void>
  interrupt(id: string): Promise<void>
  abandon(id: string): Promise<void>
  /** post-report feedback ("you were wrong/right, check X") — resumes the session */
  comment(id: string, text: string): Promise<void>
  onAgentEvent(id: string, cb: (e: AgentEvent) => void): () => void
  /** stage/status transitions from the engine (report ready, abandoned, …) */
  onEngineState(cb: (s: { investigationId: string; stage: Stage; status: InvestigationStatus }) => void): () => void

  // gated report actions — must route through the approval flow
  postReportToLinear(id: string): Promise<void>
  openFixSession(id: string): Promise<void>

  // memory
  searchMemory(query: string): Promise<MemorySearchResult>
  syncStates(): Promise<SyncSourceState[]>
  refresh(sources?: string[]): Promise<{ runId: string }>
  onSyncProgress(cb: (e: SyncProgressEvent) => void): () => void
  onModelStatus(cb: (s: ModelStatus) => void): () => void

  // registry
  listServices(): Promise<ServiceEntry[]>
  saveService(entry: ServiceEntry): Promise<void>
  discoverServices(): Promise<{
    instances: { name: string; services: number; error?: string; detail?: string }[]
    discovered: number
    matchedToRepos: number
    upserted: number
  }>

  // connections
  listConnections(): Promise<ConnectionInfo[]>
  setSecret(id: SourceId, fields: Record<string, string>): Promise<{ ok: boolean; message?: string }>
  grafanaInstances(): Promise<GrafanaInstance[]>
  removeGrafanaInstance(name: string): Promise<void>
  listSlackChannels(token: string): Promise<{ ok: true; channels: { id: string; name: string; isMember: boolean }[] } | { ok: false; message: string }>

  // learned context (user-gated)
  listLearnings(status?: Learning['status']): Promise<Learning[]>
  decideLearning(id: number, accept: boolean): Promise<void>

  // system knowledge map
  getMap(): Promise<{ nodes: MapNode[]; edges: MapEdge[] }>
  saveMapNode(node: MapNode): Promise<void>
  addMapEdge(from: string, to: string, label: string | undefined, kind: MapEdge['kind']): Promise<void>
  decideMapEdge(id: number, accept: boolean): Promise<void>
  seedMapFromText(text: string): Promise<{ ok: true; nodes: number; edges: number } | { ok: false; message: string }>
  getContextSummary(): Promise<ContextSummary>
  getK8sStatus(): Promise<K8sStatus>
  getClaudeAuth(): Promise<ClaudeAuth>
  /** save the report as a self-contained HTML file; null path = cancelled */
  exportReportHtml(id: string): Promise<{ path: string | null; error?: string }>

  // embedded terminal (user-driven only — never exposed to the agent)
  ptySpawn(req: PtySpawnRequest): Promise<{ id: string } | { error: string }>
  ptyWrite(id: string, data: string): Promise<void>
  ptyResize(id: string, cols: number, rows: number): Promise<void>
  ptyKill(id: string): Promise<void>
  ptyScrollback(id: string): Promise<string>
  onPtyData(cb: (p: { id: string; chunk: string }) => void): () => void
  onPtyExit(cb: (p: PtyExit) => void): () => void

  // approvals
  onApprovalRequest(cb: (r: ApprovalRequest) => void): () => void
  respondApproval(id: string, approved: boolean, reason?: string): Promise<void>

  // settings
  getSettings(): Promise<SettingsState>
  setSettings(patch: Partial<SettingsState>): Promise<SettingsState>

  // workspace repos
  pickRepoRoot(): Promise<{ path: string | null; repos: string[] }>
  scanRepos(): Promise<{ root: string; repos: string[] }>
}

declare global {
  interface Window {
    mesh?: { isElectron: boolean; platform: string; invoke: (ch: string, args: unknown) => Promise<unknown>; on: (ch: string, cb: (payload: unknown) => void) => () => void }
  }
}

let api: MeshApi | null = null

/** Lazily picks the backend. Import `getApi()` everywhere; never construct directly. */
export async function getApi(): Promise<MeshApi> {
  if (api) return api
  if (window.mesh?.isElectron) {
    const { IpcApi } = await import('./ipc-api')
    api = new IpcApi()
  } else {
    const { MockApi } = await import('./mock-api')
    api = new MockApi()
  }
  return api
}

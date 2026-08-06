import type {
  AgentEvent,
  ApprovalRequest,
  ConnectionInfo,
  IntakeInput,
  Investigation,
  MemorySearchResult,
  ModelStatus,
  ServiceEntry,
  SettingsState,
  SourceId,
  SyncProgressEvent,
  SyncSourceState,
} from '@shared/types'
import type { Invokes, MainEvents } from '@shared/ipc'
import type { MeshApi } from './api'

function bridge() {
  const m = window.mesh
  if (!m) throw new Error('IpcApi used outside Electron')
  return m
}

function invoke<K extends keyof Invokes>(channel: K, args: Invokes[K]['args']): Promise<Invokes[K]['result']> {
  return bridge().invoke(channel, args) as Promise<Invokes[K]['result']>
}

function on<K extends keyof MainEvents>(channel: K, cb: (payload: MainEvents[K]) => void): () => void {
  return bridge().on(channel, cb as (payload: unknown) => void)
}

/** The Electron implementation of MeshApi — a thin typed veneer over IPC. */
export class IpcApi implements MeshApi {
  readonly isElectron = true

  listInvestigations(): Promise<Investigation[]> {
    return invoke('db:investigations:list', undefined)
  }
  getInvestigation(id: string): Promise<Investigation | null> {
    return invoke('db:investigations:get', { id })
  }
  startInvestigation(input: IntakeInput): Promise<{ id: string }> {
    return invoke('engine:start', input)
  }
  getTimeline(id: string): Promise<AgentEvent[]> {
    return invoke('db:events:timeline', { id })
  }
  steer(id: string, text: string): Promise<void> {
    return invoke('engine:steer', { id, text })
  }
  interrupt(id: string): Promise<void> {
    return invoke('engine:interrupt', { id })
  }
  abandon(id: string): Promise<void> {
    return invoke('engine:abandon', { id })
  }
  comment(id: string, text: string): Promise<void> {
    return invoke('engine:comment', { id, text })
  }
  onAgentEvent(id: string, cb: (e: AgentEvent) => void): () => void {
    return on('agent:event', (p) => {
      if (p.investigationId === id) cb(p.event)
    })
  }
  onEngineState(cb: (s: { investigationId: string; stage: import('@shared/types').Stage; status: Investigation['status'] }) => void): () => void {
    return on('engine:state', cb)
  }

  postReportToLinear(id: string): Promise<void> {
    return invoke('engine:postReport', { id })
  }
  openFixSession(id: string): Promise<void> {
    return invoke('engine:openFixSession', { id })
  }

  searchMemory(query: string): Promise<MemorySearchResult> {
    return invoke('memory:search', { query })
  }
  syncStates(): Promise<SyncSourceState[]> {
    return invoke('sync:states', undefined)
  }
  refresh(sources?: string[]): Promise<{ runId: string }> {
    return invoke('sync:refresh', { sources })
  }
  onSyncProgress(cb: (e: SyncProgressEvent) => void): () => void {
    return on('sync:progress', cb)
  }
  onModelStatus(cb: (s: ModelStatus) => void): () => void {
    return on('model:status', cb)
  }

  listServices(): Promise<ServiceEntry[]> {
    return invoke('registry:list', undefined)
  }
  saveService(entry: ServiceEntry): Promise<void> {
    return invoke('registry:save', { entry })
  }
  discoverServices() {
    return invoke('registry:discover', undefined)
  }

  listConnections(): Promise<ConnectionInfo[]> {
    return invoke('connections:list', undefined)
  }
  setSecret(id: SourceId, fields: Record<string, string>): Promise<{ ok: boolean; message?: string }> {
    return invoke('secrets:set', { id, fields })
  }
  grafanaInstances(): Promise<import('@shared/types').GrafanaInstance[]> {
    return invoke('grafana:instances', undefined)
  }
  removeGrafanaInstance(name: string): Promise<void> {
    return invoke('grafana:removeInstance', { name })
  }
  listSlackChannels(token: string) {
    return invoke('slack:listChannels', { token })
  }

  listLearnings(status?: import('@shared/types').Learning['status']): Promise<import('@shared/types').Learning[]> {
    return invoke('learnings:list', { status })
  }
  decideLearning(id: number, accept: boolean): Promise<void> {
    return invoke('learnings:decide', { id, accept })
  }

  getMap() {
    return invoke('map:get', undefined)
  }
  saveMapNode(node: import('@shared/types').MapNode): Promise<void> {
    return invoke('map:saveNode', { node })
  }
  addMapEdge(from: string, to: string, label: string | undefined, kind: import('@shared/types').MapEdge['kind']): Promise<void> {
    return invoke('map:addEdge', { from, to, label, kind })
  }
  decideMapEdge(id: number, accept: boolean): Promise<void> {
    return invoke('map:decideEdge', { id, accept })
  }
  seedMapFromText(text: string) {
    return invoke('map:seedFromText', { text })
  }
  getContextSummary() {
    return invoke('context:summary', undefined)
  }
  getK8sStatus() {
    return invoke('k8s:status', undefined)
  }
  getClaudeAuth() {
    return invoke('claude:auth', undefined)
  }
  openExternal(url: string) {
    return invoke('app:openExternal', { url })
  }
  listCodeGraphs() {
    return invoke('graph:list', undefined)
  }
  viewCodeGraph(repo: string, focus?: string, limit?: number) {
    return invoke('graph:view', { repo, focus, limit })
  }
  exportReportHtml(id: string) {
    return invoke('report:exportHtml', { id })
  }
  exportPack(passphrase?: string) {
    return invoke('pack:export', { passphrase })
  }
  importPack(passphrase?: string) {
    return invoke('pack:import', { passphrase })
  }

  ptySpawn(req: import('@shared/types').PtySpawnRequest) {
    return invoke('pty:spawn', req)
  }
  ptyWrite(id: string, data: string) {
    return invoke('pty:write', { id, data })
  }
  ptyResize(id: string, cols: number, rows: number) {
    return invoke('pty:resize', { id, cols, rows })
  }
  ptyKill(id: string) {
    return invoke('pty:kill', { id })
  }
  ptyScrollback(id: string) {
    return invoke('pty:scrollback', { id })
  }
  onPtyData(cb: (p: { id: string; chunk: string }) => void) {
    return on('pty:data', cb)
  }
  onPtyExit(cb: (p: import('@shared/types').PtyExit) => void) {
    return on('pty:exit', cb)
  }

  onApprovalRequest(cb: (r: ApprovalRequest) => void): () => void {
    return on('approval:request', cb)
  }
  respondApproval(id: string, approved: boolean, reason?: string): Promise<void> {
    return invoke('approval:respond', { id, approved, reason })
  }

  getSettings(): Promise<SettingsState> {
    return invoke('settings:get', undefined)
  }
  setSettings(patch: Partial<SettingsState>): Promise<SettingsState> {
    return invoke('settings:set', patch)
  }

  pickRepoRoot(): Promise<{ path: string | null; repos: string[] }> {
    return invoke('settings:pickRepoRoot', undefined)
  }
  scanRepos(): Promise<{ root: string; repos: string[] }> {
    return invoke('repos:scan', undefined)
  }
}

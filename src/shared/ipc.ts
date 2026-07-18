// Typed IPC contract — the single source of truth for both sides.
// Types only; no runtime code (the renderer bundle must not pull in Electron).
import type {
  AgentEvent,
  ApprovalOutcome,
  ConnectionInfo,
  GrafanaInstance,
  IntakeInput,
  Investigation,
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
  ApprovalRequest,
} from './types'

/** renderer → main, request/response over ipcRenderer.invoke / ipcMain.handle */
export interface Invokes {
  'db:investigations:list': { args: void; result: Investigation[] }
  'db:investigations:get': { args: { id: string }; result: Investigation | null }
  'db:events:timeline': { args: { id: string }; result: AgentEvent[] }

  'engine:start': { args: IntakeInput; result: { id: string } }
  'engine:steer': { args: { id: string; text: string }; result: void }
  'engine:interrupt': { args: { id: string }; result: void }
  'engine:abandon': { args: { id: string }; result: void }
  /** post-report feedback — resumes the session; may yield a revised report */
  'engine:comment': { args: { id: string; text: string }; result: void }
  'engine:postReport': { args: { id: string }; result: void }
  'engine:openFixSession': { args: { id: string }; result: void }

  'memory:search': { args: { query: string }; result: MemorySearchResult }
  'sync:states': { args: void; result: SyncSourceState[] }
  'sync:refresh': { args: { sources?: string[] }; result: { runId: string } }

  'registry:list': { args: void; result: ServiceEntry[] }
  'registry:save': { args: { entry: ServiceEntry }; result: void }
  'registry:discover': {
    args: void
    result: {
      instances: { name: string; services: number; error?: string; detail?: string }[]
      discovered: number
      matchedToRepos: number
      upserted: number
    }
  }

  'connections:list': { args: void; result: ConnectionInfo[] }
  'secrets:set': { args: { id: SourceId; fields: Record<string, string> }; result: { ok: boolean; message?: string } }
  'grafana:instances': { args: void; result: GrafanaInstance[] }
  'grafana:removeInstance': { args: { name: string }; result: void }

  'learnings:list': { args: { status?: Learning['status'] }; result: Learning[] }
  'learnings:decide': { args: { id: number; accept: boolean }; result: void }

  'map:get': { args: void; result: { nodes: MapNode[]; edges: MapEdge[] } }
  'map:saveNode': { args: { node: MapNode }; result: void }
  'map:addEdge': { args: { from: string; to: string; label?: string; kind: MapEdge['kind'] }; result: void }
  'map:decideEdge': { args: { id: number; accept: boolean }; result: void }

  'approval:respond': { args: { id: string; approved: boolean; reason?: string }; result: void }

  'settings:get': { args: void; result: SettingsState }
  'settings:set': { args: Partial<SettingsState>; result: SettingsState }
  /** native folder picker → sets repoRoot; returns the scan of git repos found */
  'settings:pickRepoRoot': { args: void; result: { path: string | null; repos: string[] } }
  'repos:scan': { args: void; result: { root: string; repos: string[] } }
}

/** main → renderer streams over webContents.send */
export interface MainEvents {
  'agent:event': { investigationId: string; event: AgentEvent }
  'engine:state': { investigationId: string; stage: Stage; status: Investigation['status'] }
  'sync:progress': SyncProgressEvent
  'approval:request': ApprovalRequest
  'approval:resolved': { id: string; outcome: ApprovalOutcome }
  'model:status': ModelStatus
}

export type InvokeChannel = keyof Invokes
export type EventChannel = keyof MainEvents

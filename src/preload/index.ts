// Preload — the only bridge between renderer and main. Exposes exactly two
// generic functions, both constrained to the typed channel maps in
// src/shared/ipc.ts. Built as CJS (.cjs) — safe under sandboxed renderers.
import { contextBridge, ipcRenderer } from 'electron'
import type { EventChannel, InvokeChannel } from '../shared/ipc'

// Runtime allowlists — a renderer compromised by injected content must not be
// able to invoke arbitrary channels.
const INVOKE_CHANNELS: InvokeChannel[] = [
  'db:investigations:list',
  'db:investigations:get',
  'db:events:timeline',
  'engine:start',
  'engine:steer',
  'engine:interrupt',
  'engine:abandon',
  'engine:comment',
  'engine:postReport',
  'engine:openFixSession',
  'memory:search',
  'sync:states',
  'sync:refresh',
  'registry:list',
  'registry:save',
  'registry:discover',
  'connections:list',
  'secrets:set',
  'grafana:instances',
  'grafana:removeInstance',
  'slack:listChannels',
  'map:seedFromText',
  'context:summary',
  'k8s:status',
  'claude:auth',
  'report:exportHtml',
  'app:openExternal',
  'pack:export',
  'pack:import',
  'graph:list',
  'graph:view',
  'pty:spawn',
  'pty:write',
  'pty:resize',
  'pty:kill',
  'pty:scrollback',
  'learnings:list',
  'learnings:decide',
  'map:get',
  'map:saveNode',
  'map:addEdge',
  'map:decideEdge',
  'approval:respond',
  'settings:get',
  'settings:set',
  'settings:pickRepoRoot',
  'repos:scan',
]

const EVENT_CHANNELS: EventChannel[] = [
  'agent:event',
  'engine:state',
  'sync:progress',
  'approval:request',
  'approval:resolved',
  'model:status',
  'pty:data',
  'pty:exit',
]

contextBridge.exposeInMainWorld('mesh', {
  isElectron: true,
  platform: process.platform,

  invoke: (channel: string, args: unknown): Promise<unknown> => {
    if (!INVOKE_CHANNELS.includes(channel as InvokeChannel)) {
      return Promise.reject(new Error(`mesh.invoke: channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, args)
  },

  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!EVENT_CHANNELS.includes(channel as EventChannel)) {
      throw new Error(`mesh.on: channel not allowed: ${channel}`)
    }
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})

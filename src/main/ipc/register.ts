// Registers every Invokes handler — the typed seam between renderer and main.
import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { expandHome, scanGitRepos } from '../repos/workspace'
import type { Database } from 'better-sqlite3'
import type { Invokes, MainEvents } from '../../shared/ipc'
import type { ConnectionInfo, GrafanaInstance, SourceId } from '../../shared/types'
import { learningsRepo } from '../db/repos/learnings'
import { discoverServices } from '../registry/discovery'
import { mapRepo } from '../db/repos/map'
import { investigationsRepo } from '../db/repos/investigations'
import { eventsRepo } from '../db/repos/events'
import { servicesRepo } from '../db/repos/services'
import { syncStateRepo } from '../db/repos/syncState'
import { settingsRepo } from '../db/repos/settings'
import { memoryRepo } from '../db/repos/memory'
import type { SecretStore } from '../security/secrets'
import type { ApprovalBroker } from './approvals'
import type { Engine } from '../engine/engine'
import type { Embeddings } from '../memory/embeddings'
import { searchMemory } from '../memory/search'
import { runSync, knownSources, type SyncDeps } from '../sync'
import { listChannels, friendlySlackError } from '../sync/slack'
import { EXTRACT_SYSTEM, parseMapExtraction } from '../registry/map-extract'

/** typed ipcMain.handle */
function handle<K extends keyof Invokes>(channel: K, fn: (args: Invokes[K]['args']) => Promise<Invokes[K]['result']> | Invokes[K]['result']): void {
  ipcMain.handle(channel, (_e, args) => fn(args as Invokes[K]['args']))
}

/** typed webContents.send */
export function makeEmit(win: () => BrowserWindow | null) {
  return function emit<K extends keyof MainEvents>(channel: K, payload: MainEvents[K]): void {
    const w = win()
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

export interface RegisterDeps {
  db: Database
  vecAvailable: boolean
  secrets: SecretStore
  approvals: ApprovalBroker
  engine: Engine
  embeddings: Embeddings | null
  syncDeps: SyncDeps
  win: () => BrowserWindow | null
}

const SOURCE_META: Record<SourceId, { name: string; requiredFirst?: boolean }> = {
  grafana: { name: 'Grafana', requiredFirst: true },
  linear: { name: 'Linear' },
  slack: { name: 'Slack' },
  sentry: { name: 'Sentry' },
}

export function registerIpc(deps: RegisterDeps): void {
  const { db } = deps
  const invs = investigationsRepo(db)
  const events = eventsRepo(db)
  const services = servicesRepo(db)
  const syncStates = syncStateRepo(db)
  const settings = settingsRepo(db)

  // db
  handle('db:investigations:list', () => invs.list())
  handle('db:investigations:get', ({ id }) => invs.get(id))
  handle('db:events:timeline', ({ id }) => events.timeline(id))

  // engine
  handle('engine:start', (input) => deps.engine.start(input))
  handle('engine:steer', ({ id, text }) => void deps.engine.steer(id, text))
  handle('engine:interrupt', ({ id }) => void deps.engine.interrupt(id))
  handle('engine:abandon', ({ id }) => void deps.engine.abandon(id))
  handle('engine:comment', ({ id, text }) => void deps.engine.comment(id, text))
  handle('engine:postReport', ({ id }) => deps.engine.postReport(id))
  handle('engine:openFixSession', ({ id }) => deps.engine.openFixSession(id))

  // memory + sync
  handle('memory:search', ({ query }) => searchMemory(db, deps.vecAvailable, deps.embeddings, query))
  handle('sync:states', () => {
    const known = new Set(knownSources(deps.syncDeps))
    // Prune rows for sources that no longer exist (renamed Slack channel,
    // removed integration) — dead rows would sit in the panel forever.
    // Never prune mid-run: a rename while the old source is walking would
    // orphan a live sync's state row.
    const listed = new Map<string, ReturnType<typeof syncStates.list>[number]>()
    for (const s of syncStates.list()) {
      if (!known.has(s.source) && s.status !== 'running') {
        syncStates.remove(s.source)
        continue
      }
      listed.set(s.source, s)
    }
    // ensure known sources appear even before their first run
    for (const src of known) {
      if (!listed.has(src)) {
        const ready =
          src === 'repos' ? true : src === 'linear' ? deps.secrets.has('linear.apiKey') : deps.secrets.has('slack.token')
        listed.set(src, { source: src, status: ready ? 'idle' : 'needs-connection' })
      }
    }
    return [...listed.values()]
  })
  handle('sync:refresh', ({ sources }) => runSync(deps.syncDeps, sources))

  // registry
  handle('registry:list', () => services.list())
  handle('registry:save', ({ entry }) => void services.upsert({ ...entry, source: 'manual' }))
  handle('registry:discover', () => discoverServices(db, deps.secrets))

  // connections
  handle('connections:list', () => {
    const presence = deps.secrets.presence()
    return (Object.keys(SOURCE_META) as SourceId[]).map((id): ConnectionInfo => {
      if (id === 'grafana') {
        const n = readInstances().length
        return {
          id,
          name: 'Grafana',
          requiredFirst: true,
          status: n > 0 ? 'connected' : 'needs-connection',
          detail: n > 0 ? `${n} instance${n > 1 ? 's' : ''} — manage to view` : 'not connected',
        }
      }
      const connected = !!presence[id]
      const primary = id === 'linear' ? 'linear.apiKey' : `${id}.token`
      if (connected && deps.secrets.unreadable(primary)) {
        return {
          id,
          name: SOURCE_META[id].name,
          requiredFirst: SOURCE_META[id].requiredFirst,
          status: 'error',
          detail: 'stored token unreadable (app identity changed) — re-enter it',
        }
      }
      return {
        id,
        name: SOURCE_META[id].name,
        requiredFirst: SOURCE_META[id].requiredFirst,
        status: connected ? 'connected' : 'needs-connection',
        detail: connected ? 'token stored in OS keychain' : 'not connected',
      }
    })
  })

  // grafana supports MULTIPLE instances: [{name,url}] in settings,
  // token per instance in secrets as grafana.token.<name>
  const readInstances = (): { name: string; url: string }[] => {
    const r = db.prepare(`SELECT value_json FROM settings WHERE key = 'grafana.instances'`).get() as { value_json: string } | undefined
    return r ? (JSON.parse(r.value_json) as { name: string; url: string }[]) : []
  }
  const writeInstances = (list: { name: string; url: string }[]) =>
    db.prepare(`INSERT INTO settings (key, value_json) VALUES ('grafana.instances', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify(list))

  handle('secrets:set', ({ id, fields }) => {
    if (!deps.secrets.available) return { ok: false, message: 'OS keychain encryption unavailable' }

    if (id === 'grafana' && fields.url?.trim()) {
      const url = fields.url.trim()
      const name = (fields.name?.trim() || safeHostname(url)).toLowerCase()
      const list = readInstances().filter((i) => i.name !== name)
      list.push({ name, url })
      writeInstances(list)
      if (fields.token?.trim()) deps.secrets.set(`grafana.token.${name}`, fields.token.trim())
      return { ok: true }
    }

    for (const [k, v] of Object.entries(fields)) {
      if (v?.trim()) deps.secrets.set(`${id}.${k}`, v.trim())
    }
    return { ok: true }
  })

  handle('grafana:instances', (): GrafanaInstance[] =>
    // hasToken means USABLE token — a blob that exists but can't decrypt
    // (app-identity change) must read as "no token" so the user re-enters it
    readInstances().map((i) => ({ ...i, hasToken: deps.secrets.get(`grafana.token.${i.name}`) !== null })),
  )

  handle('grafana:removeInstance', ({ name }) => {
    writeInstances(readInstances().filter((i) => i.name !== name))
    deps.secrets.remove(`grafana.token.${name}`)
  })

  // Live channel picker — token is whatever the user just typed, not yet
  // saved. A read-only conversations.list call; nothing is persisted here.
  handle('slack:listChannels', async ({ token }) => {
    try {
      return { ok: true as const, channels: await listChannels(token) }
    } catch (e) {
      return { ok: false as const, message: friendlySlackError(e) }
    }
  })

  // system knowledge map
  const map = mapRepo(db)
  handle('map:get', () => ({ nodes: map.nodes(), edges: map.edges() }))
  handle('map:saveNode', ({ node }) => void map.upsertNode(node))
  handle('map:addEdge', ({ from, to, label, kind }) => void map.addEdge(from, to, label, kind))
  handle('map:decideEdge', ({ id, accept }) => void map.decideEdge(id, accept))
  // Universal seeding: the user's own architecture description → their map.
  // Rows land as ordinary accepted nodes/edges — editable like anything else.
  handle('map:seedFromText', async ({ text }) => {
    if (!text.trim()) return { ok: false as const, message: 'paste a description first' }
    if (!deps.syncDeps.llm) return { ok: false as const, message: 'no provider available for extraction' }
    let extraction
    try {
      const raw = await deps.syncDeps.llm(EXTRACT_SYSTEM, text.slice(0, 24_000))
      extraction = parseMapExtraction(raw)
    } catch (e) {
      return { ok: false as const, message: `extraction failed: ${(e as Error).message}` }
    }
    if (!extraction) return { ok: false as const, message: 'could not extract any services from that text — try naming the services and who calls whom' }
    for (const n of extraction.nodes) map.upsertNode(n)
    for (const e of extraction.edges) map.addEdge(e.from, e.to, e.label, e.kind)
    return { ok: true as const, nodes: extraction.nodes.length, edges: extraction.edges.length }
  })

  // learnings — the user-gated context loop
  const learnings = learningsRepo(db)
  handle('learnings:list', ({ status }) => learnings.list(status))
  handle('learnings:decide', ({ id, accept }) => {
    learnings.decide(id, accept)
    if (accept) void deps.embeddings?.drainPending() // vectorize for relevance selection
  })

  // approvals
  handle('approval:respond', ({ id, approved, reason }) => void deps.approvals.respond(id, approved, reason))

  // settings
  handle('settings:get', () => settings.get())
  handle('settings:set', (patch) => settings.set(patch))

  // workspace repos
  handle('settings:pickRepoRoot', async () => {
    const w = deps.win()
    const res = w
      ? await dialog.showOpenDialog(w, {
          title: 'Choose the folder that holds your repos',
          defaultPath: expandHome(settings.get().repoRoot),
          properties: ['openDirectory'],
        })
      : { canceled: true, filePaths: [] as string[] }
    if (res.canceled || res.filePaths.length === 0) return { path: null, repos: [] }
    const path = res.filePaths[0]
    settings.set({ repoRoot: path })
    return { path, repos: scanGitRepos(path) }
  })

  handle('repos:scan', () => {
    const root = settings.get().repoRoot
    return { root, repos: scanGitRepos(root) }
  })

  // memory count is cheap context for the sidebar — piggyback on sync:states? kept simple for now
  void memoryRepo // (referenced by search + sync paths)
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.split('.')[0]
  } catch {
    return 'default'
  }
}

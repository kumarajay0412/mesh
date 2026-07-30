// Registers every Invokes handler — the typed seam between renderer and main.
import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { expandHome, scanGitRepos } from '../repos/workspace'
import type { Database } from 'better-sqlite3'
import type { Invokes, MainEvents } from '../../shared/ipc'
import type { ConnectionInfo, GrafanaInstance, SourceId } from '../../shared/types'
import { learningsRepo } from '../db/repos/learnings'
import { discoverServices } from '../registry/discovery'
import { k8sStatus } from '../registry/k8s-status'
import { claudeAuth } from '../providers/claude-auth'
import { renderReportHtml } from '../engine/report-html'
import { createPtyHost } from '../terminal/pty'
import { mapRepo } from '../db/repos/map'
import { investigationsRepo } from '../db/repos/investigations'
import { eventsRepo } from '../db/repos/events'
import { servicesRepo } from '../db/repos/services'
import { syncStateRepo } from '../db/repos/syncState'
import { sessionsRepo } from '../db/repos/sessions'
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
  notion: { name: 'Notion' },
}

/** Set once registerIpc runs; main uses it to kill terminals on quit. */
let ptyHost: ReturnType<typeof createPtyHost> | null = null
export const getPtyHost = () => ptyHost

export function registerIpc(deps: RegisterDeps): void {
  const { db } = deps
  const invs = investigationsRepo(db)
  const events = eventsRepo(db)
  const services = servicesRepo(db)
  const syncStates = syncStateRepo(db)
  const settings = settingsRepo(db)

  // db
  // Cost rides along with the investigation so the list can show spend without
  // a second round trip. Summed from the session ledger, which records the
  // SDK's own total_cost_usd — never a local price table.
  const sessions = sessionsRepo(db)
  handle('db:investigations:list', () => {
    const cost = sessions.costByInvestigation()
    return invs.list().map((i) => ({ ...i, cost: cost.get(i.id) }))
  })
  handle('db:investigations:get', ({ id }) => {
    const i = invs.get(id)
    return i ? { ...i, cost: sessions.costByInvestigation().get(id) } : null
  })
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
          src === 'repos'
            ? true
            : src === 'linear'
              ? deps.secrets.has('linear.apiKey')
              : src === 'notion'
                ? deps.secrets.has('notion.token')
                : deps.secrets.has('slack.token')
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

  // connections — each card reports what the connection has actually yielded
  // (counts from memory, channels from config, sync recency), not boilerplate.
  // All cheap indexed queries; recomputed per open of the screen.
  handle('connections:list', () => {
    const presence = deps.secrets.presence()
    const memCounts = new Map(
      (db.prepare('SELECT source, COUNT(*) c FROM memory GROUP BY source').all() as { source: string; c: number }[]).map((r) => [r.source, r.c]),
    )
    const syncBySource = new Map(syncStates.list().map((st) => [st.source, st]))
    const lastSyncOf = (prefixOrName: string): number | undefined => {
      let max: number | undefined
      for (const [src, st] of syncBySource) {
        if (src === prefixOrName || src.startsWith(`${prefixOrName}:`)) {
          if (st.lastRunAt && (!max || st.lastRunAt > max)) max = st.lastRunAt
        }
      }
      return max
    }
    const fmt = (x: number) => x.toLocaleString('en-US')

    return (Object.keys(SOURCE_META) as SourceId[]).map((id): ConnectionInfo => {
      if (id === 'grafana') {
        const instances = readInstances().length
        const svcCount = (db.prepare('SELECT COUNT(*) c FROM services').get() as { c: number }).c
        return {
          id,
          name: 'Grafana',
          requiredFirst: true,
          status: instances > 0 ? 'connected' : 'needs-connection',
          detail: instances > 0 ? `${instances} instance${instances > 1 ? 's' : ''} · ${fmt(svcCount)} services discovered` : 'not connected',
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
      if (!connected) {
        return { id, name: SOURCE_META[id].name, requiredFirst: SOURCE_META[id].requiredFirst, status: 'needs-connection', detail: 'not connected' }
      }

      let detail = 'token stored in OS keychain'
      let lastSyncAt: number | undefined
      if (id === 'linear') {
        detail = `${fmt(memCounts.get('linear') ?? 0)} tickets in memory`
        lastSyncAt = lastSyncOf('linear')
      } else if (id === 'slack') {
        const channels = (deps.secrets.get('slack.channel') ?? '').split(',').map((c) => c.trim()).filter(Boolean)
        const threads = memCounts.get('slack') ?? 0
        detail = channels.length
          ? `${channels.length} channel${channels.length > 1 ? 's' : ''} · ${fmt(threads)} threads in memory`
          : 'token stored — pick channels to sync'
        lastSyncAt = lastSyncOf('slack')
      } else if (id === 'notion') {
        const pages = memCounts.get('notion') ?? 0
        lastSyncAt = lastSyncOf('notion')
        // 0 pages after a completed sync is the classic unshared-integration
        // state — say so instead of looking healthy-but-empty.
        detail = pages > 0 ? `${fmt(pages)} pages in memory` : lastSyncAt ? '0 pages — share pages with the integration in Notion' : 'connected — first sync pending'
      } else if (id === 'sentry') {
        detail = 'live issue/event tools in every agent session'
      }
      return { id, name: SOURCE_META[id].name, requiredFirst: SOURCE_META[id].requiredFirst, status: 'connected', detail, lastSyncAt }
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

  // Connections → Kubernetes: probes local gcloud/az/kubectl and maps the
  // registry onto kubectl contexts. Read-only; no cloud creds are stored.
  handle('k8s:status', () => k8sStatus(db))

  handle('report:exportHtml', async ({ id }) => {
    const inv = invs.get(id)
    if (!inv?.report) return { path: null, error: 'no report on this investigation yet' }
    const withCost = { ...inv, cost: sessions.costByInvestigation().get(id) }
    const w = deps.win()
    const safe = `${id}-${inv.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
    const picked = await dialog.showSaveDialog(w ?? undefined!, {
      title: 'Export incident report',
      defaultPath: `${safe}.html`,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    })
    if (picked.canceled || !picked.filePath) return { path: null }
    await writeFile(picked.filePath, renderReportHtml(withCost, inv.report, Date.now()), 'utf8')
    return { path: picked.filePath }
  })

  // Only ever called with the hardcoded provider URLs in token-guides.ts (and
  // the user's own Grafana host), but validate anyway: openExternal hands the
  // string to the OS, so a non-http scheme can launch a handler rather than a
  // browser. Deny by default, same posture as the rest of the app.
  handle('app:openExternal', async ({ url }) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, error: 'not a URL' }
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, error: `refused to open ${parsed.protocol} — only http(s)` }
    }
    await shell.openExternal(parsed.toString())
    return { ok: true }
  })

  handle('claude:auth', () => claudeAuth())

  // Embedded terminal. Every one of these is reached only from a renderer user
  // gesture — the agent has no tool that touches them (see terminal/pty.ts).
  const emitEvent = makeEmit(deps.win)
  const pty = createPtyHost({
    data: (p) => emitEvent('pty:data', p),
    exit: (p) => emitEvent('pty:exit', p),
  })
  ptyHost = pty
  handle('pty:spawn', (req) => pty.spawn(req))
  handle('pty:write', ({ id, data }) => pty.write(id, data))
  handle('pty:resize', ({ id, cols, rows }) => pty.resize(id, cols, rows))
  handle('pty:kill', ({ id }) => pty.kill(id))
  handle('pty:scrollback', ({ id }) => pty.scrollback(id))

  // "What Mesh knows" — totals for every inferred store, plus the exact
  // text that rides in prompts. Read-only aggregation; nothing cached.
  handle('context:summary', () => {
    const bySourceRows = db.prepare('SELECT source, COUNT(*) c FROM memory GROUP BY source').all() as { source: string; c: number }[]
    const embedded = (db.prepare('SELECT COUNT(*) c FROM memory WHERE embedded = 1').get() as { c: number }).c
    const manual = (db.prepare(`SELECT COUNT(*) c FROM services WHERE source = 'manual'`).get() as { c: number }).c
    const edges = map.edges()
    const accepted = learnings.list('accepted')
    const repoRow = db.prepare('SELECT COUNT(*) c, MAX(last_fetched_at) m FROM repos').get() as { c: number; m: number | null }
    // Per-store counters — memory sources split by pipeline (distilled incident
    // vs verbatim corpus), then the derived stores. Embedded counts come from
    // the same GROUP BY so the tiles show indexing progress during a drain.
    const memStats = new Map(
      (db.prepare('SELECT source, COUNT(*) c, SUM(embedded) e FROM memory GROUP BY source').all() as { source: string; c: number; e: number }[]).map(
        (r) => [r.source, r],
      ),
    )
    const learningsEmbedded = (db.prepare('SELECT COUNT(*) c FROM learnings WHERE status = ? AND embedded = 1').get('accepted') as { c: number }).c
    const nodes = map.nodes().length
    const mem = (source: string, label: string, desc: string) => {
      const r = memStats.get(source)
      return { id: source, label, desc, count: r?.c ?? 0, embedded: r?.e ?? 0 }
    }
    const stores = [
      mem('linear', 'Linear tickets', 'distilled incidents — symptoms → root cause → fix'),
      mem('slack', 'Slack threads', 'distilled incident discussions'),
      mem('notion', 'Notion pages', 'verbatim knowledge corpus, linked to source'),
      mem('mesh', 'Mesh investigations', 'the agent\u2019s own past reports (unverified)'),
      { id: 'learnings', label: 'Learnings', desc: 'accepted operational rules, injected by relevance', count: accepted.length, embedded: learningsEmbedded },
      { id: 'services', label: 'Services', desc: 'registry — what runs where, how to query it', count: services.list().length },
      { id: 'map', label: 'Map edges', desc: `system topology across ${nodes} nodes`, count: edges.filter((e) => e.status === 'accepted').length },
      { id: 'repos', label: 'Git repos', desc: 'local checkouts for blame/log', count: repoRow.c },
    ]
    return {
      stores,
      memory: {
        total: bySourceRows.reduce((a, r) => a + r.c, 0),
        bySource: Object.fromEntries(bySourceRows.map((r) => [r.source, r.c])),
        embedded,
      },
      repos: { count: repoRow.c, lastFetchedAt: repoRow.m ?? undefined },
      registry: { total: services.list().length, manual },
      map: {
        nodes: map.nodes().length,
        edges: edges.filter((e) => e.status === 'accepted').length,
        proposed: edges.filter((e) => e.status === 'proposed').length,
      },
      learnings: { accepted: accepted.length, proposed: learnings.list('proposed').length },
      mapPrompt: map.promptText(),
      learningTexts: accepted.map((l) => l.text),
    }
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

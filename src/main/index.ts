// Electron main — window + wiring only; all logic lives in the modules.
import { app, BrowserWindow } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './db'
import { secretStore } from './security/secrets'
import { ApprovalBroker } from './ipc/approvals'
import { Engine } from './engine/engine'
import { Embeddings } from './memory/embeddings'
import { getProvider } from './providers'
import { settingsRepo } from './db/repos/settings'
import { eventsRepo } from './db/repos/events'
import { syncStateRepo } from './db/repos/syncState'
import { registerIpc, makeEmit, getPtyHost } from './ipc/register'
import { runSync, knownSources, type SyncDeps } from './sync'
import { startScheduler } from './sync/scheduler'
import { setDockIcon } from './dock-icon'
import { applyStaticPathExtras, resolveShellPath } from './shell-path'
import { discoverServices } from './registry/discovery'
import { servicesRepo } from './db/repos/services'
import { log } from './log'

const __dirname = dirname(fileURLToPath(import.meta.url))
const l = log('main')
const DEV_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'

// PIN the data directory. userData defaults to the app's display name — which
// changed when the dev bundle was branded "Mesh" — silently pointing the app
// at a fresh empty folder. The database lives at mesh-ai, permanently,
// independent of branding or packaging.
app.setPath('userData', join(app.getPath('appData'), 'mesh-ai'))

// Single instance per mesh.db. The lock lives in userData (pinned above), so a
// second copy — the dev build AND the packaged DMG both point here — is refused
// and quits. Without this, two schedulers walk the same DB concurrently:
// duplicate API spend, and one boot's resetStale() un-marks the other's live
// run. Must come AFTER setPath so the lock is scoped to the shared data dir.
if (!app.requestSingleInstanceLock()) {
  l.warn('another Mesh instance already owns this data directory — quitting')
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  const w = BrowserWindow.getAllWindows()[0]
  if (w) {
    if (w.isMinimized()) w.restore()
    w.focus()
  }
})

// Finder-launched apps inherit a bare PATH (/usr/bin:/bin) — the spawns that
// power repo sync (gh, git), Codex, npx-based MCP servers and the cluster CLIs
// would silently vanish in the packaged app. Apply the static extras now (some
// spawns happen before app-ready) and widen to the login shell's PATH in
// whenReady, so tools in less-guessable places (~/google-cloud-sdk/bin, nvm,
// asdf) are found too — otherwise Mesh reports them as "not installed".
applyStaticPathExtras()

let win: BrowserWindow | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0e0e0e',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (app.isPackaged) void win.loadFile(join(__dirname, '../dist/renderer/index.html'))
  else void win.loadURL(DEV_URL)
}

app.whenReady().then(() => {
  // Widen PATH to the login shell's before anything probes for CLIs. Fire and
  // forget: the static extras already applied cover the common cases, so no
  // startup latency is spent waiting on a user's slow shell rc.
  void resolveShellPath()

  // — data layer
  const dbPath = join(app.getPath('userData'), 'mesh.db')
  const { handle: db, vecAvailable } = openDb(dbPath)
  l.info(`db open at ${dbPath} (vec: ${vecAvailable})`)
  const secrets = secretStore(db)
  const settings = settingsRepo(db)
  const events = eventsRepo(db)
  syncStateRepo(db).resetStale() // crash recovery: a killed run must not wedge the scheduler

  // Self-populating registry: when it's empty but Grafana is connected,
  // run discovery at boot — no button required on first setup.
  if (servicesRepo(db).list().length === 0) {
    void discoverServices(db, secrets).then((r) => {
      if (r.discovered > 0) l.info(`boot discovery: ${r.discovered} services, ${r.matchedToRepos} matched to repos`)
      for (const i of r.instances) if (i.error) l.warn(`boot discovery ${i.name}: ${i.error}`)
    })
  }

  const emit = makeEmit(() => win)

  // — embeddings worker (never blocks launch; search is lexical until ready)
  const embeddings = new Embeddings(db, vecAvailable, (s) => emit('model:status', s))
  embeddings.start()

  // — approvals (Section 10): timeout-deny; deny-all on close/quit
  const approvals = new ApprovalBroker(
    (r) => emit('approval:request', r),
    (id, outcome) => emit('approval:resolved', { id, outcome }),
    (invId, type, payload) => invId && events.append(invId, type, payload),
  )

  // — provider factory reads the user's current choice
  const provider = () => getProvider(settings.get().provider)

  // — investigation engine
  const engine = new Engine({
    db,
    vecAvailable,
    embeddings,
    provider,
    approvals,
    secrets,
    emitAgentEvent: (investigationId, event) => emit('agent:event', { investigationId, event }),
    emitState: (investigationId, stage, status) => emit('engine:state', { investigationId, stage, status }),
  })

  // — sync: distill uses the same provider one-shot; degrade to heuristics without it
  const syncDeps: SyncDeps = {
    db,
    secrets,
    llm: async (system, prompt) => provider().oneShot(system, prompt),
    emit: (e) => emit('sync:progress', e),
    onIngested: () => void embeddings.drainPending(),
  }

  registerIpc({ db, vecAvailable, secrets, approvals, engine, embeddings, syncDeps, win: () => win })

  // — auto-sync: catch-up on launch + interval while open (honest cron, Section 7.1)
  const stopScheduler = startScheduler(db, (sources) => void runSync(syncDeps, sources), () => knownSources(syncDeps))

  createWindow()
  void setDockIcon()

  // The worker's 'ready' often fires before the renderer subscribes (boot
  // race) — and dev reloads resubscribe from scratch. Re-emit current state
  // every time the page is (re)loaded so the UI never shows a stale pill.
  win?.webContents.on('did-finish-load', () => {
    emit('model:status', embeddings.currentStatus)
  })

  win?.on('closed', () => {
    approvals.denyAll('window-closed') // never leave a canUseTool promise dangling
    win = null
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    approvals.denyAll('window-closed')
    engine.shutdown()
    getPtyHost()?.disposeAll() // don't leave orphaned login shells behind
    stopScheduler()
    embeddings.stop()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

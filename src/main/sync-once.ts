// Headless one-shot sync — runs the REAL runSync path outside the UI, so a
// source can be refreshed (or diagnosed) without the window.
//   npm run sync:once -- linear            # one source
//   npm run sync:once                      # every known source
// Identity must match the app's or safeStorage cannot read the tokens: the
// keychain key is named after the app ("Mesh Safe Storage"), and the DB lives
// at the pinned userData path.
import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { openDb } from './db'
import { secretStore } from './security/secrets'
import { getProvider } from './providers'
import { settingsRepo } from './db/repos/settings'
import { runSync, knownSources, type SyncDeps } from './sync'

app.setName('Mesh')
app.setPath('userData', join(app.getPath('appData'), 'mesh-ai'))

if (process.platform === 'darwin') {
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', join(process.env.HOME ?? '', '.local/bin')]
  process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':'), ...extras])].filter(Boolean).join(':')
}

await app.whenReady()

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const { handle: db } = openDb(join(app.getPath('userData'), 'mesh.db'))
const secrets = secretStore(db)

if (!safeStorage.isEncryptionAvailable()) {
  console.error('safeStorage unavailable — cannot read tokens')
  app.exit(1)
}

const settings = settingsRepo(db).get()
const provider = getProvider(settings.provider)

const deps: SyncDeps = {
  db,
  secrets,
  llm: (system, prompt) => provider.oneShot(system, prompt),
  emit: (e) => {
    if (e.phase === 'done' || e.phase === 'error') {
      console.log(`[${e.source}] ${e.phase} — ${e.done}${e.total ? `/${e.total}` : ''} ${e.message ?? ''}`)
    } else if (e.done % 25 === 0) {
      console.log(`[${e.source}] ${e.phase} ${e.done}${e.total ? `/${e.total}` : ''}`)
    }
  },
}

const targets = only.length ? only : knownSources(deps)
console.log(`syncing: ${targets.join(', ')}`)
await runSync(deps, targets)

// runSync fires sources concurrently and returns immediately; wait for the
// ledger to settle rather than guessing a duration.
const settled = async (): Promise<void> => {
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500))
    const running = db
      .prepare(`SELECT COUNT(*) c FROM sync_state WHERE source IN (${targets.map(() => '?').join(',')}) AND status = 'running'`)
      .get(...targets) as { c: number }
    if (running.c === 0) return
  }
}
await settled()

for (const t of targets) {
  const s = db.prepare('SELECT status, message, cursor FROM sync_state WHERE source = ?').get(t) as
    | { status: string; message: string | null; cursor: string | null }
    | undefined
  const n = db.prepare(`SELECT COUNT(*) c FROM memory WHERE source = ?`).get(t.split(':')[0]) as { c: number }
  console.log(`\n${t}: status=${s?.status} rows=${n.c}${s?.cursor ? ` cursor=${s.cursor}` : ''}${s?.message ? `\n  → ${s.message}` : ''}`)
}

app.exit(0)

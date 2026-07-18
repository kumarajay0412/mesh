// Auto-sync scheduler — deliberately a setTimeout chain, not cron:
// cron expressions add nothing here (nothing can fire while the app is
// closed either way). Honest model (Section 7.1): runs while the app is open,
// CATCHES UP ON LAUNCH for time it was closed, re-checks after sleep.
import { powerMonitor } from 'electron'
import type { Database } from 'better-sqlite3'
import { syncStateRepo } from '../db/repos/syncState'
import { settingsRepo } from '../db/repos/settings'
import { log } from '../log'

const l = log('scheduler')
const TICK_MS = 60_000

export function startScheduler(db: Database, kick: (sources?: string[]) => void, sources: () => string[]): () => void {
  const states = syncStateRepo(db)
  const settings = settingsRepo(db)
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const overdue = (): string[] => {
    const s = settings.get()
    if (!s.autoSync) return []
    const intervalMs = s.syncIntervalMin * 60_000
    const nowTs = Date.now()
    return sources().filter((src) => {
      const st = states.get(src)
      if (st.status === 'running' || st.status === 'needs-connection') return false
      return !st.lastRunAt || nowTs - st.lastRunAt >= intervalMs
    })
  }

  const tick = () => {
    if (stopped) return
    const due = overdue()
    if (due.length > 0) {
      l.info('auto-sync due:', due.join(', '))
      kick(due)
    }
    timer = setTimeout(tick, TICK_MS) // chain, not setInterval — no overlap, no drift pileup
  }

  // catch-up on launch: anything overdue syncs immediately
  tick()

  // macOS sleep freezes timers — re-check the moment we're back
  const onResume = () => {
    l.info('system resumed — checking for overdue syncs')
    const due = overdue()
    if (due.length > 0) kick(due)
  }
  powerMonitor.on('resume', onResume)

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    powerMonitor.removeListener('resume', onResume)
  }
}

import type { Database } from 'better-sqlite3'
import type { SettingsState } from '../../../shared/types'

const MODES = new Set(['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'])

const DEFAULTS: SettingsState = {
  theme: 'dark',
  provider: 'claude',
  permissionMode: 'default', // approve-per-write stays the default posture (Section 10)
  syncIntervalMin: 30,
  autoSync: true,
  repoRoot: '~/mesh/repos',
}

export function settingsRepo(db: Database) {
  return {
    get(): SettingsState {
      const rows = db.prepare('SELECT key, value_json FROM settings').all() as { key: string; value_json: string }[]
      const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]))
      const merged = { ...DEFAULTS, ...stored } as SettingsState
      if (!MODES.has(merged.permissionMode)) merged.permissionMode = 'default'
      return merged
    },

    set(patch: Partial<SettingsState>): SettingsState {
      const stmt = db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'permissionMode' && !MODES.has(v as string)) continue
        stmt.run(k, JSON.stringify(v))
      }
      return this.get()
    },
  }
}

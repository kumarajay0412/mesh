import { safeStorage } from 'electron'
import type { Database } from 'better-sqlite3'
import { secretsRepo } from '../db/repos/secrets'
import { log } from '../log'

const l = log('secrets')

/**
 * safeStorage-backed secret store (Section 10): plaintext exists only in memory,
 * encrypted with the OS keychain key before it touches the DB blob column.
 * Secret ids are namespaced: `grafana.url`, `grafana.token`, `linear.apiKey`…
 */
export function secretStore(db: Database) {
  const repo = secretsRepo(db)
  const available = safeStorage.isEncryptionAvailable()
  if (!available) l.warn('safeStorage encryption unavailable — secrets cannot be saved on this system')

  return {
    available,

    set(id: string, value: string): void {
      if (!available) throw new Error('OS keychain encryption unavailable')
      repo.set(id, safeStorage.encryptString(value))
    },

    get(id: string): string | null {
      const blob = repo.get(id)
      if (!blob) return null
      try {
        return safeStorage.decryptString(blob)
      } catch (e) {
        l.error(`decrypt failed for ${id}:`, (e as Error).message)
        return null
      }
    },

    has(id: string): boolean {
      return repo.has(id)
    },

    remove(id: string): void {
      repo.remove(id)
    },

    /** Blob exists but can't decrypt = stored under a different app identity's
     *  key (rename fallout) — the token must be re-entered. */
    unreadable(id: string): boolean {
      return repo.has(id) && this.get(id) === null
    },

    /** every stored secret id — for the team-pack export */
    ids(): string[] {
      return repo.ids()
    },

    /** which sources have at least one stored field, e.g. { grafana: true } */
    presence(): Record<string, boolean> {
      const out: Record<string, boolean> = {}
      for (const id of repo.ids()) out[id.split('.')[0]] = true
      return out
    },
  }
}

export type SecretStore = ReturnType<typeof secretStore>

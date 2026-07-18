import type { Database } from 'better-sqlite3'

/** Raw encrypted-blob storage. Encryption/decryption lives in
 *  security/secrets.ts (safeStorage) — this repo never sees plaintext. */
export function secretsRepo(db: Database) {
  return {
    set(id: string, blob: Buffer): void {
      db.prepare(
        'INSERT INTO secrets (id, blob, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at',
      ).run(id, blob, Date.now())
    },

    get(id: string): Buffer | null {
      const r = db.prepare('SELECT blob FROM secrets WHERE id = ?').get(id) as { blob: Buffer } | undefined
      return r?.blob ?? null
    },

    has(id: string): boolean {
      return !!db.prepare('SELECT 1 FROM secrets WHERE id = ?').get(id)
    },

    ids(): string[] {
      return (db.prepare('SELECT id FROM secrets').all() as { id: string }[]).map((r) => r.id)
    },

    remove(id: string): void {
      db.prepare('DELETE FROM secrets WHERE id = ?').run(id)
    },
  }
}

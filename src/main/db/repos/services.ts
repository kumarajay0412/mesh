import type { Database } from 'better-sqlite3'
import type { ServiceEntry } from '../../../shared/types'

interface Row {
  name: string
  repo: string | null
  namespace: string | null
  source: string
  aliases_json: string
  does: string | null
  serving: string | null
  ids_json: string
  known_solutions_json: string
}

function toEntry(r: Row): ServiceEntry {
  return {
    name: r.name,
    repo: r.repo ?? undefined,
    namespace: r.namespace ?? undefined,
    source: r.source as ServiceEntry['source'],
    aliases: JSON.parse(r.aliases_json),
    does: r.does ?? undefined,
    serving: r.serving ?? undefined,
    ids: JSON.parse(r.ids_json),
    knownSolutions: JSON.parse(r.known_solutions_json),
  }
}

export function servicesRepo(db: Database) {
  return {
    list(): ServiceEntry[] {
      return (db.prepare('SELECT * FROM services ORDER BY name').all() as Row[]).map(toEntry)
    },

    get(name: string): ServiceEntry | null {
      const r = db.prepare('SELECT * FROM services WHERE name = ?').get(name) as Row | undefined
      return r ? toEntry(r) : null
    },

    /** Manual always wins: an inferred write never overwrites a manual row (Section 4). */
    upsert(entry: ServiceEntry): void {
      const existing = this.get(entry.name)
      if (existing?.source === 'manual' && entry.source === 'inferred') return
      db.prepare(
        `INSERT INTO services (name, repo, namespace, source, aliases_json, does, serving, ids_json, known_solutions_json, updated_at)
         VALUES (@name, @repo, @namespace, @source, @aliases, @does, @serving, @ids, @known, @updatedAt)
         ON CONFLICT(name) DO UPDATE SET
           repo = excluded.repo, namespace = excluded.namespace, source = excluded.source,
           aliases_json = excluded.aliases_json, does = excluded.does, serving = excluded.serving,
           ids_json = excluded.ids_json, known_solutions_json = excluded.known_solutions_json,
           updated_at = excluded.updated_at`,
      ).run({
        name: entry.name,
        repo: entry.repo ?? null,
        namespace: entry.namespace ?? null,
        source: entry.source,
        aliases: JSON.stringify(entry.aliases),
        does: entry.does ?? null,
        serving: entry.serving ?? null,
        ids: JSON.stringify(entry.ids),
        known: JSON.stringify(entry.knownSolutions),
        updatedAt: Date.now(),
      })
    },

    /** Resolve a raw mention ("payments is down") → service via name/alias (Section 4). */
    resolveMention(mention: string): ServiceEntry | null {
      const m = mention.toLowerCase()
      for (const s of this.list()) {
        if (s.name.toLowerCase() === m) return s
        if (s.aliases.some((a) => a.toLowerCase() === m)) return s
      }
      for (const s of this.list()) {
        if (m.includes(s.name.toLowerCase())) return s
        if (s.aliases.some((a) => m.includes(a.toLowerCase()))) return s
      }
      return null
    },
  }
}

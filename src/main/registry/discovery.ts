// Service discovery (architecture Section 2.1, finally real): for each
// connected Grafana instance, pull Loki label values (app / service_name),
// match them against local repo checkouts, and draft INFERRED registry
// entries. Manual entries always win (servicesRepo enforces it).
import type { Database } from 'better-sqlite3'
import { servicesRepo } from '../db/repos/services'
import { settingsRepo } from '../db/repos/settings'
import type { SecretStore } from '../security/secrets'
import { expandHome, scanGitRepos } from '../repos/workspace'
import { log } from '../log'

const l = log('registry:discover')

export interface DiscoveryResult {
  instances: { name: string; services: number; error?: string; detail?: string }[]
  discovered: number
  matchedToRepos: number
  upserted: number
}

/** Labels that commonly carry the service name, tried in order. */
const SERVICE_LABELS = ['app', 'service_name', 'service', 'job', 'container', 'app_kubernetes_io_name']

interface GrafanaInstanceCfg {
  name: string
  url: string
}

function readInstances(db: Database): GrafanaInstanceCfg[] {
  const r = db.prepare(`SELECT value_json FROM settings WHERE key = 'grafana.instances'`).get() as { value_json: string } | undefined
  return r ? (JSON.parse(r.value_json) as GrafanaInstanceCfg[]) : []
}

async function gfetch(base: string, token: string, path: string): Promise<unknown> {
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.json()
}

/** All service-ish label values from every Loki datasource, with a debug
 *  trail: which datasources exist, which labels yielded what. */
async function lokiServiceNames(base: string, token: string): Promise<{ names: Set<string>; debug: string }> {
  const dss = (await gfetch(base, token, '/api/datasources')) as { id: number; uid: string; type: string; name: string }[]
  const lokis = dss.filter((d) => d.type === 'loki')
  const names = new Set<string>()
  const counts: string[] = []
  // Loki wants an explicit range on label queries in some versions — last 7d.
  const end = Date.now() * 1e6
  const start = end - 7 * 24 * 3600 * 1e9
  const range = `?start=${start}&end=${end}`

  for (const ds of lokis) {
    for (const label of SERVICE_LABELS) {
      let values: string[] = []
      try {
        const r = (await gfetch(base, token, `/api/datasources/uid/${ds.uid}/resources/loki/api/v1/label/${label}/values${range}`)) as { data?: string[] }
        values = r.data ?? []
      } catch {
        try {
          // legacy proxy path (older Grafana)
          const r = (await gfetch(base, token, `/api/datasources/proxy/${ds.id}/loki/api/v1/label/${label}/values${range}`)) as { data?: string[] }
          values = r.data ?? []
        } catch (e2) {
          l.warn(`${ds.name}/${label}:`, (e2 as Error).message)
        }
      }
      if (values.length) counts.push(`${label}:${values.length}`)
      for (const v of values) names.add(v)
    }
  }
  const debug = `${dss.length} datasources (${lokis.length} loki: ${lokis.map((d) => d.name).join(', ') || 'none'}) · ${counts.join(' ') || 'no label values'}`
  return { names, debug }
}

/** service name ↔ repo folder matching, strict → fuzzy. */
export function matchRepo(service: string, repos: string[]): string | undefined {
  const s = service.toLowerCase()
  const norm = (x: string) => x.toLowerCase().replace(/[-_]/g, '')
  return (
    repos.find((r) => r.toLowerCase() === s) ??
    repos.find((r) => norm(r) === norm(s)) ??
    repos.find((r) => norm(r) === norm(s) + 'service' || norm(r) + 'service' === norm(s)) ??
    repos.find((r) => norm(s).includes(norm(r)) || norm(r).includes(norm(s)))
  )
}

/** Should boot run discovery without being asked?
 *
 *  Two states qualify:
 *  · empty registry — first setup, nothing to show yet
 *  · populated registry where NOTHING maps to a repo even though local clones
 *    exist. That is not a plausible steady state (infra pods never map, but
 *    every org has *some* service named after its repo) — it means discovery
 *    last ran before repoRoot was set (e.g. right after a DB wipe) and matched
 *    against an empty repo list. Re-running heals the mapping; without this the
 *    zero-mapping state is permanent, and repo syncs silently build no graphs. */
export function shouldRunBootDiscovery(entries: { repo?: string }[], localRepoCount: number): boolean {
  if (entries.length === 0) return true
  return localRepoCount > 0 && entries.every((s) => !s.repo)
}

export async function discoverServices(db: Database, secrets: SecretStore): Promise<DiscoveryResult> {
  const services = servicesRepo(db)
  const repoRoot = expandHome(settingsRepo(db).get().repoRoot)
  const repos = scanGitRepos(repoRoot)
  const result: DiscoveryResult = { instances: [], discovered: 0, matchedToRepos: 0, upserted: 0 }
  const seen = new Set<string>()

  for (const inst of readInstances(db)) {
    const token = secrets.get(`grafana.token.${inst.name}`)
    if (!token) {
      const unreadable = secrets.has(`grafana.token.${inst.name}`)
      result.instances.push({ name: inst.name, services: 0, error: unreadable ? 'token unreadable — re-enter it in Connections' : 'no token' })
      continue
    }
    try {
      const { names, debug } = await lokiServiceNames(inst.url, token)
      result.instances.push({ name: inst.name, services: names.size, detail: debug })

      for (const name of names) {
        if (seen.has(name) || !name || name.length > 64) continue
        seen.add(name)
        result.discovered++
        const repo = matchRepo(name, repos)
        if (repo) result.matchedToRepos++
        services.upsert({
          name,
          repo,
          source: 'inferred',
          aliases: [],
          serving: `logs in Grafana "${inst.name}"`,
          ids: { loki_label: `app=${name}`, grafana_instance: inst.name },
          knownSolutions: [],
        })
        result.upserted++
      }
    } catch (e) {
      result.instances.push({ name: inst.name, services: 0, error: (e as Error).message.slice(0, 120) })
    }
  }

  l.info(`discovery: ${result.discovered} services, ${result.matchedToRepos} matched to repos`)
  return result
}

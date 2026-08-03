// Repo sync — repos as a first-class sync source ('repos' in the sync panel):
//   1. infer the GitHub org from local remotes (stored in settings, overridable)
//   2. `gh repo list` the org → clone missing repos (blobless: full history,
//      lazy blobs — git log local, blame fetches on demand)
//   3. `git fetch` every existing clone (pool of 8)
// Uses the user's own gh/git auth — Mesh stores no tokens of its own (Section 10).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { SyncProgressEvent } from '../../shared/types'
import { settingsRepo } from '../db/repos/settings'
import { syncStateRepo } from '../db/repos/syncState'
import { expandHome, scanGitRepos } from './workspace'
import { buildGraph, hasGraph, hasGraphify } from './graphify'
import { log } from '../log'

const l = log('repos:sync')
const exec = promisify(execFile)

export const REPOS_SOURCE = 'repos'
const CLONE_POOL = 3
const FETCH_POOL = 8
// Graph builds are CPU-bound tree-sitter parses — two at a time keeps the
// machine responsive while the sync runs in the background.
const GRAPH_POOL = 2

async function run(cmd: string, args: string[], cwd?: string, timeoutMs = 120_000): Promise<string> {
  const { stdout } = await exec(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/** Majority org across local remotes — inferred once, then stored in settings. */
async function inferOrgAsync(repoRoot: string, repos: string[]): Promise<string | null> {
  const counts = new Map<string, number>()
  for (const name of repos.slice(0, 30)) {
    try {
      const url = (await run('git', ['-C', join(expandHome(repoRoot), name), 'remote', 'get-url', 'origin'], undefined, 10_000)).trim()
      const m = url.match(/(?:git@github\.com:|https:\/\/github\.com\/)([^/]+)\//)
      if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1)
    } catch {
      /* no remote — skip */
    }
  }
  return counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null
}

export interface RepoSyncDeps {
  db: Database
  emit: (e: SyncProgressEvent) => void
}

/** The 'repos' source pass: discover → clone missing → fetch all. */
export async function syncRepos(deps: RepoSyncDeps, runId: string): Promise<void> {
  const states = syncStateRepo(deps.db)
  const settings = settingsRepo(deps.db)
  const emit = (phase: SyncProgressEvent['phase'], done: number, total?: number, message?: string) =>
    deps.emit({ runId, source: REPOS_SOURCE, phase, done, total, message })

  states.markRunning(REPOS_SOURCE)
  try {
    const root = expandHome(settings.get().repoRoot)
    if (!existsSync(root)) {
      states.finishRun(REPOS_SOURCE, 'needs-connection', `repo root missing: ${root}`)
      emit('done', 0, 0, 'repo root not set')
      return
    }

    const local = scanGitRepos(root)

    // org: stored setting, else infer from remotes and store
    let org = settings.get().githubOrg
    if (!org) {
      org = (await inferOrgAsync(root, local)) ?? undefined
      if (org) settings.set({ githubOrg: org })
    }

    // discovery — needs gh; degrade to fetch-only if unavailable
    let missing: string[] = []
    if (org) {
      try {
        const out = await run('gh', ['repo', 'list', org, '--limit', '1000', '--json', 'name,isArchived'], undefined, 60_000)
        const orgRepos = (JSON.parse(out) as { name: string; isArchived: boolean }[]).filter((r) => !r.isArchived).map((r) => r.name)
        const have = new Set(local)
        missing = orgRepos.filter((n) => !have.has(n))
      } catch (e) {
        l.warn('gh discovery failed (is gh installed + authed?):', (e as Error).message)
        emit('fetch', 0, undefined, 'gh unavailable — fetch-only pass')
      }
    }

    const total = missing.length + local.length
    let done = 0

    // clone missing (pool)
    for (let i = 0; i < missing.length; i += CLONE_POOL) {
      const batch = missing.slice(i, i + CLONE_POOL)
      await Promise.all(
        batch.map(async (name) => {
          try {
            await run('gh', ['repo', 'clone', `${org}/${name}`, join(root, name), '--', '--filter=blob:none', '--quiet'], undefined, 300_000)
            deps.db
              .prepare('INSERT INTO repos (name, path, last_fetched_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET path = excluded.path, last_fetched_at = excluded.last_fetched_at')
              .run(name, join(root, name), Date.now())
            l.info(`cloned ${name}`)
          } catch (e) {
            l.warn(`clone failed ${name}:`, (e as Error).message.slice(0, 120))
          }
        }),
      )
      done += batch.length
      emit('fetch', done, total, `cloning missing (${Math.min(done, missing.length)}/${missing.length})`)
    }

    // fetch existing (pool)
    for (let i = 0; i < local.length; i += FETCH_POOL) {
      const batch = local.slice(i, i + FETCH_POOL)
      await Promise.all(
        batch.map(async (name) => {
          try {
            await run('git', ['-C', join(root, name), 'fetch', '--all', '--quiet'], undefined, 120_000)
            deps.db
              .prepare('INSERT INTO repos (name, path, last_fetched_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET last_fetched_at = excluded.last_fetched_at')
              .run(name, join(root, name), Date.now())
          } catch (e) {
            l.warn(`fetch failed ${name}:`, (e as Error).message.slice(0, 120))
          }
        }),
      )
      done += batch.length
      emit('fetch', done, total, `fetching (${Math.min(done - missing.length, local.length)}/${local.length})`)
    }

    // Code graphs (graphify, optional): only for repos a registry service maps
    // to — those are the ones investigations open. Local AST, no LLM, free;
    // --update makes re-runs cheap. Missing CLI degrades silently to rg.
    let graphsBuilt = 0
    let graphNote = ''
    if (await hasGraphify()) {
      const serviceRepos = (deps.db.prepare('SELECT DISTINCT repo FROM services WHERE repo IS NOT NULL').all() as { repo: string }[])
        .map((r) => r.repo)
        .filter((name) => local.includes(name))
      for (let i = 0; i < serviceRepos.length; i += GRAPH_POOL) {
        const batch = serviceRepos.slice(i, i + GRAPH_POOL)
        await Promise.all(batch.map(async (name) => {
          if (await buildGraph(join(root, name))) graphsBuilt++
        }))
        emit('fetch', total, total, `graphs (${Math.min(i + batch.length, serviceRepos.length)}/${serviceRepos.length})`)
      }
      graphNote = ` · ${graphsBuilt} graph${graphsBuilt === 1 ? '' : 's'} indexed`
    } else if (local.some((name) => hasGraph(join(root, name)))) {
      // Graphs exist from an earlier install but the CLI is gone — stale.
      graphNote = ' · graphify not on PATH (graphs stale)'
    }

    states.finishRun(REPOS_SOURCE, 'idle')
    emit('done', total, total, `${missing.length} cloned · ${local.length} fetched${graphNote}`)
  } catch (e) {
    states.finishRun(REPOS_SOURCE, 'error', (e as Error).message)
    emit('error', 0, undefined, (e as Error).message)
  }
}

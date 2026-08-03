// Graphify integration — per-repo code knowledge graphs the agent can QUERY
// instead of grepping. tree-sitter AST, deterministic, fully local: building a
// graph makes no LLM calls and sends nothing anywhere (`--code-only`).
//
// Split of responsibilities:
//   · BUILDING graphs happens here, during the repos sync (background, pooled),
//     never inside an agent session — `graphify extract` writes graphify-out/,
//     so from the session's point of view it is a write and stays gated.
//   · QUERYING graphs happens inside sessions via the read-only gate: `query`,
//     `path`, `explain` read graph.json and mutate nothing (readonly.ts).
//
// Graphify is optional tooling, same posture as gcloud/az: detect, degrade to
// rg/grep when absent, and tell the user how to install rather than failing.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'

const l = log('repos:graphify')
const exec = promisify(execFile)

/** First build of a big repo parses every file; incremental re-runs are fast.
 *  Bounded so one pathological repo can't wedge the sync source. */
const BUILD_TIMEOUT_MS = 10 * 60_000

export const graphJsonPath = (repoPath: string): string => join(repoPath, 'graphify-out', 'graph.json')
export const hasGraph = (repoPath: string): boolean => existsSync(graphJsonPath(repoPath))

/** Is the graphify CLI on PATH? (5s probe, never throws) */
export async function hasGraphify(): Promise<boolean> {
  try {
    await exec('graphify', ['--version'], { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/** Build/refresh one repo's graph. Code-only keeps it local and free (no
 *  semantic pass, no API key). `--update` re-extracts only changed files —
 *  but flag support can drift between graphify versions, so an incremental
 *  attempt that fails retries once in the plain documented form. */
export async function buildGraph(repoPath: string): Promise<boolean> {
  const attempts: string[][] = [
    ['extract', repoPath, '--code-only', '--update', '--no-viz'],
    ['extract', repoPath, '--code-only'],
  ]
  for (const [i, args] of attempts.entries()) {
    try {
      await exec('graphify', args, { timeout: BUILD_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
      return hasGraph(repoPath)
    } catch (e) {
      const msg = (e as Error).message.slice(0, 160)
      if (i === attempts.length - 1) l.warn(`graph build failed for ${repoPath}: ${msg}`)
      else l.info(`graph build retrying in plain form for ${repoPath}: ${msg}`)
    }
  }
  return false
}

/** repo name → absolute graph.json path, for every repo that has one. This is
 *  what the runbook uses to advertise graphs to the session — only graphs that
 *  actually exist get advertised, so the agent is never sent to a missing file. */
export function availableGraphs(repoRoot: string, repoNames: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const name of repoNames) {
    const p = join(repoRoot, name)
    if (hasGraph(p)) out.set(name, graphJsonPath(p))
  }
  return out
}

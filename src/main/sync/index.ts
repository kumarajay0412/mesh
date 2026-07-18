// runSync — the ingestion orchestrator (Section 7.1):
//   fetch (per source, cursor-based) → link → distill → upsert → advance cursor
// First run (no cursor) IS the backfill; every later run is incremental.
// Single-flight per source; progress streamed to the renderer via callback.
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { SyncProgressEvent } from '../../shared/types'
import { memoryRepo } from '../db/repos/memory'
import { syncStateRepo } from '../db/repos/syncState'
import type { SecretStore } from '../security/secrets'
import { fetchLinearSince } from './linear'
import { fetchSlackSince } from './slack'
import { linkIncidents } from './link'
import { distillIncident, heuristicDistill, findSignature, incidentText, type LlmOneShot } from './distill'
import { syncRepos, REPOS_SOURCE } from '../repos/sync'
import type { LinkedIncident, RawThread, RawTicket } from './types'
import { log } from '../log'

const l = log('sync')

export const LINEAR_SOURCE = 'linear'
export const SLACK_PREFIX = 'slack:'

export interface SyncDeps {
  db: Database
  secrets: SecretStore
  llm: LlmOneShot | null
  emit: (e: SyncProgressEvent) => void
  /** called after upserts so embeddings can drain the pending queue */
  onIngested?: () => void
}

const inflight = new Map<string, Promise<void>>()

export function knownSources(deps: SyncDeps): string[] {
  // slack.channel accepts a comma-separated list ("reporting-prod, incidents,
  // postmortems") — each channel is its own source with its own cursor
  const channels = (deps.secrets.get('slack.channel') ?? '#reporting')
    .split(',')
    .map((c) => c.trim().replace(/^#/, ''))
    .filter(Boolean)
  return [LINEAR_SOURCE, ...channels.map((c) => `${SLACK_PREFIX}${c}`), REPOS_SOURCE]
}

export async function runSync(deps: SyncDeps, sources?: string[]): Promise<{ runId: string }> {
  const runId = randomUUID().slice(0, 8)
  const targets = sources?.length ? sources : knownSources(deps)
  // Fire sources concurrently; each is single-flight and crash-isolated.
  for (const source of targets) {
    if (inflight.has(source)) continue
    const p = syncOne(deps, runId, source)
      .catch((e) => l.error(`${source} failed:`, e))
      .finally(() => inflight.delete(source))
    inflight.set(source, p)
  }
  return { runId }
}

async function syncOne(deps: SyncDeps, runId: string, source: string): Promise<void> {
  const states = syncStateRepo(deps.db)
  const emit = (phase: SyncProgressEvent['phase'], done: number, total?: number, message?: string) =>
    deps.emit({ runId, source, phase, done, total, message })

  if (source === LINEAR_SOURCE) {
    const apiKey = deps.secrets.get('linear.apiKey')
    if (!apiKey) {
      states.finishRun(source, 'needs-connection', 'no Linear API key')
      emit('done', 0, 0, 'needs connection')
      return
    }
    states.markRunning(source)
    let ingested = 0
    try {
      const cursor = states.get(source).cursor
      emit('fetch', 0)
      const nextCursor = await fetchLinearSince(apiKey, cursor, async (tickets) => {
        ingested += await ingestPage(deps, { tickets, threads: [] }, emit, ingested)
      })
      // Cursor ONLY advances after the walk completes — pages are newest-first,
      // so a mid-walk crash must re-walk rather than strand the older tail.
      if (nextCursor) states.setCursor(source, nextCursor)
      states.finishRun(source, 'idle')
      emit('done', ingested, ingested)
    } catch (e) {
      states.finishRun(source, 'error', (e as Error).message)
      emit('error', ingested, undefined, (e as Error).message)
    }
    return
  }

  if (source.startsWith(SLACK_PREFIX)) {
    const token = deps.secrets.get('slack.token')
    // the source name IS the channel — one source per channel, own cursor each
    const channel = source.slice(SLACK_PREFIX.length)
    if (!token) {
      states.finishRun(source, 'needs-connection', 'no Slack token')
      emit('done', 0, 0, 'needs connection')
      return
    }
    states.markRunning(source)
    let ingested = 0
    try {
      const cursor = states.get(source).cursor
      emit('fetch', 0)
      const nextCursor = await fetchSlackSince(token, channel.replace(/^#/, ''), cursor, async (threads) => {
        ingested += await ingestPage(deps, { tickets: [], threads }, emit, ingested)
      })
      if (nextCursor) states.setCursor(source, nextCursor) // after completion only
      states.finishRun(source, 'idle')
      emit('done', ingested, ingested)
    } catch (e) {
      states.finishRun(source, 'error', (e as Error).message)
      emit('error', ingested, undefined, (e as Error).message)
    }
    return
  }

  if (source === REPOS_SOURCE) {
    // repos ride the same panel/scheduler but sync git checkouts, not memory
    await syncRepos({ db: deps.db, emit: deps.emit }, runId)
    return
  }

  states.finishRun(source, 'error', `unknown source: ${source}`)
}

/** link → distill → upsert for one fetched page. Distill failures skip-and-log.
 *  Throughput: LLM distill only where there's a narrative worth distilling
 *  (≥2 comments), and 4 incidents in flight at once — the per-call Claude
 *  session spawn is the dominant cost, so overlap it. */
const DISTILL_POOL = 4

async function ingestPage(
  deps: SyncDeps,
  page: { tickets: RawTicket[]; threads: RawThread[] },
  emit: (phase: SyncProgressEvent['phase'], done: number, total?: number, message?: string) => void,
  alreadyDone: number,
): Promise<number> {
  const memory = memoryRepo(deps.db)
  const linked = linkIncidents(page.tickets, page.threads)

  // Skip-unchanged fast path: a re-walk (crash recovery, cursor overlap)
  // mostly re-sees records already ingested at the same updatedAt — those
  // need no distill and no upsert at all.
  const incidents = linked.filter((incident) => {
    const id = incident.ticket ? `${incident.ticket.source}:${incident.ticket.ticketId}` : `slack:${incident.thread!.ts}`
    const seenAt = memory.updatedAtOf(id)
    const srcAt = incident.ticket?.updatedAt ?? incident.thread?.createdAt ?? 0
    const unchanged = seenAt !== null && seenAt === srcAt
    // Unchanged rows still get derived-label refreshes (project tags etc.) —
    // metadata only, no distill, no updated_at bump.
    if (unchanged && incident.ticket) memory.updateLabels(id, incident.ticket.labels)
    return !unchanged
  })
  const skipped = linked.length - incidents.length
  if (skipped > 0) l.info(`skip-unchanged: ${skipped}/${linked.length} already current (labels refreshed)`)

  const total = alreadyDone + incidents.length
  emit('link', alreadyDone, total)

  let gatedShort = 0
  const distillOne = async (incident: LinkedIncident) => {
    const commentCount = (incident.ticket?.comments.length ?? 0) + (incident.thread?.replies.length ?? 0)
    // ≤2 comments = no investigation narrative; heuristics extract the same
    // fields without a multi-second model call.
    if (!deps.llm || commentCount <= 2) return heuristicDistill(incident)
    // Length gate: under ~800 chars there is nothing to "distill" — the whole
    // thread fits the symptoms field verbatim. Measured 35% of the corpus.
    if (incidentText(incident).length < 800) {
      gatedShort++
      return heuristicDistill(incident)
    }
    return distillIncident(incident, deps.llm)
  }

  let done = 0
  for (let i = 0; i < incidents.length; i += DISTILL_POOL) {
    const batch = incidents.slice(i, i + DISTILL_POOL)
    emit('distill', alreadyDone + done, total)
    const results = await Promise.all(
      batch.map(async (incident) => {
        try {
          return { incident, distilled: await distillOne(incident) }
        } catch (e) {
          l.warn(`skip incident (${incidentKey(incident)}):`, (e as Error).message)
          return null
        }
      }),
    )
    for (const r of results) {
      if (!r) continue
      memory.upsert(toMemoryRecord(r.incident, r.distilled))
      done++
    }
    emit('upsert', alreadyDone + done, total)
  }
  if (gatedShort > 0) l.info(`distill gate: ${gatedShort}/${incidents.length} short incidents took the heuristic path (no LLM call)`)
  deps.onIngested?.()
  return done
}

function incidentKey(i: LinkedIncident): string {
  return i.ticket ? `${i.ticket.source}:${i.ticket.identifier ?? i.ticket.ticketId}` : `slack:${i.thread?.ts}`
}

function toMemoryRecord(
  incident: LinkedIncident,
  d: { symptoms: string; rootCause?: string; resolution?: string; investigationSummary?: string; resolutionSteps: string[]; errorSignature?: string },
) {
  const t = incident.ticket
  const th = incident.thread
  const id = t ? `${t.source}:${t.ticketId}` : `slack:${th!.ts}`
  const rawComments = JSON.stringify({
    ticketComments: t?.comments ?? [],
    threadReplies: th?.replies ?? [],
  })
  return {
    id,
    source: (t?.source ?? 'slack') as 'linear' | 'slack',
    ticketId: t?.ticketId,
    identifier: t?.identifier,
    slackUrl: th?.permalink,
    title: t?.title ?? th!.text.slice(0, 140),
    symptoms: d.symptoms,
    rootCause: d.rootCause,
    resolution: d.resolution,
    investigationSummary: d.investigationSummary,
    resolutionSteps: d.resolutionSteps,
    errorSignature: d.errorSignature ?? findSignature(`${t?.description ?? ''} ${th?.text ?? ''}`),
    labels: t?.labels ?? [],
    priority: t?.priority,
    reportedAt: t?.createdAt ?? th?.createdAt,
    resolvedAt: t?.completedAt,
    updatedAt: t?.updatedAt ?? th?.createdAt ?? Date.now(),
    rawCommentsJson: rawComments,
  }
}

// runSync — the ingestion orchestrator (Section 7.1):
//   fetch (per source, cursor-based) → link → distill → upsert → advance cursor
// First run (no cursor) IS the backfill; every later run is incremental.
// Single-flight per source; progress streamed to the renderer via callback.
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { SyncProgressEvent } from '../../shared/types'
import { memoryRepo } from '../db/repos/memory'
import { syncStateRepo } from '../db/repos/syncState'
import { slackThreadsRepo } from '../db/repos/slackThreads'
import type { SecretStore } from '../security/secrets'
import { fetchLinearSince } from './linear'
import { fetchSlackSince, friendlySlackError } from './slack'
import { fetchSlackCorpus, slackApi } from './slack-corpus'
import { fetchNotionSince, notionWhoAmI } from './notion'
import { linkIncidents } from './link'
import { distillIncident, heuristicDistill, findSignature, incidentText, type LlmOneShot } from './distill'
import { syncRepos, REPOS_SOURCE } from '../repos/sync'
import type { CorpusDoc, LinkedIncident, RawThread, RawTicket } from './types'
import { log } from '../log'

const l = log('sync')

export const LINEAR_SOURCE = 'linear'
export const SLACK_PREFIX = 'slack:'
export const NOTION_SOURCE = 'notion'
export const SLACK_CORPUS_SOURCE = 'slack-corpus'

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
  // slack.channel is a comma-separated list ("reporting-prod, incidents") —
  // each SELECTED channel is its own source with its own cursor. No channels
  // chosen yet → no slack sources: a phantom default like "slack:reporting"
  // would show a channel nobody picked. Connections is the connect prompt.
  const channels = (deps.secrets.get('slack.channel') ?? '')
    .split(',')
    .map((c) => c.trim().replace(/^#/, ''))
    .filter(Boolean)
  const notion = deps.secrets.has('notion.token') ? [NOTION_SOURCE] : []
  // The all-public-channels corpus is opt-in (Slack dialog toggle): its first
  // walk is large, so nobody should get it by surprise.
  const slackCorpus = deps.secrets.has('slack.token') && deps.secrets.get('slack.corpus') === '1' ? [SLACK_CORPUS_SOURCE] : []
  return [LINEAR_SOURCE, ...channels.map((c) => `${SLACK_PREFIX}${c}`), ...slackCorpus, ...notion, REPOS_SOURCE]
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
      const threadTracker = slackThreadsRepo(deps.db)
      const nextCursor = await fetchSlackSince(
        token,
        channel.replace(/^#/, ''),
        cursor,
        (ts, replyCount) => threadTracker.changed(ts, replyCount),
        async (threads) => {
          ingested += await ingestPage(deps, { tickets: [], threads }, emit, ingested)
          // record only after a successful ingest, so the tracker never claims
          // a thread is done that isn't actually in memory
          for (const th of threads) threadTracker.record(th.ts, th.replyCount)
        },
      )
      if (nextCursor) states.setCursor(source, nextCursor) // after completion only
      states.finishRun(source, 'idle')
      emit('done', ingested, ingested)
    } catch (e) {
      const friendly = friendlySlackError(e)
      states.finishRun(source, 'error', friendly)
      emit('error', ingested, undefined, friendly)
    }
    return
  }

  if (source === SLACK_CORPUS_SOURCE) {
    const token = deps.secrets.get('slack.token')
    if (!token) {
      states.finishRun(source, 'needs-connection', 'no Slack token')
      emit('done', 0, 0, 'needs connection')
      return
    }
    states.markRunning(source)
    let ingested = 0
    try {
      // Cursor = per-channel JSON map; each channel advances when ITS walk
      // completes (channels are independent — a crash re-walks only one).
      let cursors: Record<string, string> = {}
      try {
        cursors = JSON.parse(states.get(source).cursor ?? '{}') as Record<string, string>
      } catch {
        cursors = {}
      }
      const excludeNames = (deps.secrets.get('slack.channel') ?? '').split(',')
      emit('fetch', 0)
      const result = await fetchSlackCorpus(
        slackApi(token),
        cursors,
        excludeNames,
        async (docs) => {
          ingested += ingestCorpus(deps, docs, emit, ingested)
        },
        (channelId, newCursor) => {
          cursors[channelId] = newCursor
          states.setCursor(source, JSON.stringify(cursors))
        },
        (name, i, total) => emit('fetch', ingested, undefined, `#${name} · ${i}/${total}`),
      )
      const note = result.skippedNotMember > 0 ? `${result.skippedNotMember} channel(s) unreadable — bot not a member (use a user token, or /invite it)` : undefined
      states.finishRun(source, 'idle', note)
      emit('done', ingested, ingested, note)
    } catch (e) {
      const friendly = friendlySlackError(e)
      states.finishRun(source, 'error', friendly)
      emit('error', ingested, undefined, friendly)
    }
    return
  }

  if (source === NOTION_SOURCE) {
    const token = deps.secrets.get('notion.token')
    if (!token) {
      states.finishRun(source, 'needs-connection', 'no Notion token')
      emit('done', 0, 0, 'needs connection')
      return
    }
    states.markRunning(source)
    let ingested = 0
    try {
      const cursor = states.get(source).cursor
      emit('fetch', 0)
      const nextCursor = await fetchNotionSince(token, cursor, async (docs) => {
        ingested += ingestCorpus(deps, docs, emit, ingested)
      })
      if (nextCursor) states.setCursor(source, nextCursor) // after completion only
      // A clean walk with nothing in memory = valid token, zero shared pages.
      // Name the integration so the user can check they shared with THIS one.
      let note: string | undefined
      if (ingested === 0 && (deps.db.prepare(`SELECT COUNT(*) c FROM memory WHERE source = 'notion'`).get() as { c: number }).c === 0) {
        const who = await notionWhoAmI(token)
        note = who ? `token is ${who} — 0 pages shared with it` : undefined
        if (note) l.info(`notion: ${note}`)
      }
      states.finishRun(source, 'idle', note)
      emit('done', ingested, ingested, note)
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
    // Slack: use reply ACTIVITY, not the immutable head ts, so a thread that
    // gained the diagnosis in later replies is correctly seen as changed.
    const srcAt = incident.ticket?.updatedAt ?? incident.thread?.latestActivityAt ?? 0
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
    if (!deps.llm) return heuristicDistill(incident)
    // Gate on TOTAL CONTENT, not comment count: a rich 0-comment ticket
    // description deserves distillation; a 3-reply "thanks!" thread does not.
    // Both conditions must hold to skip, so a long single-message incident
    // (a detailed bug report, a full RCA paste) still gets the LLM.
    const commentCount = (incident.ticket?.comments.length ?? 0) + (incident.thread?.replies.length ?? 0)
    if (commentCount <= 2 && incidentText(incident).length < 800) {
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
      // Link this incident to its counterpart from the OTHER source (walked by
      // a separate sync pass), so one outage isn't two divergent rows.
      crossLink(memory, r.incident)
      done++
    }
    emit('upsert', alreadyDone + done, total)
  }
  if (gatedShort > 0) l.info(`distill gate: ${gatedShort}/${incidents.length} short incidents took the heuristic path (no LLM call)`)
  deps.onIngested?.()
  return done
}

/** The CORPUS path: upsert verbatim, no link, no distill. The page text lands
 *  in `symptoms` — FTS's highest-weighted, unbounded column — so the whole
 *  document is lexically searchable, and the embedding drain picks the row up
 *  like any other (it embeds the opening slice). Free per item, so bulk
 *  knowledge-base sources scale without LLM spend. */
function ingestCorpus(
  deps: SyncDeps,
  docs: CorpusDoc[],
  emit: (phase: SyncProgressEvent['phase'], done: number, total?: number, message?: string) => void,
  alreadyDone: number,
): number {
  const memory = memoryRepo(deps.db)
  let done = 0
  for (const doc of docs) {
    // Same skip-unchanged contract as incidents: equal updatedAt ⇒ no re-upsert
    // (which would needlessly re-embed via embedded=0).
    if (memory.updatedAtOf(doc.id) === doc.updatedAt) continue
    memory.upsert({
      id: doc.id,
      source: doc.source,
      title: doc.title,
      url: doc.url,
      symptoms: doc.text,
      resolutionSteps: [],
      labels: [],
      reportedAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    })
    done++
  }
  emit('upsert', alreadyDone + done, undefined)
  if (done > 0) deps.onIngested?.()
  return done
}

function incidentKey(i: LinkedIncident): string {
  return i.ticket ? `${i.ticket.source}:${i.ticket.identifier ?? i.ticket.ticketId}` : `slack:${i.thread?.ts}`
}

/** Cross-source linking against the DB (not the in-flight batch): the ticket
 *  and the Slack thread about the same outage are walked by separate sync
 *  passes, so we link whichever is ingested second to its already-stored
 *  counterpart, by the two high-precision signals (identifier, permalink). */
function crossLink(memory: ReturnType<typeof memoryRepo>, incident: LinkedIncident): void {
  if (incident.ticket) {
    const id = `${incident.ticket.source}:${incident.ticket.ticketId}`
    if (incident.ticket.identifier) {
      for (const slackId of memory.slackIdsMentioning(incident.ticket.identifier)) memory.linkTo(id, slackId)
    }
    for (const url of incident.ticket.urls) {
      const slackId = slackIdFromPermalink(url)
      if (slackId && memory.exists(slackId)) memory.linkTo(id, slackId)
    }
  }
  if (incident.thread) {
    const id = `slack:${incident.thread.ts}`
    const text = [incident.thread.text, ...incident.thread.replies.map((r) => r.body)].join(' ')
    for (const m of text.matchAll(/\b([A-Z]{2,6}-\d+)\b/g)) {
      const lin = memory.byIdentifier(m[1])
      if (lin) memory.linkTo(id, lin.id)
    }
  }
}

/** Slack permalink → memory row id: .../archives/<chan>/p<digits> → slack:<ts>. */
function slackIdFromPermalink(url: string): string | null {
  const m = url.match(/\/archives\/[A-Z0-9]+\/p(\d+)/i)
  if (!m || m[1].length < 7) return null
  const d = m[1]
  return `slack:${d.slice(0, -6)}.${d.slice(-6)}`
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
    // Slack rows carry reply-activity time so a re-distill after new replies
    // bumps updated_at and skip-unchanged sees the change.
    updatedAt: t?.updatedAt ?? th?.latestActivityAt ?? Date.now(),
    rawCommentsJson: rawComments,
  }
}

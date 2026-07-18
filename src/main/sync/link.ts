// Pure ticket↔thread linking (Section 7.1) — most-reliable-signal first:
//   1. ticket carries the thread's Slack permalink
//   2. the thread mentions the ticket identifier (ENG-123)
//   3. fallback: close in time + shared salient tokens
// Zero imports beyond types — fully unit-testable.
import type { LinkedIncident, RawThread, RawTicket } from './types'

const TIME_WINDOW_MS = 3 * 60 * 60 * 1000 // ±3h for the fallback signal
const MIN_SHARED_TOKENS = 3

export function linkIncidents(tickets: RawTicket[], threads: RawThread[]): LinkedIncident[] {
  const out: LinkedIncident[] = []
  const claimedThreads = new Set<string>()

  for (const ticket of tickets) {
    const thread =
      byPermalink(ticket, threads, claimedThreads) ??
      byIdentifier(ticket, threads, claimedThreads) ??
      byProximity(ticket, threads, claimedThreads)
    if (thread) claimedThreads.add(thread.ts)
    out.push({ ticket, thread })
  }

  // Threads that matched no ticket are still incidents — Slack-only records.
  for (const thread of threads) {
    if (!claimedThreads.has(thread.ts)) out.push({ thread })
  }

  return out
}

function byPermalink(ticket: RawTicket, threads: RawThread[], claimed: Set<string>): RawThread | undefined {
  return threads.find((t) => !claimed.has(t.ts) && t.permalink && ticket.urls.some((u) => u.includes(slackPathOf(t.permalink!))))
}

/** Compare permalinks by path (host-agnostic — org may use several slack domains). */
function slackPathOf(permalink: string): string {
  try {
    return new URL(permalink).pathname
  } catch {
    return permalink
  }
}

function byIdentifier(ticket: RawTicket, threads: RawThread[], claimed: Set<string>): RawThread | undefined {
  if (!ticket.identifier) return undefined
  const id = ticket.identifier.toUpperCase()
  return threads.find(
    (t) => !claimed.has(t.ts) && (t.text.toUpperCase().includes(id) || t.replies.some((r) => r.body.toUpperCase().includes(id))),
  )
}

function byProximity(ticket: RawTicket, threads: RawThread[], claimed: Set<string>): RawThread | undefined {
  const ticketTokens = salientTokens(`${ticket.title} ${ticket.description}`)
  let best: { thread: RawThread; shared: number } | undefined

  for (const t of threads) {
    if (claimed.has(t.ts)) continue
    if (Math.abs(t.createdAt - ticket.createdAt) > TIME_WINDOW_MS) continue
    const threadTokens = salientTokens(t.text)
    let shared = 0
    for (const tok of threadTokens) if (ticketTokens.has(tok)) shared++
    if (shared >= MIN_SHARED_TOKENS && (!best || shared > best.shared)) best = { thread: t, shared }
  }
  return best?.thread
}

const STOP = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'of', 'for', 'and', 'or', 'not',
  'with', 'from', 'this', 'that', 'it', 'its', 'we', 'our', 'has', 'have', 'had', 'be', 'been', 'when',
  'after', 'before', 'since', 'about', 'into', 'out', 'up', 'down', 'again', 'error', 'issue', 'problem',
])

export function salientTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w)),
  )
}

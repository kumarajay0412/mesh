// Slack ALL-PUBLIC-CHANNELS ingestion — a CORPUS source (embed-only, no LLM),
// distinct from the incident channels the user picks in the wizard (those are
// distilled). This walks every public channel the token can read and stores
// conversations verbatim, so "was there ever a discussion about X" is
// answerable across the whole workspace for free.
//
// Granularity — two record shapes, chosen to keep rows meaningful:
//   · a THREAD (head + all replies) is one document
//   · standalone messages are grouped into one document per (channel, UTC day)
// Message-level rows would drown search in "thanks!" one-liners; day-level
// grouping keeps chatter findable without polluting ranked results.
//
// Cursors: ONE sync source, but per-channel cursors (a JSON map) — channels
// are independent walks, so each advances when ITS walk completes. A crash
// loses only the in-flight channel; finished channels don't re-walk. Every
// walk re-reads a trailing overlap window so replies added to recent threads
// re-enter the corpus (idempotent upserts + skip-unchanged make that cheap).
//
// Membership: a USER token (xoxp-) reads any public channel; a bot token only
// reads channels it was invited to — unreadable channels are counted and
// reported, never fatal.
import { WebClient } from '@slack/web-api'
import type { CorpusDoc } from './types'
import { isNoiseMessage, stripSlackMarkup } from './slack-clean'
import { log } from '../log'

const l = log('sync:slack-corpus')
const PAGE = 200
const OVERLAP_MS = 7 * 24 * 60 * 60 * 1000
/** Skip day-group docs with less text than this — an emoji and a "ok" is not
 *  a document worth a row. Threads are exempt: a short head can have replies. */
const MIN_DAY_DOC_CHARS = 60

export interface SlackMsg {
  ts?: string
  text?: string
  thread_ts?: string
  reply_count?: number
  subtype?: string
}

/** The slice of the Slack API the walk needs — injectable, so tests run the
 *  full walk against a fake without touching the network. */
export interface SlackApi {
  listPublicChannels(): Promise<{ id: string; name: string }[]>
  history(channel: string, oldest: string | undefined, cursor: string | undefined): Promise<{ messages: SlackMsg[]; nextCursor?: string }>
  replies(channel: string, ts: string): Promise<SlackMsg[]>
  teamDomain(): Promise<string | undefined>
}

/** The real client. @slack/web-api queues and retries 429s on its own, so
 *  pacing here is politeness, not correctness. */
export function slackApi(token: string): SlackApi {
  const client = new WebClient(token)
  return {
    async listPublicChannels() {
      const out: { id: string; name: string }[] = []
      let cursor: string | undefined
      let pages = 0
      do {
        const res = await client.conversations.list({ limit: 200, cursor, types: 'public_channel', exclude_archived: true })
        for (const c of res.channels ?? []) if (c.id && c.name) out.push({ id: c.id, name: c.name })
        cursor = (res.response_metadata?.next_cursor as string | undefined) || undefined
        pages++
      } while (cursor && pages < 25) // ~5,000 channels — beyond that, something is wrong
      return out
    },
    async history(channel, oldest, cursor) {
      const res = await client.conversations.history({ channel, oldest, limit: PAGE, cursor, inclusive: false })
      return {
        messages: (res.messages ?? []) as SlackMsg[],
        nextCursor: (res.response_metadata?.next_cursor as string | undefined) || undefined,
      }
    },
    async replies(channel, ts) {
      const res = await client.conversations.replies({ channel, ts, limit: 200 })
      return (res.messages ?? []) as SlackMsg[]
    },
    async teamDomain() {
      try {
        const res = await client.auth.test()
        return (res.url as string | undefined)?.match(/https:\/\/([^.]+)\.slack\.com/)?.[1]
      } catch {
        return undefined
      }
    },
  }
}

/* -------------------------------------------------------------- grouping -- */

const permalink = (team: string | undefined, channel: string, ts: string): string | undefined =>
  team ? `https://${team}.slack.com/archives/${channel}/p${ts.replace('.', '')}` : undefined

const utcDay = (tsSec: number): string => new Date(tsSec * 1000).toISOString().slice(0, 10)

/** One channel's walked messages (+ fetched thread replies) → corpus docs.
 *  Pure — this is the part unit tests pin. */
export function groupChannelDocs(
  channelId: string,
  channelName: string,
  team: string | undefined,
  messages: SlackMsg[],
  repliesByTs: Map<string, SlackMsg[]>,
): CorpusDoc[] {
  const docs: CorpusDoc[] = []
  const daily = new Map<string, { texts: string[]; firstTs: string; maxSec: number }>()

  for (const m of messages) {
    if (!m.ts) continue
    if (m.thread_ts && m.thread_ts !== m.ts) continue // replies ride with their head
    const text = stripSlackMarkup(m.text ?? '')
    if (isNoiseMessage(text, m.reply_count ?? 0)) continue
    const sec = parseFloat(m.ts)

    if ((m.reply_count ?? 0) > 0) {
      const replies = (repliesByTs.get(m.ts) ?? []).filter((r) => r.ts !== m.ts)
      let maxSec = sec
      const lines = [text]
      for (const r of replies) {
        const rt = stripSlackMarkup(r.text ?? '')
        if (rt) lines.push(rt)
        if (r.ts) maxSec = Math.max(maxSec, parseFloat(r.ts))
      }
      docs.push({
        id: `slackc:${channelId}:${m.ts}`,
        source: 'slack-corpus',
        title: `#${channelName}: ${text.slice(0, 120) || 'thread'}`,
        text: lines.join('\n'),
        url: permalink(team, channelId, m.ts),
        createdAt: Math.round(sec * 1000),
        updatedAt: Math.round(maxSec * 1000),
      })
    } else if (text) {
      const day = utcDay(sec)
      const g = daily.get(day) ?? { texts: [], firstTs: m.ts, maxSec: sec }
      g.texts.push(text)
      if (sec > g.maxSec) g.maxSec = sec
      if (parseFloat(m.ts) < parseFloat(g.firstTs)) g.firstTs = m.ts
      daily.set(day, g)
    }
  }

  for (const [day, g] of daily) {
    // History pages arrive newest-first; a day's messages read better oldest-first.
    const body = g.texts.reverse().join('\n')
    if (body.length < MIN_DAY_DOC_CHARS) continue
    docs.push({
      id: `slackc:${channelId}:d${day}`,
      source: 'slack-corpus',
      title: `#${channelName} — ${day}`,
      text: body,
      url: permalink(team, channelId, g.firstTs),
      createdAt: new Date(`${day}T00:00:00Z`).getTime(),
      updatedAt: Math.round(g.maxSec * 1000),
    })
  }
  return docs
}

/* ------------------------------------------------------------------ walk -- */

export interface CorpusWalkResult {
  channels: number
  skippedNotMember: number
}

/**
 * Walk every public channel not in `excludeNames` (the incident channels —
 * already ingested, better structured). Per channel: history since that
 * channel's own cursor minus a trailing overlap, thread replies fetched for
 * heads in the window, docs emitted per channel, and `onChannelDone` called
 * with the channel's new cursor so the caller can persist incrementally.
 */
export async function fetchSlackCorpus(
  api: SlackApi,
  cursors: Record<string, string>,
  excludeNames: string[],
  onChannelDocs: (docs: CorpusDoc[]) => Promise<void>,
  onChannelDone: (channelId: string, newCursor: string) => void,
  onProgress?: (channelName: string, index: number, total: number) => void,
): Promise<CorpusWalkResult> {
  const exclude = new Set(excludeNames.map((n) => n.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))
  const all = await api.listPublicChannels()
  const channels = all.filter((c) => !exclude.has(c.name.toLowerCase()))
  const team = await api.teamDomain()

  let skippedNotMember = 0
  let done = 0
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i]
    onProgress?.(ch.name, i + 1, channels.length)
    const cursorSec = cursors[ch.id] ? parseFloat(cursors[ch.id]) : 0
    const overlapFloor = (Date.now() - OVERLAP_MS) / 1000
    const oldest = cursorSec > 0 ? String(Math.min(cursorSec, overlapFloor)) : undefined

    try {
      let pageCursor: string | undefined
      let maxSec = cursorSec
      const messages: SlackMsg[] = []
      do {
        const page = await api.history(ch.id, oldest, pageCursor)
        for (const m of page.messages) if (m.ts) maxSec = Math.max(maxSec, parseFloat(m.ts))
        messages.push(...page.messages)
        pageCursor = page.nextCursor
      } while (pageCursor)

      // Replies only for thread heads inside the window — one call per thread.
      const repliesByTs = new Map<string, SlackMsg[]>()
      for (const m of messages) {
        if (!m.ts || (m.thread_ts && m.thread_ts !== m.ts)) continue
        if ((m.reply_count ?? 0) > 0) repliesByTs.set(m.ts, await api.replies(ch.id, m.ts))
      }

      const docs = groupChannelDocs(ch.id, ch.name, team, messages, repliesByTs)
      if (docs.length > 0) await onChannelDocs(docs)
      // This channel's walk is complete — its cursor may advance now. Other
      // channels' cursors are untouched; a crash re-walks only the one in flight.
      onChannelDone(ch.id, maxSec > 0 ? String(maxSec) : (cursors[ch.id] ?? '0'))
      done++
    } catch (e) {
      const code = (e as { data?: { error?: string } })?.data?.error
      if (code === 'not_in_channel') {
        skippedNotMember++ // bot token, not invited — expected, not an error
        continue
      }
      throw e // real failures (auth, network) abort the walk; cursors already
      //        persisted per channel mean the retry resumes where it stopped
    }
  }

  l.info(`corpus walk: ${done}/${channels.length} channels, ${skippedNotMember} unreadable (not a member)`)
  return { channels: done, skippedNotMember }
}

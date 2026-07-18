import { WebClient } from '@slack/web-api'
import type { RawComment, RawThread } from './types'
import { isNoiseMessage, stripSlackMarkup } from './slack-clean'
import { log } from '../log'

const l = log('sync:slack')
const PAGE = 100

/**
 * Incremental #reporting pull (Section 7.1): channel history with oldest > cursor,
 * plus every touched thread's replies — the diagnosis is in the thread.
 *
 * CURSOR CONTRACT (same as linear.ts): history arrives newest-first, so the
 * cursor is returned and persisted by the caller ONLY after the walk
 * completes — never per page. Crash ⇒ re-walk, absorbed by idempotency.
 */
export async function fetchSlackSince(
  token: string,
  channelRef: string,
  cursor: string | undefined,
  onPage: (threads: RawThread[]) => Promise<void>,
): Promise<string | undefined> {
  const client = new WebClient(token)
  // The API wants a channel ID (C0…), but humans type "#reporting" —
  // resolve names via conversations.list (needs channels:read).
  const channel = await resolveChannelId(client, channelRef)
  let pageCursor: string | undefined
  let pages = 0
  let globalMax = cursor ? parseFloat(cursor) : 0

  for (;;) {
    const res = await client.conversations.history({
      channel,
      oldest: cursor,
      limit: PAGE,
      cursor: pageCursor,
      inclusive: false,
    })

    const messages = (res.messages ?? []) as { ts?: string; text?: string; thread_ts?: string; user?: string; reply_count?: number }[]
    const threads: RawThread[] = []
    let maxTs = cursor ? parseFloat(cursor) : 0

    for (const m of messages) {
      if (!m.ts) continue
      const ts = parseFloat(m.ts)
      if (ts > maxTs) maxTs = ts
      // Only thread heads (or standalone messages) become incidents;
      // replies are fetched with their head below.
      if (m.thread_ts && m.thread_ts !== m.ts) continue
      // Bot noise (Slackbot reminders, join/leave, empty) never becomes memory.
      if (isNoiseMessage(m.text ?? '', m.reply_count ?? 0)) continue

      let replies: RawComment[] = []
      if (m.reply_count && m.reply_count > 0) {
        const rep = await client.conversations.replies({ channel, ts: m.ts, limit: 200 })
        replies = ((rep.messages ?? []) as { ts?: string; text?: string; user?: string }[])
          .filter((r) => r.ts !== m.ts)
          .map((r) => ({ body: stripSlackMarkup(r.text ?? ''), author: r.user, createdAt: r.ts ? Math.round(parseFloat(r.ts) * 1000) : 0 }))
      }

      let permalink: string | undefined
      try {
        const p = await client.chat.getPermalink({ channel, message_ts: m.ts })
        permalink = p.permalink as string | undefined
      } catch {
        /* permalink is a nicety, not a requirement */
      }

      threads.push({
        channel,
        ts: m.ts,
        permalink,
        text: stripSlackMarkup(m.text ?? ''),
        replies,
        createdAt: Math.round(parseFloat(m.ts) * 1000),
      })
    }

    if (maxTs > globalMax) globalMax = maxTs

    if (threads.length > 0) {
      await onPage(threads)
      pages++
    }

    pageCursor = (res.response_metadata?.next_cursor as string | undefined) || undefined
    if (!pageCursor) break
  }

  l.info(`fetched ${pages} page(s) from ${channelRef} since ${cursor ?? 'beginning'}`)
  return globalMax > 0 ? String(globalMax) : cursor
}

/** "#reporting" | "reporting" → C0… id; already-an-id passes through. */
async function resolveChannelId(client: WebClient, ref: string): Promise<string> {
  const clean = ref.replace(/^#/, '').trim()
  if (/^[CG][A-Z0-9]{6,}$/.test(clean)) return clean
  let cursor: string | undefined
  do {
    const res = await client.conversations.list({ limit: 200, cursor, types: 'public_channel,private_channel', exclude_archived: true })
    const hit = (res.channels ?? []).find((c) => c.name === clean)
    if (hit?.id) return hit.id
    cursor = (res.response_metadata?.next_cursor as string | undefined) || undefined
  } while (cursor)
  throw new Error(`channel not found: #${clean} (is the token's user/bot a member?)`)
}

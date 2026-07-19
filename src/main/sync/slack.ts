import { WebClient } from '@slack/web-api'
import type { RawComment, RawThread } from './types'
import { isNoiseMessage, stripSlackMarkup } from './slack-clean'
import { log } from '../log'

const l = log('sync:slack')
const PAGE = 100
// How far back to re-scan every walk. Slack's conversations.history won't
// re-surface a thread head once the cursor passes it, so late replies (the
// diagnosis!) would never be seen — we re-walk a trailing window and let the
// reply-count tracker make re-fetches cheap. Incidents can take days to
// resolve, so the window is generous.
const RESCAN_MS = 14 * 24 * 60 * 60 * 1000

/**
 * Incremental channel pull (Section 7.1): channel history with a trailing
 * re-scan window, plus each CHANGED thread's replies — the diagnosis is in the
 * replies, which arrive long after the head.
 *
 * `threadChanged(ts, replyCount)` (backed by the slack_threads tracker) decides
 * whether a thread is new/changed and worth fetching replies + re-emitting;
 * unchanged threads are skipped entirely, so the trailing re-scan is cheap.
 *
 * CURSOR CONTRACT (same as linear.ts): the cursor is returned and persisted by
 * the caller ONLY after the walk completes — never per page.
 */
export async function fetchSlackSince(
  token: string,
  channelRef: string,
  cursor: string | undefined,
  threadChanged: (ts: string, replyCount: number) => boolean,
  onPage: (threads: RawThread[]) => Promise<void>,
): Promise<string | undefined> {
  const client = new WebClient(token)
  const channel = await resolveChannelId(client, channelRef)
  const teamDomain = await resolveTeamDomain(client) // once per walk, for permalinks
  let pageCursor: string | undefined
  let pages = 0
  const cursorSec = cursor ? parseFloat(cursor) : 0
  let globalMax = cursorSec

  // Re-scan the trailing window even below the cursor so threads that gained
  // replies get re-checked; the tracker keeps this from re-doing work.
  const rescanFloorSec = (Date.now() - RESCAN_MS) / 1000
  const oldest = cursor ? String(Math.min(cursorSec, rescanFloorSec)) : undefined

  for (;;) {
    const res = await client.conversations.history({ channel, oldest, limit: PAGE, cursor: pageCursor, inclusive: false })

    const messages = (res.messages ?? []) as { ts?: string; text?: string; thread_ts?: string; user?: string; reply_count?: number }[]
    const threads: RawThread[] = []
    let maxTs = cursorSec

    for (const m of messages) {
      if (!m.ts) continue
      const ts = parseFloat(m.ts)
      if (ts > maxTs) maxTs = ts
      // Only thread heads (or standalone messages) become incidents; replies
      // are fetched with their head below.
      if (m.thread_ts && m.thread_ts !== m.ts) continue
      if (isNoiseMessage(m.text ?? '', m.reply_count ?? 0)) continue

      const replyCount = m.reply_count ?? 0
      // Cheap skip: reply_count comes free in the history payload — only pay
      // for conversations.replies (Tier-3) when the thread is new or changed.
      if (!threadChanged(m.ts, replyCount)) continue

      const headMs = Math.round(ts * 1000)
      let replies: RawComment[] = []
      let latestActivityAt = headMs
      if (replyCount > 0) {
        const rep = await client.conversations.replies({ channel, ts: m.ts, limit: 200 })
        replies = ((rep.messages ?? []) as { ts?: string; text?: string; user?: string }[])
          .filter((r) => r.ts !== m.ts)
          .map((r) => {
            const at = r.ts ? Math.round(parseFloat(r.ts) * 1000) : 0
            if (at > latestActivityAt) latestActivityAt = at
            return { body: stripSlackMarkup(r.text ?? ''), author: r.user, createdAt: at }
          })
      }

      threads.push({
        channel,
        ts: m.ts,
        permalink: buildPermalink(teamDomain, channel, m.ts),
        text: stripSlackMarkup(m.text ?? ''),
        replies,
        createdAt: headMs,
        replyCount,
        latestActivityAt,
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

  l.info(`fetched ${pages} page(s) of changed threads from ${channelRef} since ${cursor ?? 'beginning'}`)
  return globalMax > cursorSec ? String(globalMax) : cursor
}

/** Permalink without an API call: https://<team>.slack.com/archives/<chan>/p<ts> */
function buildPermalink(teamDomain: string | undefined, channel: string, ts: string): string | undefined {
  if (!teamDomain) return undefined
  return `https://${teamDomain}.slack.com/archives/${channel}/p${ts.replace('.', '')}`
}

/** Team subdomain for permalink construction — one auth.test per walk. */
async function resolveTeamDomain(client: WebClient): Promise<string | undefined> {
  try {
    const res = await client.auth.test()
    const url = res.url as string | undefined // https://myteam.slack.com/
    return url?.match(/https:\/\/([^.]+)\.slack\.com/)?.[1]
  } catch {
    return undefined // permalink is a nicety, not a requirement
  }
}

/** "#reporting" | "reporting" → C0… id; already-an-id passes through. */
export interface SlackChannelOption {
  id: string
  name: string
  /** can the token actually read history here, or does it need an invite first */
  isMember: boolean
}

/** Every public/private channel the token can see — for the connect-wizard
 *  picker, so the user SELECTS channels instead of blind-typing spellings.
 *  Member channels sort first (those are the ones sync can read); capped at
 *  10 pages (~2,000 channels) so a huge workspace can't hang the picker. */
export async function listChannels(token: string): Promise<SlackChannelOption[]> {
  const client = new WebClient(token)
  const channels: SlackChannelOption[] = []
  let cursor: string | undefined
  let pages = 0
  do {
    const res = await client.conversations.list({ limit: 200, cursor, types: 'public_channel,private_channel', exclude_archived: true })
    for (const c of res.channels ?? []) {
      if (c.id && c.name) channels.push({ id: c.id, name: c.name, isMember: !!c.is_member })
    }
    cursor = (res.response_metadata?.next_cursor as string | undefined) || undefined
    pages++
  } while (cursor && pages < 10)
  channels.sort((a, b) => (a.isMember === b.isMember ? a.name.localeCompare(b.name) : a.isMember ? -1 : 1))
  return channels
}

/** Slack platform error codes → words a non-Slack-API-fluent user understands. */
export function friendlySlackError(e: unknown): string {
  const code = (e as { data?: { error?: string } })?.data?.error
  const known: Record<string, string> = {
    invalid_auth: 'invalid token',
    not_authed: 'no token provided',
    account_inactive: 'token revoked, or the account was deactivated',
    token_revoked: 'token was revoked',
    missing_scope: 'token is missing the channels:read scope',
  }
  if (code) return known[code] ?? code
  return (e as Error)?.message ?? 'unknown error'
}

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

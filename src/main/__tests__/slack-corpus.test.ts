// Slack all-public-channels corpus: the grouping rules (threads vs daily
// digests — the part that decides what a "document" is), and the walk against
// a fake SlackApi — per-channel cursor advancement, incident-channel
// exclusion, and the bot-not-a-member skip that must never abort the walk.
import { describe, expect, it } from 'vitest'
import { fetchSlackCorpus, groupChannelDocs, type SlackApi, type SlackMsg } from '../sync/slack-corpus'
import type { CorpusDoc } from '../sync/types'

const msg = (ts: string, text: string, extra: Partial<SlackMsg> = {}): SlackMsg => ({ ts, text, ...extra })

describe('groupChannelDocs', () => {
  it('a thread becomes one doc: head + replies, activity = latest reply', () => {
    const replies = new Map([['100.1', [msg('100.1', 'head'), msg('160.5', 'the fix was the index'), msg('200.9', 'confirmed')]]])
    const docs = groupChannelDocs('C1', 'eng', 'adalat', [msg('100.1', 'search latency spiked', { reply_count: 2 })], replies)
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe('slackc:C1:100.1')
    expect(docs[0].title).toBe('#eng: search latency spiked')
    expect(docs[0].text).toBe('search latency spiked\nthe fix was the index\nconfirmed')
    expect(docs[0].url).toBe('https://adalat.slack.com/archives/C1/p1001')
    expect(docs[0].updatedAt).toBe(200_900) // latest reply, not head
  })

  it('standalone messages group into one doc per UTC day, oldest-first', () => {
    const day1a = 1_753_920_000
    const dayStr = new Date(day1a * 1000).toISOString().slice(0, 10)
    const docs = groupChannelDocs('C1', 'general', undefined, [
      // history arrives newest-first
      msg(String(day1a + 7200), 'later message with plenty of text to pass the minimum'),
      msg(String(day1a + 60), 'earlier message with plenty of text to pass the minimum'),
    ], new Map())
    expect(docs).toHaveLength(1)
    expect(docs[0].id).toBe(`slackc:C1:d${dayStr}`)
    expect(docs[0].text.startsWith('earlier message')).toBe(true) // reversed to reading order
    expect(docs[0].updatedAt).toBe((day1a + 7200) * 1000)
  })

  it('drops replies (they ride with their head), noise, and thin day docs', () => {
    const docs = groupChannelDocs('C1', 'general', undefined, [
      msg('300.1', 'a reply', { thread_ts: '100.1' }), // reply → skipped
      msg('300.2', '@user has joined the channel'), // noise
      msg('300.3', 'ok'), // real but thin → day doc under minimum
    ], new Map())
    expect(docs).toHaveLength(0)
  })
})

describe('fetchSlackCorpus', () => {
  const chan = (id: string, name: string) => ({ id, name })

  function fakeApi(opts: {
    channels: { id: string; name: string }[]
    history: Record<string, SlackMsg[]>
    failWith?: Record<string, string>
  }): SlackApi & { historyCalls: string[] } {
    const historyCalls: string[] = []
    return {
      historyCalls,
      listPublicChannels: async () => opts.channels,
      history: async (channel) => {
        historyCalls.push(channel)
        const code = opts.failWith?.[channel]
        if (code) {
          const e = new Error(code) as Error & { data?: { error?: string } }
          e.data = { error: code }
          throw e
        }
        return { messages: opts.history[channel] ?? [] }
      },
      replies: async (_channel, ts) => [msg(ts, 'head'), msg(String(parseFloat(ts) + 60), 'a reply with enough words')],
      teamDomain: async () => 'adalat',
    }
  }

  it('walks channels, emits docs, advances each channel cursor independently', async () => {
    const api = fakeApi({
      channels: [chan('C1', 'eng'), chan('C2', 'random')],
      history: {
        C1: [msg('500.1', 'a thread head about deploys', { reply_count: 1 })],
        C2: [msg('900.5', 'standalone chatter long enough to pass the day-doc minimum threshold')],
      },
    })
    const seen: CorpusDoc[] = []
    const cursorWrites: [string, string][] = []
    const res = await fetchSlackCorpus(api, {}, [], async (d) => void seen.push(...d), (id, c) => cursorWrites.push([id, c]))

    expect(res.channels).toBe(2)
    expect(res.skippedNotMember).toBe(0)
    expect(seen.map((d) => d.id).sort()).toEqual(['slackc:C1:500.1', 'slackc:C2:d1970-01-01'])
    // per-channel cursors: each advanced to its own max ts, written per channel
    expect(cursorWrites).toEqual([
      ['C1', '500.1'],
      ['C2', '900.5'],
    ])
  })

  it('excludes incident channels by name (case/# insensitive)', async () => {
    const api = fakeApi({ channels: [chan('C1', 'juda-reporting-prod'), chan('C2', 'eng')], history: { C2: [] } })
    const res = await fetchSlackCorpus(api, {}, ['#Juda-Reporting-Prod '], async () => {}, () => {})
    expect(res.channels).toBe(1)
    expect(api.historyCalls).toEqual(['C2']) // never touched the excluded one
  })

  it('bot not_in_channel skips the channel and keeps walking; other errors abort', async () => {
    const api = fakeApi({
      channels: [chan('C1', 'locked'), chan('C2', 'open')],
      history: { C2: [] },
      failWith: { C1: 'not_in_channel' },
    })
    const res = await fetchSlackCorpus(api, {}, [], async () => {}, () => {})
    expect(res.skippedNotMember).toBe(1)
    expect(res.channels).toBe(1)

    const bad = fakeApi({ channels: [chan('C3', 'x')], history: {}, failWith: { C3: 'invalid_auth' } })
    await expect(fetchSlackCorpus(bad, {}, [], async () => {}, () => {})).rejects.toThrow('invalid_auth')
  })

  it('resumes: an existing cursor keeps unchanged channels advancing from their own position', async () => {
    const api = fakeApi({ channels: [chan('C1', 'eng')], history: { C1: [] } })
    const writes: [string, string][] = []
    await fetchSlackCorpus(api, { C1: '500.1' }, [], async () => {}, (id, c) => writes.push([id, c]))
    // nothing new → cursor stays where it was, not reset to zero
    expect(writes).toEqual([['C1', '500.1']])
  })
})

import { describe, expect, it } from 'vitest'
import { linkIncidents } from '../sync/link'
import type { RawThread, RawTicket } from '../sync/types'

const t0 = Date.parse('2026-07-01T10:00:00Z')

function ticket(over: Partial<RawTicket>): RawTicket {
  return {
    source: 'linear',
    ticketId: 'id-1',
    identifier: 'ENG-123',
    title: 'payments-api 5xx spike',
    description: 'checkout failing with timeouts',
    labels: [],
    urls: [],
    comments: [],
    createdAt: t0,
    updatedAt: t0,
    ...over,
  }
}

function thread(over: Partial<RawThread>): RawThread {
  return {
    channel: 'C1',
    ts: '1751364000.000100',
    text: 'payments checkout is throwing 5xx timeouts',
    replies: [],
    createdAt: t0 + 5 * 60_000,
    replyCount: 0,
    latestActivityAt: t0 + 5 * 60_000,
    ...over,
  }
}

describe('ticket↔thread linking', () => {
  it('links by slack permalink on the ticket (signal 1)', () => {
    const th = thread({ permalink: 'https://org.slack.com/archives/C1/p1751364000000100' })
    const tk = ticket({ urls: ['https://org.slack.com/archives/C1/p1751364000000100'], title: 'unrelated words entirely' })
    const linked = linkIncidents([tk], [th])
    expect(linked[0].ticket).toBe(tk)
    expect(linked[0].thread).toBe(th)
  })

  it('links by identifier mention in the thread (signal 2)', () => {
    const th = thread({ text: 'tracking in ENG-123', createdAt: t0 + 26 * 60 * 60_000 }) // outside time window
    const linked = linkIncidents([ticket({})], [th])
    expect(linked[0].thread).toBe(th)
  })

  it('falls back to time+token proximity (signal 3)', () => {
    const th = thread({}) // shares payments/checkout/5xx/timeouts tokens, 5m apart
    const linked = linkIncidents([ticket({ identifier: 'ENG-999' })], [th])
    expect(linked[0].thread).toBe(th)
  })

  it('does not link distant unrelated threads; both still become incidents', () => {
    const th = thread({ text: 'lunch orders in #food today', createdAt: t0 + 40 * 60 * 60_000 })
    const linked = linkIncidents([ticket({ identifier: 'ENG-777' })], [th])
    expect(linked[0].thread).toBeUndefined()
    // unmatched thread surfaces as its own slack-only incident
    expect(linked.some((i) => !i.ticket && i.thread === th)).toBe(true)
  })

  it('a thread is claimed at most once', () => {
    const th = thread({ text: 'ENG-123 investigating' })
    const linked = linkIncidents([ticket({}), ticket({ ticketId: 'id-2', identifier: 'ENG-124' })], [th])
    const claims = linked.filter((i) => i.thread === th)
    expect(claims).toHaveLength(1)
  })
})

import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openTestDb } from './helpers'
import { memoryRepo } from '../db/repos/memory'
import { searchMemory } from '../memory/search'

let db: Database.Database
beforeEach(() => {
  db = openTestDb()
})

const row = (id: string, source: 'linear' | 'slack', over: Record<string, unknown> = {}) => ({
  id,
  source,
  title: 'checkout 5xx timeout spike',
  symptoms: 'checkout returning 5xx settlement timeout errors',
  resolutionSteps: [],
  labels: [],
  updatedAt: 1,
  ...over,
})

describe('cross-source linking', () => {
  it('slackIdsMentioning finds threads that reference a ticket', () => {
    const memory = memoryRepo(db)
    memory.upsert(row('slack:100', 'slack', { title: 'checkout broken, tracking in ENG-500', rawCommentsJson: '{"threadReplies":[]}' }))
    memory.upsert(row('slack:200', 'slack', { title: 'unrelated' }))
    expect(memory.slackIdsMentioning('ENG-500')).toEqual(['slack:100'])
  })

  it('linkTo cross-references both directions and search collapses the pair to one hit', async () => {
    const memory = memoryRepo(db)
    memory.upsert(row('linear:abc', 'linear', { identifier: 'ENG-500', rootCause: 'settlement timeout commit a41f9c2' }))
    memory.upsert(row('slack:100', 'slack', { rootCause: 'ISP DNS block' }))
    memory.linkTo('linear:abc', 'slack:100')

    // both rows match the query, but they are one incident → exactly one hit
    // (which sibling wins depends on rank; the contract is that it's collapsed)
    const res = await searchMemory(db, false, null, 'checkout 5xx settlement timeout')
    const pair = res.hits.filter((h) => ['linear:abc', 'slack:100'].includes(h.record.id))
    expect(pair).toHaveLength(1)
  })
})

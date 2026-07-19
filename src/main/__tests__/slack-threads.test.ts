import type Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openTestDb } from './helpers'
import { slackThreadsRepo } from '../db/repos/slackThreads'
import { memoryRepo } from '../db/repos/memory'

let db: Database.Database
beforeEach(() => {
  db = openTestDb()
})

describe('slack_threads tracker (freeze fix)', () => {
  it('changed() is true for a new thread, false after record, true again when replies grow', () => {
    const t = slackThreadsRepo(db)
    expect(t.changed('1751364000.0001', 0)).toBe(true) // never seen
    t.record('1751364000.0001', 0)
    expect(t.changed('1751364000.0001', 0)).toBe(false) // seen, unchanged
    expect(t.changed('1751364000.0001', 3)).toBe(true) // 3 replies arrived → re-fetch
    t.record('1751364000.0001', 3)
    expect(t.changed('1751364000.0001', 3)).toBe(false)
  })

  it('a re-distill after new replies bumps updated_at so skip-unchanged sees the change', () => {
    // This is the core of the freeze bug: a thread first stored at its head
    // time, then re-stored once the diagnosis lands, must register as changed.
    const memory = memoryRepo(db)
    const headTime = 1_751_364_000_000
    const replyTime = headTime + 90 * 60_000 // diagnosis 90 min later

    // first sync: head only, activity == head
    memory.upsert({ id: 'slack:1751364000.0001', source: 'slack', title: 'checkout 5xx', symptoms: 'checkout throwing 5xx', resolutionSteps: [], labels: [], updatedAt: headTime })
    expect(memory.updatedAtOf('slack:1751364000.0001')).toBe(headTime)

    // second sync after replies: activity advances → row updates, not skipped
    memory.upsert({ id: 'slack:1751364000.0001', source: 'slack', title: 'checkout 5xx', symptoms: 'checkout throwing 5xx', rootCause: 'settlement timeout commit', resolutionSteps: [], labels: [], updatedAt: replyTime })
    const rec = memory.get('slack:1751364000.0001')!
    expect(memory.updatedAtOf('slack:1751364000.0001')).toBe(replyTime)
    expect(rec.rootCause).toBe('settlement timeout commit') // the diagnosis is now captured
  })
})

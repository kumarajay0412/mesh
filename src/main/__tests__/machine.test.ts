import { describe, expect, it } from 'vitest'
import { canTransition, nextStage } from '../engine/machine'

describe('engine state machine', () => {
  it('moves strictly forward one stage at a time', () => {
    expect(canTransition('intake', 'scope')).toBe(true)
    expect(canTransition('scope', 'investigate')).toBe(true)
    expect(canTransition('investigate', 'report')).toBe(true)
    expect(canTransition('intake', 'investigate')).toBe(false)
    expect(canTransition('report', 'intake')).toBe(false)
    expect(canTransition('scope', 'intake')).toBe(false)
  })

  it('any live stage can abandon; abandoned is terminal', () => {
    expect(canTransition('intake', 'abandoned')).toBe(true)
    expect(canTransition('investigate', 'abandoned')).toBe(true)
    expect(canTransition('abandoned', 'intake')).toBe(false)
    expect(canTransition('abandoned', 'abandoned')).toBe(false)
  })

  it('nextStage walks the pipeline', () => {
    expect(nextStage('intake')).toBe('scope')
    expect(nextStage('investigate')).toBe('report')
    expect(nextStage('report')).toBeNull()
  })
})

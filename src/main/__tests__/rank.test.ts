import { describe, expect, it } from 'vitest'
import { fuse, toMatchExpr } from '../memory/rank'

describe('reciprocal rank fusion', () => {
  it('items in both lists outrank single-list items', () => {
    const fused = fuse(
      [],
      [
        { label: 'lexical', rowids: [1, 2, 3] },
        { label: 'semantic', rowids: [3, 4, 5] },
      ],
      10,
    )
    expect(fused[0].rowid).toBe(3)
    expect(fused[0].matched).toBe('hybrid')
  })

  it('signature hits pin above everything and dedupe', () => {
    const fused = fuse(
      [7, 3],
      [
        { label: 'lexical', rowids: [1, 3] },
        { label: 'semantic', rowids: [3, 1] },
      ],
      10,
    )
    expect(fused[0]).toMatchObject({ rowid: 7, matched: 'signature' })
    expect(fused[1]).toMatchObject({ rowid: 3, matched: 'signature' })
    // 3 must not appear again from the fused lists
    expect(fused.filter((f) => f.rowid === 3)).toHaveLength(1)
  })

  it('respects the limit', () => {
    const fused = fuse([], [{ label: 'lexical', rowids: [1, 2, 3, 4, 5] }], 2)
    expect(fused).toHaveLength(2)
  })
})

describe('toMatchExpr', () => {
  it('builds OR-joined quoted terms and drops short tokens', () => {
    expect(toMatchExpr('pods dying at settlement')).toBe('"pods" OR "dying" OR "settlement"')
  })

  it('neutralizes FTS special syntax by quoting', () => {
    expect(toMatchExpr('error NEAR "quotes"')).toBe('"error" OR "near" OR "quotes"')
  })

  it('null for effectively empty queries', () => {
    expect(toMatchExpr('a b')).toBeNull()
  })
})

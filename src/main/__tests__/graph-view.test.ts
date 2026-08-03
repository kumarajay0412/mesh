// graph-view: normalization of NetworkX node-link JSON (the shape graphify
// writes) and subgraph selection — top-N by degree, BFS focus neighborhoods,
// and the defensive paths (edges key variant, dangling edges, object endpoints).
import { describe, expect, it } from 'vitest'
import { normalizeGraph, selectSubgraph } from '../repos/graph-view'

const star = (hub: string, spokes: number) => ({
  nodes: [{ id: hub, label: hub, community: 0, community_name: 'core' }, ...Array.from({ length: spokes }, (_, i) => ({ id: `${hub}_s${i}`, label: `${hub}Spoke${i}`, community: 1, community_name: 'leaf' }))],
  links: Array.from({ length: spokes }, (_, i) => ({ source: hub, target: `${hub}_s${i}`, relation: 'calls', confidence: i % 2 ? 'INFERRED' : 'EXTRACTED' })),
})

describe('normalizeGraph', () => {
  it('reads nodes, links, degree; tolerates the edges key and object endpoints', () => {
    const g = normalizeGraph({
      nodes: [{ id: 'a', label: 'A' }, { id: 'b' }, { id: 7, label: 'seven' }],
      edges: [
        { source: 'a', target: 'b', relation: 'imports' },
        { source: { id: 'a' }, target: 7, confidence: 'INFERRED' },
        { source: 'a', target: 'ghost' }, // dangling — dropped
      ],
    })
    expect(g.nodes.size).toBe(3)
    expect(g.nodes.get('b')!.label).toBe('b') // id fallback when label missing
    expect(g.links).toHaveLength(2)
    expect(g.degree.get('a')).toBe(2)
    expect(g.links[1]).toMatchObject({ source: 'a', target: '7', confidence: 'INFERRED' })
  })

  it('reads the real graphify 0.9.x node shape (source_file, numeric community)', () => {
    const g = normalizeGraph({
      nodes: [{ id: 'capture_capture', label: 'capture.go', community: 0, source_file: 'capture/capture.go', _origin: 'ast' }],
      links: [],
    })
    const n = g.nodes.get('capture_capture')!
    expect(n.file).toBe('capture/capture.go')
    expect(n.community).toBe(0)
    expect(n.communityName).toBeUndefined() // --code-only never names communities
  })
})

describe('selectSubgraph', () => {
  it('no focus → top-N by degree, edges only among selected, honest truncation', () => {
    const data = star('hub', 30)
    const g = normalizeGraph(data)
    const v = selectSubgraph(g, { limit: 10 })
    expect(v.nodes).toHaveLength(10)
    expect(v.nodes[0].id).toBe('hub') // highest degree first
    // every edge's endpoints are in the selection
    const ids = new Set(v.nodes.map((n) => n.id))
    expect(v.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true)
    expect(v.truncated).toBe(true)
    expect(v.totals).toEqual({ nodes: 31, edges: 30, communities: 2 })
  })

  it('focus → BFS neighborhood around the match, match ids reported', () => {
    // two disconnected stars; focusing one must not leak the other
    const a = star('alpha', 5)
    const b = star('beta', 5)
    const g = normalizeGraph({ nodes: [...a.nodes, ...b.nodes], links: [...a.links, ...b.links] })
    const v = selectSubgraph(g, { focus: 'alphaSpoke2', limit: 50 })
    expect(v.focusIds).toEqual(['alpha_s2'])
    const ids = new Set(v.nodes.map((n) => n.id))
    expect(ids.has('alpha')).toBe(true) // one hop away
    expect([...ids].some((id) => id.startsWith('beta'))).toBe(false) // disconnected
  })

  it('focus respects the limit breadth-first (close context wins)', () => {
    const g = normalizeGraph(star('hub', 40))
    const v = selectSubgraph(g, { focus: 'hub', limit: 12 })
    expect(v.nodes.length).toBeLessThanOrEqual(12)
    expect(v.focusIds.length).toBeGreaterThan(0)
  })

  it('community names survive into the view', () => {
    const v = selectSubgraph(normalizeGraph(star('hub', 3)), {})
    expect(v.nodes.find((n) => n.id === 'hub')?.communityName).toBe('core')
  })
})

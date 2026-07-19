import { describe, expect, it } from 'vitest'
import { parseMapExtraction } from '../registry/map-extract'

const wrap = (obj: unknown) => `Here is the map:\n${JSON.stringify(obj)}\nDone.`

describe('parseMapExtraction', () => {
  it('parses a valid extraction and normalizes ids to kebab-case', () => {
    const out = parseMapExtraction(
      wrap({
        nodes: [
          { id: 'Web App', label: 'Web App (frontend)', kind: 'frontend' },
          { id: 'orders_service', label: 'Orders', kind: 'backend', repo: 'orders' },
        ],
        edges: [{ from: 'Web App', to: 'orders_service', label: 'REST', kind: 'http' }],
      }),
    )!
    expect(out.nodes.map((n) => n.id)).toEqual(['web-app', 'orders-service'])
    expect(out.edges).toEqual([{ from: 'web-app', to: 'orders-service', label: 'REST', kind: 'http' }])
  })

  it('drops edges pointing at nodes that were not emitted, and self-edges', () => {
    const out = parseMapExtraction(
      wrap({
        nodes: [{ id: 'api', label: 'API', kind: 'backend' }],
        edges: [
          { from: 'api', to: 'ghost-service', kind: 'http' },
          { from: 'api', to: 'api', kind: 'http' },
        ],
      }),
    )!
    expect(out.nodes).toHaveLength(1)
    expect(out.edges).toHaveLength(0)
  })

  it('tolerates junk kinds via catch fallbacks', () => {
    const out = parseMapExtraction(
      wrap({
        nodes: [{ id: 'thing', label: 'Thing', kind: 'quantum' }],
        edges: [],
      }),
    )!
    expect(out.nodes[0].kind).toBe('backend')
  })

  it('dedupes nodes by normalized id — first mention wins', () => {
    const out = parseMapExtraction(
      wrap({
        nodes: [
          { id: 'api-gateway', label: 'Gateway A', kind: 'edge' },
          { id: 'API Gateway', label: 'Gateway B', kind: 'backend' },
        ],
        edges: [],
      }),
    )!
    expect(out.nodes).toHaveLength(1)
    expect(out.nodes[0].label).toBe('Gateway A')
  })

  it('returns null on garbage, empty nodes, or missing JSON', () => {
    expect(parseMapExtraction('no json here')).toBeNull()
    expect(parseMapExtraction('{ broken json')).toBeNull()
    expect(parseMapExtraction(wrap({ nodes: [], edges: [] }))).toBeNull()
  })
})

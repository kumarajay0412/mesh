// Graphify repo-graph helpers: path shape and availability detection against a
// real temp directory — availableGraphs must only advertise graphs that exist,
// so the runbook never sends the agent to a missing file.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { availableGraphs, graphJsonPath, hasGraph } from '../repos/graphify'

let root: string
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('graphify availability', () => {
  it('advertises only repos whose graph.json actually exists', () => {
    root = mkdtempSync(join(tmpdir(), 'mesh-graphify-'))
    for (const name of ['payments', 'search', 'gateway']) mkdirSync(join(root, name), { recursive: true })
    // payments has a graph; search has the dir but no graph.json; gateway has nothing
    mkdirSync(join(root, 'payments', 'graphify-out'), { recursive: true })
    writeFileSync(graphJsonPath(join(root, 'payments')), '{}')
    mkdirSync(join(root, 'search', 'graphify-out'), { recursive: true })

    const graphs = availableGraphs(root, ['payments', 'search', 'gateway'])
    expect([...graphs.keys()]).toEqual(['payments'])
    expect(graphs.get('payments')).toBe(join(root, 'payments', 'graphify-out', 'graph.json'))

    expect(hasGraph(join(root, 'payments'))).toBe(true)
    expect(hasGraph(join(root, 'search'))).toBe(false)
  })
})

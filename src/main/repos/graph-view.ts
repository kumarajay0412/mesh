// Trimmed views over graphify's graph.json for the Code graph tab.
//
// graph.json is NetworkX node-link JSON and can be tens of MB — the renderer
// never sees the raw file. The main process parses it (size-capped, cached by
// mtime) and returns a SUBGRAPH: either the top-N nodes by degree (the "map"
// view — god nodes and their neighborhoods) or a BFS neighborhood around a
// search match. Pure selection logic lives here, separated from IO, so tests
// drive it directly.
import { readFileSync, statSync } from 'node:fs'
import type { CodeGraphEdge, CodeGraphNode, CodeGraphViewData } from '../../shared/types'
import { log } from '../log'

const l = log('graph-view')

/** Refuse to parse absurd files — a graph this big is a bug upstream, and
 *  JSON.parse on it would stall the main process. */
const MAX_GRAPH_BYTES = 80 * 1024 * 1024

interface RawNode {
  id?: unknown
  label?: unknown
  community?: unknown
  community_name?: unknown
  file?: unknown
  source_file?: unknown
  source?: unknown
}
interface RawLink {
  source?: unknown
  target?: unknown
  relation?: unknown
  confidence?: unknown
}

export interface NormalizedGraph {
  nodes: Map<string, { id: string; label: string; community?: number; communityName?: string; file?: string }>
  links: { source: string; target: string; relation?: string; confidence?: 'EXTRACTED' | 'INFERRED' }[]
  degree: Map<string, number>
}

/** node-link JSON → a defensive normalized shape. Tolerates the `links` vs
 *  `edges` key, numeric ids, endpoint objects, and dangling edges. */
export function normalizeGraph(data: unknown): NormalizedGraph {
  const d = (data ?? {}) as { nodes?: RawNode[]; links?: RawLink[]; edges?: RawLink[] }
  const nodes = new Map<string, { id: string; label: string; community?: number; communityName?: string; file?: string }>()
  for (const n of d.nodes ?? []) {
    if (n?.id === undefined || n.id === null) continue
    const id = String(n.id)
    nodes.set(id, {
      id,
      label: typeof n.label === 'string' && n.label ? n.label : id,
      community: typeof n.community === 'number' ? n.community : undefined,
      communityName: typeof n.community_name === 'string' ? n.community_name : undefined,
      // node source file — key name varies across graphify versions
      // (0.9.x --code-only writes source_file)
      file: typeof n.source_file === 'string' ? n.source_file : typeof n.file === 'string' ? n.file : typeof n.source === 'string' ? n.source : undefined,
    })
  }

  const endpoint = (v: unknown): string | null => {
    if (typeof v === 'string' || typeof v === 'number') return String(v)
    if (v && typeof v === 'object' && 'id' in (v as object)) return String((v as { id: unknown }).id)
    return null
  }

  const links: NormalizedGraph['links'] = []
  const degree = new Map<string, number>()
  for (const e of d.links ?? d.edges ?? []) {
    const s = endpoint(e?.source)
    const t = endpoint(e?.target)
    if (!s || !t || !nodes.has(s) || !nodes.has(t)) continue // dangling — skip
    links.push({
      source: s,
      target: t,
      relation: typeof e.relation === 'string' ? e.relation : undefined,
      confidence: e.confidence === 'INFERRED' ? 'INFERRED' : e.confidence === 'EXTRACTED' ? 'EXTRACTED' : undefined,
    })
    degree.set(s, (degree.get(s) ?? 0) + 1)
    degree.set(t, (degree.get(t) ?? 0) + 1)
  }
  return { nodes, links, degree }
}

/** Pick the subgraph to show: BFS around the best focus matches, or top-N by
 *  degree. Edges are those with BOTH endpoints selected. */
export function selectSubgraph(g: NormalizedGraph, opts: { focus?: string; limit?: number }): Omit<CodeGraphViewData, 'repo' | 'builtAtCommit'> {
  const limit = Math.max(10, Math.min(opts.limit ?? 100, 400))
  const focus = opts.focus?.trim().toLowerCase()

  let picked: string[] = []
  let focusIds: string[] = []
  if (focus) {
    const matches = [...g.nodes.values()]
      .filter((n) => n.label.toLowerCase().includes(focus) || n.id.toLowerCase().includes(focus))
      .sort((a, b) => (g.degree.get(b.id) ?? 0) - (g.degree.get(a.id) ?? 0))
    focusIds = matches.slice(0, 5).map((n) => n.id)
    // BFS out from the matches, breadth-first so close context wins.
    const seen = new Set<string>(focusIds)
    let frontier = [...focusIds]
    const adj = new Map<string, string[]>()
    for (const e of g.links) {
      ;(adj.get(e.source) ?? adj.set(e.source, []).get(e.source)!).push(e.target)
      ;(adj.get(e.target) ?? adj.set(e.target, []).get(e.target)!).push(e.source)
    }
    while (frontier.length > 0 && seen.size < limit) {
      const next: string[] = []
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (seen.size >= limit) break
          if (!seen.has(nb)) {
            seen.add(nb)
            next.push(nb)
          }
        }
      }
      frontier = next
    }
    picked = [...seen]
  } else {
    picked = [...g.nodes.keys()].sort((a, b) => (g.degree.get(b) ?? 0) - (g.degree.get(a) ?? 0)).slice(0, limit)
  }

  const sel = new Set(picked)
  const nodes: CodeGraphNode[] = picked.map((id) => {
    const n = g.nodes.get(id)!
    return { id: n.id, label: n.label, community: n.community, communityName: n.communityName, degree: g.degree.get(id) ?? 0, file: n.file }
  })
  const edges: CodeGraphEdge[] = g.links.filter((e) => sel.has(e.source) && sel.has(e.target))

  const communities = new Set([...g.nodes.values()].map((n) => n.community).filter((c): c is number => c !== undefined))
  return {
    nodes,
    edges,
    focusIds,
    totals: { nodes: g.nodes.size, edges: g.links.length, communities: communities.size },
    truncated: g.nodes.size > nodes.length,
  }
}

/* ------------------------------------------------------------------ cache -- */

const cache = new Map<string, { mtimeMs: number; graph: NormalizedGraph }>()

/** Parse a graph.json with an mtime cache — repeated views/searches of the
 *  same repo cost one parse, not one per keystroke. */
export function loadGraph(path: string): NormalizedGraph {
  const st = statSync(path)
  if (st.size > MAX_GRAPH_BYTES) throw new Error(`graph.json too large (${Math.round(st.size / 1e6)}MB) — rebuild it, something is wrong`)
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.graph
  const graph = normalizeGraph(JSON.parse(readFileSync(path, 'utf8')))
  cache.set(path, { mtimeMs: st.mtimeMs, graph })
  l.info(`parsed ${path}: ${graph.nodes.size} nodes, ${graph.links.length} edges`)
  return graph
}

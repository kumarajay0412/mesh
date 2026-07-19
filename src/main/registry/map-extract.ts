// Universal knowledge-map seeding: the user pastes a plain-language
// description of THEIR system (or their architecture doc), one cheap LLM call
// extracts nodes + edges, and they land as ordinary map rows the user can
// edit. This replaces the old hardcoded seed — Mesh ships knowing nothing
// about anyone's org.
// Pure parsing/validation lives here; the LLM call is injected by the caller.
import { z } from 'zod'
import type { MapEdge, MapNode } from '../../shared/types'

const MAX_NODES = 40
const MAX_EDGES = 80

export const EXTRACT_SYSTEM = `You turn a plain-language description of a software system into a service map.
Answer ONLY a JSON object:
{
  "nodes": [{ "id": "kebab-case-service-id", "label": "Human Name (role)", "kind": "frontend|edge|backend|ml|external|datastore|infra", "repo": "repo-name if stated", "notes": "one operational fact if stated" }],
  "edges": [{ "from": "node-id", "to": "node-id", "label": "what flows / which API", "kind": "http|ws|graphql|queue|db|deploys|observes|other" }]
}
Rules: ids are stable kebab-case names of the ACTUAL services mentioned — never invent
services that are not in the text. Every edge endpoint must be a node id you emitted.
Prefer fewer, real things over exhaustive guesses.`

const NodeSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(120),
  kind: z.enum(['frontend', 'edge', 'backend', 'ml', 'external', 'datastore', 'infra']).catch('backend'),
  repo: z.string().max(120).optional(),
  notes: z.string().max(400).optional(),
})

const EdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().max(160).optional(),
  kind: z.enum(['http', 'ws', 'graphql', 'queue', 'db', 'deploys', 'observes', 'other']).catch('other'),
})

const ExtractionSchema = z.object({
  nodes: z.array(NodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
})

export interface MapExtraction {
  nodes: (Omit<MapNode, 'id'> & { id: string })[]
  edges: { from: string; to: string; label?: string; kind: MapEdge['kind'] }[]
}

/** "Speech Orchestrator" / "speech_orchestrator" → "speech-orchestrator" */
function kebab(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Raw LLM output → validated, capped, id-normalized extraction.
 *  Edges pointing at unknown nodes are dropped, not guessed at. */
export function parseMapExtraction(raw: string): MapExtraction | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const res = ExtractionSchema.safeParse(parsed)
  if (!res.success) return null

  const nodes = res.data.nodes.slice(0, MAX_NODES).map((n) => ({ ...n, id: kebab(n.id) })).filter((n) => n.id.length > 0)
  // dedupe by id — first mention wins
  const seen = new Set<string>()
  const uniqueNodes = nodes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))

  const ids = new Set(uniqueNodes.map((n) => n.id))
  const edges = res.data.edges
    .slice(0, MAX_EDGES)
    .map((e) => ({ ...e, from: kebab(e.from), to: kebab(e.to) }))
    .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)

  if (uniqueNodes.length === 0) return null
  return { nodes: uniqueNodes, edges }
}

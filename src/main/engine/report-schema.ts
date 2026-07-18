import { z } from 'zod'
import type { Report } from '../../shared/types'

const Confidence = z.enum(['suspected', 'probable', 'confirmed'])

/** Tolerant timestamp: agents emit null / ISO strings / epoch numbers for
 *  fields they half-know. NEVER reject a report over a decorative field. */
const num0 = z.preprocess((v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const p = Date.parse(v)
    if (!Number.isNaN(p)) return p
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0 // null / undefined / junk → epoch 0, report survives
}, z.number())

export const ReportSchema = z.object({
  hypothesis: z.string().min(1),
  confidence: Confidence,
  culprit: z.object({ repo: z.string(), sha: z.string(), path: z.string() }).optional(),
  suspects: z
    .array(
      z.object({
        sha: z.string(),
        repo: z.string(),
        path: z.string().optional(),
        title: z.string(),
        author: z.string().optional(),
        confidence: Confidence,
        signals: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  evidence: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(['grafana', 'logql', 'promql', 'kubectl', 'commit', 'sentry', 'file', 'memory']),
        claim: z.string(),
        source: z.string(),
        href: z.string().optional(),
        snippet: z.string().optional(),
        ts: num0,
      }),
    )
    .default([]),
  timeline: z
    .array(z.object({ ts: num0, label: z.string(), kind: z.enum(['symptom', 'deploy', 'anomaly', 'action']) }))
    .default([]),
  suggestedFix: z.string().default(''),
  unexplored: z.array(z.string()).default([]),
  /** structured, team-readable root cause — tolerant: a malformed section
   *  drops to undefined rather than sinking the whole report */
  rootCauseDetail: z
    .object({
      points: z.array(z.string()).default([]),
      services: z
        .array(
          z.object({
            name: z.string().min(1),
            verdict: z.enum(['culprit', 'contributing', 'affected', 'cleared']).catch('affected'),
            points: z.array(z.string()).default([]),
          }),
        )
        .optional(),
      redHerrings: z.array(z.string()).optional(),
      unknowns: z.array(z.string()).optional(),
      metrics: z
        .array(
          z.object({
            label: z.string().min(1),
            unit: z.string().optional(),
            points: z.array(z.object({ x: z.string(), y: z.number() })).max(60),
            highlightX: z.string().optional(),
            note: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional()
    .catch(undefined),
  /** operational learnings — reusable "where to look" knowledge, user-gated */
  learnings: z.array(z.string()).default([]),
  /** structural map deltas discovered during the investigation, user-gated */
  mapUpdates: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        label: z.string().optional(),
        kind: z.enum(['http', 'ws', 'graphql', 'queue', 'db', 'deploys', 'observes', 'other']).optional(),
      }),
    )
    .default([]),
})

/** Pull the ```mesh-report fenced block out of the agent's final output. */
export function extractReport(text: string): Report | null {
  const m = text.match(/```mesh-report\s*\n([\s\S]*?)```/)
  if (!m) return null
  try {
    return ReportSchema.parse(JSON.parse(m[1])) as Report
  } catch {
    return null
  }
}

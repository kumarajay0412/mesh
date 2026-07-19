// The distill pass (Section 7.1): one LLM call per incident turns a 100-comment wall
// into the structured fields memory is queried on. The LLM callable is
// INJECTED — this module stays provider-agnostic and unit-testable, and when
// no provider is configured we fall back to an honest heuristic (marked so).
import { z } from 'zod'
import type { DistilledIncident, LinkedIncident } from './types'
import { extractSignature } from '../memory/signature'

export type LlmOneShot = (system: string, prompt: string) => Promise<string>

export const DistilledSchema = z.object({
  symptoms: z.string().min(1),
  rootCause: z.string().optional(),
  resolution: z.string().optional(),
  investigationSummary: z.string().optional(),
  resolutionSteps: z.array(z.string()).default([]),
  errorSignature: z.string().optional(),
})

const SYSTEM = `You distill engineering incident threads into structured memory for later retrieval.
Answer with ONLY a JSON object matching:
{
  "symptoms": "what was observed, concrete (error text, metrics, timing)",
  "rootCause": "the actual cause, if the thread establishes one",
  "resolution": "what fixed it",
  "investigationSummary": "the diagnosis path, one compact paragraph, in order",
  "resolutionSteps": ["ordered, reusable steps that worked"],
  "errorSignature": "exceptionType:topFrameOrComponent — only if a concrete error/stack appears"
}
Omit fields the thread does not support. Never invent a root cause.`

export async function distillIncident(incident: LinkedIncident, llm: LlmOneShot): Promise<DistilledIncident> {
  const text = incidentText(incident)
  try {
    const raw = await llm(SYSTEM, text)
    const json = extractJson(raw)
    return DistilledSchema.parse(json)
  } catch {
    // skip-and-log semantics live in the caller; here we degrade per-record
    return heuristicDistill(incident)
  }
}

/** No-LLM fallback: truncation-based fields, clearly weaker but never blocking. */
export function heuristicDistill(incident: LinkedIncident): DistilledIncident {
  const title = incident.ticket?.title ?? incident.thread?.text.slice(0, 120) ?? ''
  const description = incident.ticket?.description ?? incident.thread?.text ?? ''
  const comments = [...(incident.ticket?.comments ?? []), ...(incident.thread?.replies ?? [])].sort((a, b) => a.createdAt - b.createdAt)
  const allText = [description, ...comments.map((c) => c.body)].join('\n')
  const last = comments[comments.length - 1]?.body ?? ''
  return {
    symptoms: `${title}. ${description}`.slice(0, 600).trim(),
    // Even without an LLM, a stated cause is often right there ("root cause: …",
    // "turned out to be …") — extract it rather than omitting rootCause entirely.
    rootCause: extractCauseHint(allText),
    // A trailing "thanks!" is an ack, not a resolution — don't store it as one.
    resolution: last && !isAck(last) ? last.slice(0, 400) : undefined,
    resolutionSteps: [],
    errorSignature: findSignature(allText),
  }
}

/** Pull a stated cause out of free text (heuristic, no LLM). */
function extractCauseHint(text: string): string | undefined {
  const m = text.match(/\b(?:root cause|caused by|turned out (?:to be|that)|due to|because|the (?:issue|problem|bug) was|it was)\b[:\s]+([^\n.]{6,200})/i)
  return m ? m[1].trim() : undefined
}

/** Is this comment just an acknowledgement, not a diagnosis/fix? */
function isAck(text: string): boolean {
  return /^\s*(?:thanks?|thank you|ty|great|awesome|perfect|ok(?:ay)?|resolved|fixed|done|👍|🙏|✅)[\s!.]*$/i.test(text.trim().slice(0, 40))
}

/** Pull an exceptionType:frame fingerprint out of free text when one exists. */
// Ingest and query MUST canonicalize identically or the exact-match stage
// never fires — delegate to the one shared extractor.
export function findSignature(text: string): string | undefined {
  return extractSignature(text) ?? undefined
}

export function incidentText(incident: LinkedIncident): string {
  const parts: string[] = []
  if (incident.ticket) {
    const t = incident.ticket
    parts.push(`# Ticket ${t.identifier ?? t.ticketId}: ${t.title}`, t.description)
    parts.push(`state: ${t.state ?? 'unknown'} · labels: ${t.labels.join(', ')}`)
    for (const c of t.comments) parts.push(`[comment · ${c.author ?? '?'}] ${c.body}`)
  }
  if (incident.thread) {
    parts.push(`# Slack thread`, incident.thread.text)
    for (const r of incident.thread.replies) parts.push(`[reply · ${r.author ?? '?'}] ${r.body}`)
  }
  // Bound the prompt: keep head + tail when monstrous (the resolution is at the end).
  const full = parts.join('\n\n')
  if (full.length <= 24_000) return full
  return `${full.slice(0, 12_000)}\n\n[… truncated …]\n\n${full.slice(-12_000)}`
}

function extractJson(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no JSON object in response')
  return JSON.parse(raw.slice(start, end + 1))
}

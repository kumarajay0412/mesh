// In-process MCP tools that give the AGENT mid-session access to the org
// incident memory (Section 7). Intake injects a one-shot snapshot of similar
// incidents; these tools let the session re-query as the investigation narrows
// — a freshly extracted error signature or service name is a better query than
// the opening symptoms. Read-only by construction; auto-allowed by the gate
// (see providers/readonly.ts) and visible on the timeline like any tool call.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Database } from 'better-sqlite3'
import type { MemoryRecord, MemorySearchHit } from '../../shared/types'
import { memoryRepo } from '../db/repos/memory'
import { searchMemory } from '../memory/search'
import type { Embeddings } from '../memory/embeddings'

const clip = (s: string | undefined | null, n: number): string => {
  const t = (s ?? '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

const when = (r: MemoryRecord): string => {
  const ts = r.resolvedAt ?? r.reportedAt ?? r.updatedAt
  return ts ? new Date(ts).toISOString().slice(0, 10) : '?'
}

/** One search hit → compact prompt-friendly text. Pure; unit-tested. */
export function formatHit(h: MemorySearchHit): string {
  const r = h.record
  const lines = [
    `[${r.identifier ?? r.id}] ${r.title} (${r.source} · ${when(r)} · matched: ${h.matched})`,
    `  symptoms: ${clip(r.symptoms, 240) || '—'}`,
  ]
  if (r.rootCause) lines.push(`  root cause: ${clip(r.rootCause, 240)}`)
  if (r.resolution) lines.push(`  fix: ${clip(r.resolution, 240)}`)
  return lines.join('\n')
}

/** Full single-record view for get_incident, discussion thread included. */
export function formatRecord(r: MemoryRecord, discussion: string): string {
  const parts = [
    `[${r.identifier ?? r.id}] ${r.title}`,
    `source: ${r.source} · date: ${when(r)}${r.labels.length ? ` · labels: ${r.labels.join(', ')}` : ''}`,
    `symptoms: ${clip(r.symptoms, 1200) || '—'}`,
  ]
  if (r.errorSignature) parts.push(`error signature: ${r.errorSignature}`)
  if (r.rootCause) parts.push(`root cause: ${clip(r.rootCause, 800)}`)
  if (r.resolution) parts.push(`resolution: ${clip(r.resolution, 800)}`)
  if (r.resolutionSteps?.length) parts.push(`steps that worked: ${r.resolutionSteps.join(' → ')}`)
  if (r.investigationSummary) parts.push(`investigation: ${clip(r.investigationSummary, 600)}`)
  if (discussion) parts.push(`--- discussion (bounded) ---\n${discussion}`)
  return parts.join('\n')
}

/** Head+tail of the raw comment thread — resolution talk lives at the end. */
function boundedDiscussion(rawJson: string | undefined, budget = 4000): string {
  if (!rawJson) return ''
  try {
    const raw = JSON.parse(rawJson) as {
      ticketComments?: { body: string; author?: string }[]
      threadReplies?: { body: string; author?: string }[]
    }
    const text = [...(raw.ticketComments ?? []), ...(raw.threadReplies ?? [])].map((c) => `[${c.author ?? '?'}] ${c.body}`).join('\n')
    if (text.length <= budget) return text
    return `${text.slice(0, budget / 2)}\n[… trimmed …]\n${text.slice(-budget / 2)}`
  } catch {
    return ''
  }
}

/** Build the per-session `memory` MCP server. `excludeIdentifier` keeps the
 *  ticket under investigation out of its own search results (its content is
 *  already in the prompt; during benchmarks the guard hides it entirely). */
export function buildMemoryMcp(db: Database, vecAvailable: boolean, embeddings: Embeddings | null, excludeIdentifier?: string) {
  const self = excludeIdentifier?.toUpperCase()
  return createSdkMcpServer({
    name: 'memory',
    version: '1.0.0',
    tools: [
      tool(
        'search_memory',
        'Search the org incident memory (Linear tickets, Slack reports, past Mesh investigations). Hybrid retrieval: error-signature exact match, keyword BM25, and semantic vectors. Call it again whenever you extract a NEW error signature, symptom phrasing, or service name — the similar-incidents block in your context was matched only against the opening symptoms.',
        {
          query: z.string().describe('symptoms, error text, stack frame, or service name'),
          limit: z.number().int().min(1).max(10).optional().describe('max results (default 6)'),
        },
        async ({ query, limit }) => {
          const r = await searchMemory(db, vecAvailable, embeddings, query)
          const hits = r.hits.filter((h) => !self || (h.record.identifier ?? '').toUpperCase() !== self).slice(0, limit ?? 6)
          const note = r.semantic ? '' : '\n(lexical-only — semantic index unavailable right now)'
          return {
            content: [{ type: 'text' as const, text: hits.length ? hits.map(formatHit).join('\n---\n') + note : `no matches in memory${note}` }],
          }
        },
      ),
      tool(
        'get_incident',
        'Fetch ONE record from memory — a ticket identifier (ENG-3443) or a memory id exactly as shown in search results (slack:<ts>, mesh:INV-016). Returns the full distilled record plus a bounded slice of its discussion thread. Use after search_memory surfaces a promising hit.',
        { id: z.string().describe('ticket identifier like ENG-3443, or a memory id like slack:<ts>') },
        async ({ id }) => {
          const memory = memoryRepo(db)
          const key = id.trim()
          const rec = memory.byIdentifier(key.toUpperCase()) ?? memory.getWithRaw(key)
          return {
            content: [
              {
                type: 'text' as const,
                text: rec ? formatRecord(rec, boundedDiscussion(rec.rawCommentsJson)) : `no memory record for ${key}`,
              },
            ],
          }
        },
      ),
    ],
  })
}

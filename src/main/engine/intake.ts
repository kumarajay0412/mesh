// Stage 1 · Intake (Section 5): extract symptoms / service mentions / time window
// from the raw input, then query memory for similar past incidents.
// LLM-assisted when a provider is available; honest heuristics otherwise.
import { z } from 'zod'
import type { IntakeInput } from '../../shared/types'
import type { Provider } from '../providers/types'
import { log } from '../log'

const l = log('intake')

export interface IntakeResult {
  title: string
  symptoms: string
  serviceMentions: string[]
  timeWindow?: string
}

const IntakeSchema = z.object({
  title: z.string().min(1),
  symptoms: z.string().min(1),
  serviceMentions: z.array(z.string()).default([]),
  timeWindow: z.string().optional(),
})

const SYSTEM = `Extract investigation intake fields from an incident description.
Answer ONLY a JSON object: { "title": "short title", "symptoms": "concrete observed symptoms",
"serviceMentions": ["raw service names mentioned"], "timeWindow": "onset time/window if stated" }`

export async function runIntake(input: IntakeInput, provider: Provider | null): Promise<IntakeResult> {
  const raw = [input.title, input.ticketRef, input.pasted].filter(Boolean).join('\n')

  if (provider) {
    try {
      const out = await provider.oneShot(SYSTEM, raw)
      const start = out.indexOf('{')
      const end = out.lastIndexOf('}')
      if (start >= 0 && end > start) {
        return IntakeSchema.parse(JSON.parse(out.slice(start, end + 1)))
      }
    } catch (e) {
      l.warn('LLM intake failed, using heuristics:', (e as Error).message)
    }
  }

  // Heuristic fallback — never blocks starting an investigation.
  return {
    title: (input.title ?? input.pasted?.split('\n')[0] ?? input.ticketRef ?? 'Untitled investigation').slice(0, 120),
    symptoms: input.pasted ?? input.title ?? input.ticketRef ?? '',
    serviceMentions: extractServiceMentions(raw),
    timeWindow: raw.match(/\b(?:since|at|around|from)\s+([\d:apm\s~-]+(?:UTC|IST|Z)?)/i)?.[1]?.trim(),
  }
}

function extractServiceMentions(text: string): string[] {
  // kebab-case tokens are how services are named in this world (payments-api…)
  const tokens = text.match(/\b[a-z][a-z0-9]+(?:-[a-z0-9]+)+\b/g) ?? []
  return [...new Set(tokens)].slice(0, 8)
}

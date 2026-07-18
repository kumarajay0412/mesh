// Learned-context selection: which accepted learnings ride in THIS prompt.
//   small library (≤ threshold) → all of them (nothing to lose)
//   large library → vector-relevant top-K for the current symptoms
//                   + a recency floor of the newest few (fresh knowledge is
//                     often about the current state of the org)
// Vec unavailable/model cold → honest fallback to newest-N.
import type { Database } from 'better-sqlite3'
import { learningsRepo } from '../db/repos/learnings'
import type { Embeddings } from './embeddings'

// Inject-all only while the library is small — each learning rides in EVERY
// prompt, so this threshold is a token budget, not a capability limit
// (relevance-selection covers the rest).
const INJECT_ALL_THRESHOLD = 15
const RELEVANT_K = 12
const RECENCY_FLOOR = 5

export async function selectLearnings(
  db: Database,
  vecAvailable: boolean,
  embeddings: Embeddings | null,
  queryText: string,
): Promise<string[]> {
  const repo = learningsRepo(db)
  const total = repo.acceptedCount()
  if (total === 0) return []
  if (total <= INJECT_ALL_THRESHOLD) return repo.acceptedTexts(INJECT_ALL_THRESHOLD)

  if (!vecAvailable || !embeddings?.ready || !queryText.trim()) {
    return repo.acceptedTexts(INJECT_ALL_THRESHOLD) // degraded but functional
  }

  try {
    const qv = await embeddings.embedQuery(queryText)
    const hits = db
      .prepare(
        `SELECT learning_id AS id, distance
         FROM learnings_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(Buffer.from(qv.buffer), RELEVANT_K * 2) as { id: number | bigint; distance: number }[]

    const relevant = repo.textsByIds(hits.map((h) => Number(h.id))) // accepted-only hydration
    const byId = new Map(relevant.map((r) => [r.id, r.text]))
    const ordered = hits.map((h) => byId.get(Number(h.id))).filter((t): t is string => !!t)

    const newest = repo.acceptedTexts(RECENCY_FLOOR)
    const seen = new Set<string>()
    const out: string[] = []
    for (const t of [...ordered.slice(0, RELEVANT_K), ...newest]) {
      if (!seen.has(t)) {
        seen.add(t)
        out.push(t)
      }
    }
    return out
  } catch {
    return repo.acceptedTexts(INJECT_ALL_THRESHOLD)
  }
}

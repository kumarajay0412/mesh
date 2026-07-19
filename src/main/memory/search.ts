// Hybrid memory search (Section 7.1):
//   1. error-signature exact match  — highest precision, pinned first
//   2. FTS5 BM25                    — exact tokens: error codes, SHAs, paths
//   3. sqlite-vec KNN               — paraphrase ("pods dying" ≈ "OOMKilled")
//   → signature-pinned Reciprocal Rank Fusion (rank.ts)
// The vec stage is ADDITIVE: absent model/extension, results are lexical-only
// and the response says so (`semantic: false`).
import type { Database } from 'better-sqlite3'
import type { MemorySearchResult } from '../../shared/types'
import { memoryRepo, rowToRecord } from '../db/repos/memory'
import { extractSignature, isSpecificSignature } from './signature'
import { fuse, toMatchExpr, type RankedList } from './rank'
import type { Embeddings } from './embeddings'

const LIMIT = 12
const CANDIDATES = 24

export async function searchMemory(
  db: Database,
  vecAvailable: boolean,
  embeddings: Embeddings | null,
  query: string,
): Promise<MemorySearchResult> {
  const memory = memoryRepo(db)
  const q = query.trim()
  if (!q) return { hits: [], semantic: false }

  // 1 · signature — only a FRAME-QUALIFIED signature (Error:frame) is specific
  // enough to pin above ranking; a bare type ('TypeError') collides across
  // unrelated incidents, so it contributes via lexical instead.
  const sig = extractSignature(q)
  const sigRows = isSpecificSignature(sig) ? memory.bySignature(sig!, 5) : []

  // 2 · lexical
  const matchExpr = toMatchExpr(q)
  const lexRows = matchExpr ? memory.lexical(matchExpr, CANDIDATES) : []
  const lists: RankedList[] = [{ label: 'lexical', rowids: lexRows.map((r) => r.rowid) }]

  // 3 · semantic (additive)
  let semantic = false
  if (vecAvailable && embeddings?.ready) {
    try {
      const qv = await embeddings.embedQuery(q)
      const vecRows = db
        .prepare(
          `SELECT memory_rowid AS rowid, distance
           FROM memory_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(Buffer.from(qv.buffer), CANDIDATES) as { rowid: number | bigint; distance: number }[]
      lists.push({ label: 'semantic', rowids: vecRows.map((r) => Number(r.rowid)) })
      semantic = true
    } catch {
      // vec failure is never fatal — stay lexical
    }
  }

  const fused = fuse(sigRows.map((r) => r.rowid), lists, LIMIT)

  // hydrate records in fused order
  const rows = memory.byRowids(fused.map((f) => f.rowid))
  const byRowid = new Map(rows.map((r) => [r.rowid, r]))
  // Collapse cross-source siblings: a Linear ticket and its Slack thread about
  // the same outage are one incident — keep the higher-ranked, drop the other.
  const emitted = new Set<string>()
  const hits = fused
    .map((f) => {
      const row = byRowid.get(f.rowid)
      if (!row) return null
      if (emitted.has(row.id)) return null // its sibling already surfaced
      emitted.add(row.id)
      if (row.linked_id) emitted.add(row.linked_id)
      return { record: rowToRecord(row), score: f.score, matched: f.matched }
    })
    .filter((h): h is NonNullable<typeof h> => h !== null)

  return { hits, semantic }
}

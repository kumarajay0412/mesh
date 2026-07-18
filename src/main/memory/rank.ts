// Reciprocal Rank Fusion — merges lexical + semantic result lists without
// score normalization or tuning. Signature hits are pinned above everything.
// Pure module: no Electron, no DB — unit-tested directly.

export interface RankedList {
  /** rowids in rank order, best first */
  rowids: number[]
  label: 'lexical' | 'semantic'
}

export interface FusedHit {
  rowid: number
  score: number
  matched: 'signature' | 'lexical' | 'semantic' | 'hybrid'
}

const K = 60 // standard RRF constant

export function fuse(signatureRowids: number[], lists: RankedList[], limit: number): FusedHit[] {
  const scores = new Map<number, { score: number; sources: Set<string> }>()

  for (const list of lists) {
    list.rowids.forEach((rowid, i) => {
      const cur = scores.get(rowid) ?? { score: 0, sources: new Set<string>() }
      cur.score += 1 / (K + i + 1)
      cur.sources.add(list.label)
      scores.set(rowid, cur)
    })
  }

  const fused: FusedHit[] = [...scores.entries()]
    .map(([rowid, { score, sources }]) => ({
      rowid,
      score,
      matched: (sources.size > 1 ? 'hybrid' : [...sources][0]) as FusedHit['matched'],
    }))
    .sort((a, b) => b.score - a.score)

  // Signature matches pin to the top, deduped, best-first order preserved.
  const sig = new Set(signatureRowids)
  const pinned: FusedHit[] = signatureRowids.map((rowid) => ({ rowid, score: 1, matched: 'signature' }))
  const rest = fused.filter((h) => !sig.has(h.rowid))
  return [...pinned, ...rest].slice(0, limit)
}

/** Build an FTS5 MATCH expression from free text: salient terms, OR-joined —
 *  recall-leaning; BM25 does the precision work. */
export function toMatchExpr(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((w) => w.length >= 3)
    .slice(0, 12)
    // FTS5 special chars are neutralized by quoting each term
    .map((w) => `"${w.replace(/"/g, '')}"`)
  return terms.length ? terms.join(' OR ') : null
}

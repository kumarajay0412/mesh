import { useEffect, useState } from 'react'
import type { KnowledgeStore } from '@shared/types'
import { getApi } from '../../lib/api'

/** One tile per knowledge store: what it is, how many rows, how indexed.
 *  The honest version of "how big is the brain" — including zeros, which are
 *  usually the actionable part (a source connected but not yet yielding). */
export function StoreCounters() {
  const [stores, setStores] = useState<KnowledgeStore[] | null>(null)

  useEffect(() => {
    let alive = true
    void getApi()
      .then((a) => a.getContextSummary())
      .then((c) => alive && setStores(c.stores))
      .catch(() => alive && setStores(null))
    return () => {
      alive = false
    }
  }, [])

  if (!stores) return null
  // Every store, zeros included — a connected source at 0 is the actionable
  // state (unshared pages, un-invited bot), and hiding it would bury that.
  // Only skip when the whole brain is empty (fresh install: one big zero grid
  // says less than the empty-state prose below).
  if (stores.every((s) => s.count === 0)) return null

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stores.map((s) => {
        const drained = s.embedded !== undefined && s.embedded < s.count
        return (
          <div key={s.id} className="rounded-md border border-line bg-ink-900 px-3 py-2.5" title={s.desc}>
            <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">{s.label}</div>
            <div className={`mt-0.5 font-mono text-[17px] ${s.count === 0 ? 'text-subtle' : 'text-txt'}`}>{s.count.toLocaleString('en-US')}</div>
            <div className="truncate text-[10.5px] leading-tight text-subtle">
              {drained ? `${s.embedded!.toLocaleString('en-US')} embedded — indexing…` : s.desc}
            </div>
          </div>
        )
      })}
    </div>
  )
}

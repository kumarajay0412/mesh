import { useEffect } from 'react'
import { useMemory } from '../stores/memory'
import { ScreenHeader } from '../components/layout/ScreenHeader'
import { SearchBar } from '../components/memory/SearchBar'
import { MemoryResult } from '../components/memory/MemoryResult'
import { SyncPanel } from '../components/memory/SyncPanel'
import { ModelStatusPill } from '../components/memory/ModelStatusPill'
import { StoreCounters } from '../components/memory/StoreCounters'
import { EmptyState } from '../components/ui'

export function Memory() {
  const { init, search, searching, result, query, syncStates, progress, model, refresh } = useMemory()

  useEffect(() => {
    void init()
  }, [init])

  return (
    <div className="mx-auto max-w-[880px] px-8 py-7">
      <ScreenHeader eyebrow="Incident memory" title="Memory" right={<ModelStatusPill status={model} />} />

      <div className="mt-5">
        <StoreCounters />
      </div>

      <div className="mt-4">
        <SearchBar onSearch={(q) => void search(q)} searching={searching} />
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {result && result.hits.length > 0 && result.hits.map((h) => <MemoryResult key={h.record.id} hit={h} />)}

        {result && result.hits.length === 0 && query && (
          <EmptyState title="No matches" note={`Nothing in memory matches "${query}" — new territory, or worded very differently.`} />
        )}

        {!result && (
          <div className="rounded-md border border-dashed border-line bg-surface px-5 py-6 text-center">
            <p className="text-[13px] text-muted">
              Search the org's incident history — seeded from Linear and Slack #reporting, grown by every investigation.
            </p>
            <p className="mt-1 font-mono text-[11px] text-subtle">"has this happened before?" · "how did we fix it?" · "how did the investigation go?"</p>
          </div>
        )}

        <SyncPanel states={syncStates} progress={progress} onRefresh={() => void refresh()} />
      </div>
    </div>
  )
}

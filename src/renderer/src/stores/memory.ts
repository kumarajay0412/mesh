import { create } from 'zustand'
import type { MemorySearchResult, ModelStatus, SyncProgressEvent, SyncSourceState } from '@shared/types'
import { getApi } from '../lib/api'

interface MemoryState {
  query: string
  result: MemorySearchResult | null
  searching: boolean
  syncStates: SyncSourceState[]
  progress: Record<string, SyncProgressEvent>
  model: ModelStatus
  wired: boolean

  init: () => Promise<void>
  search: (q: string) => Promise<void>
  refresh: () => Promise<void>
}

export const useMemory = create<MemoryState>((set, get) => ({
  query: '',
  result: null,
  searching: false,
  syncStates: [],
  progress: {},
  model: { state: 'idle' },
  wired: false,

  init: async () => {
    if (get().wired) return
    const api = await getApi()
    set({ wired: true, syncStates: await api.syncStates() })
    api.onSyncProgress((e) => {
      set((s) => ({ progress: { ...s.progress, [e.source]: e } }))
      if (e.phase === 'done') void api.syncStates().then((syncStates) => set({ syncStates }))
    })
    api.onModelStatus((model) => set({ model }))
  },

  search: async (query) => {
    set({ query, searching: true })
    const api = await getApi()
    const result = await api.searchMemory(query)
    // Ignore stale responses: only apply if the query is still current.
    if (get().query === query) {
      set({ result, searching: false })
      // Results are ground truth: a semantic search proves the model is live
      // even if the boot-time status event was missed.
      if (result.semantic && get().model.state !== 'ready') set({ model: { state: 'ready' } })
    }
  },

  refresh: async () => {
    const api = await getApi()
    set({ progress: {} })
    await api.refresh()
  },
}))

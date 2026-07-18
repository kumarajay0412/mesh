import { create } from 'zustand'
import type { ServiceEntry } from '@shared/types'
import { getApi } from '../lib/api'

interface RegistryState {
  services: ServiceEntry[]
  loaded: boolean
  editing: ServiceEntry | null

  load: () => Promise<void>
  edit: (s: ServiceEntry | null) => void
  save: (s: ServiceEntry) => Promise<void>
}

export const useRegistry = create<RegistryState>((set, get) => ({
  services: [],
  loaded: false,
  editing: null,

  load: async () => {
    const api = await getApi()
    set({ services: await api.listServices(), loaded: true })
  },
  edit: (editing) => set({ editing }),
  save: async (entry) => {
    const api = await getApi()
    await api.saveService(entry)
    set({ editing: null })
    await get().load()
  },
}))

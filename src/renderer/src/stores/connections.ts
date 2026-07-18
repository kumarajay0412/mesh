import { create } from 'zustand'
import type { ConnectionInfo, SourceId } from '@shared/types'
import { getApi } from '../lib/api'

interface ConnectionsState {
  list: ConnectionInfo[]
  loaded: boolean
  wizardOpen: SourceId | null

  load: () => Promise<void>
  openWizard: (id: SourceId | null) => void
  connect: (id: SourceId, fields: Record<string, string>) => Promise<{ ok: boolean; message?: string }>
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  list: [],
  loaded: false,
  wizardOpen: null,

  load: async () => {
    const api = await getApi()
    set({ list: await api.listConnections(), loaded: true })
  },
  openWizard: (wizardOpen) => set({ wizardOpen }),
  connect: async (id, fields) => {
    const api = await getApi()
    const res = await api.setSecret(id, fields)
    await get().load()
    return res
  },
}))

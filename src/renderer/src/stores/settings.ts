import { create } from 'zustand'
import type { SettingsState } from '@shared/types'
import { getApi } from '../lib/api'

interface SettingsStore {
  settings: SettingsState | null
  load: () => Promise<void>
  update: (patch: Partial<SettingsState>) => Promise<void>
}

export const useSettings = create<SettingsStore>((set) => ({
  settings: null,
  load: async () => {
    const api = await getApi()
    set({ settings: await api.getSettings() })
  },
  update: async (patch) => {
    const api = await getApi()
    set({ settings: await api.setSettings(patch) })
  },
}))

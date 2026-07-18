import { create } from 'zustand'

export type ScreenId =
  | 'investigations'
  | 'investigation'
  | 'report'
  | 'registry'
  | 'map'
  | 'memory'
  | 'connections'
  | 'settings'

interface AppState {
  screen: ScreenId
  activeInvestigationId: string | null
  go: (screen: ScreenId, investigationId?: string) => void
}

export const useApp = create<AppState>((set) => ({
  screen: 'investigations',
  activeInvestigationId: null,
  go: (screen, investigationId) =>
    set((s) => ({ screen, activeInvestigationId: investigationId ?? s.activeInvestigationId })),
}))

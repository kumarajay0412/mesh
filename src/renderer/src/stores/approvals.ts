import { create } from 'zustand'
import type { ApprovalRequest } from '@shared/types'
import { getApi } from '../lib/api'

/**
 * Global approval queue — the renderer half of the Section 10 per-action gate.
 * Main (or the mock) pushes requests; the ApprovalModal shows them one at a
 * time; responding resolves the blocked canUseTool promise on the other side.
 */
interface ApprovalsState {
  queue: ApprovalRequest[]
  wired: boolean
  init: () => Promise<void>
  respond: (id: string, approved: boolean, reason?: string) => Promise<void>
}

export const useApprovals = create<ApprovalsState>((set, get) => ({
  queue: [],
  wired: false,

  init: async () => {
    if (get().wired) return
    set({ wired: true })
    const api = await getApi()
    api.onApprovalRequest((r) => set((s) => ({ queue: [...s.queue, r] })))
  },

  respond: async (id, approved, reason) => {
    const api = await getApi()
    await api.respondApproval(id, approved, reason)
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }))
  },
}))

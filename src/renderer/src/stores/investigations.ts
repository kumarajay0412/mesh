import { create } from 'zustand'
import type { AgentEvent, IntakeInput, Investigation } from '@shared/types'
import { getApi } from '../lib/api'

// Synchronous in-flight guard: watch() is async, and React StrictMode fires
// mount→cleanup→mount faster than the first await resolves. Presence alone
// isn't enough (mount #2 re-adds the id before mount #1's await re-checks),
// so each attempt owns a TOKEN and only the current token may subscribe.
const watching = new Map<string, symbol>()

interface InvestigationsState {
  list: Investigation[]
  loaded: boolean
  timelines: Record<string, AgentEvent[]>
  /** live unsubscribe fns per investigation */
  subs: Record<string, () => void>
  /** latest engine transition per investigation — drives report auto-open */
  engineStates: Record<string, { stage: Investigation['stage']; status: Investigation['status'] }>

  load: () => Promise<void>
  start: (input: IntakeInput) => Promise<string>
  watch: (id: string) => Promise<void>
  unwatch: (id: string) => void
  steer: (id: string, text: string) => Promise<void>
  comment: (id: string, text: string) => Promise<void>
  interrupt: (id: string) => Promise<void>
  abandon: (id: string) => Promise<void>
}

let engineWired = false

export const useInvestigations = create<InvestigationsState>((set, get) => ({
  list: [],
  loaded: false,
  timelines: {},
  subs: {},
  engineStates: {},

  load: async () => {
    const api = await getApi()
    if (!engineWired) {
      engineWired = true
      api.onEngineState((s) => {
        set((st) => ({ engineStates: { ...st.engineStates, [s.investigationId]: { stage: s.stage, status: s.status } } }))
        void get().load() // list rows (status pills, report presence) refresh live
      })
    }
    const list = await api.listInvestigations()
    set({ list, loaded: true })
  },

  start: async (input) => {
    const api = await getApi()
    const { id } = await api.startInvestigation(input)
    await get().load()
    return id
  },

  watch: async (id) => {
    if (watching.has(id)) return
    const token = Symbol(id)
    watching.set(id, token)
    const api = await getApi()
    const replay = await api.getTimeline(id)
    if (watching.get(id) !== token) return // superseded or unwatched while awaiting
    set((s) => ({ timelines: { ...s.timelines, [id]: replay } }))
    const off = api.onAgentEvent(id, (e) => {
      set((s) => ({ timelines: { ...s.timelines, [id]: [...(s.timelines[id] ?? []), e] } }))
    })
    if (watching.get(id) !== token) {
      off() // raced an unwatch — drop the subscription immediately
      return
    }
    set((s) => ({ subs: { ...s.subs, [id]: off } }))
  },

  unwatch: (id) => {
    watching.delete(id)
    get().subs[id]?.()
    set((s) => {
      const subs = { ...s.subs }
      delete subs[id]
      return { subs }
    })
  },

  steer: async (id, text) => (await getApi()).steer(id, text),
  comment: async (id, text) => {
    // clear the stale 'report' state so the NEXT report emission re-triggers
    // the auto-open, then hand the feedback to the engine (session resumes)
    set((s) => {
      const engineStates = { ...s.engineStates }
      delete engineStates[id]
      return { engineStates }
    })
    await (await getApi()).comment(id, text)
  },
  interrupt: async (id) => (await getApi()).interrupt(id),
  abandon: async (id) => {
    const api = await getApi()
    await api.abandon(id)
    await get().load()
  },
}))

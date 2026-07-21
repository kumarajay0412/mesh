import { create } from 'zustand'
import { getApi } from '../lib/api'

/**
 * The embedded terminal drawer.
 *
 * Every session here is opened by a user gesture — a Log in button, or the
 * user opening a shell. The agent has no path to this store, and must not be
 * given one: keystrokes bypass the approval broker entirely (see
 * src/main/terminal/pty.ts).
 */
interface TerminalState {
  open: boolean
  /** null until the pty is spawned; set when main hands back a session id */
  sessionId: string | null
  title: string
  /** the command this session was opened to run, shown above the terminal */
  command: string | null
  error: string | null
  /** bumped whenever a session exits, so callers can re-check auth state */
  exitNonce: number

  /** Open the drawer running `command` (or a plain login shell when omitted). */
  launch: (opts: { title: string; command?: string }) => Promise<void>
  close: () => Promise<void>
}

export const useTerminal = create<TerminalState>((set, get) => ({
  open: false,
  sessionId: null,
  title: '',
  command: null,
  error: null,
  exitNonce: 0,

  launch: async ({ title, command }) => {
    // Replace any previous session rather than stacking shells.
    const prev = get().sessionId
    const api = await getApi()
    if (prev) await api.ptyKill(prev)

    set({ open: true, title, command: command ?? null, error: null, sessionId: null })
    const res = await api.ptySpawn({ command })
    if ('error' in res) {
      set({ error: res.error })
      return
    }
    set({ sessionId: res.id })
  },

  close: async () => {
    const id = get().sessionId
    set({ open: false, sessionId: null, command: null, error: null })
    if (id) (await getApi()).ptyKill(id)
  },
}))

/** Wire the exit stream once, so anything watching auth can re-check on exit. */
let wired = false
export async function wireTerminalEvents(): Promise<void> {
  if (wired) return
  wired = true
  const api = await getApi()
  api.onPtyExit(({ id }) => {
    if (useTerminal.getState().sessionId === id) {
      useTerminal.setState((s) => ({ exitNonce: s.exitNonce + 1 }))
    }
  })
}

// The embedded terminal.
//
// SECURITY — read this before touching anything here.
//
// Mesh's agent is read-only by construction: every command it runs passes the
// allowlist in providers/readonly.ts, and every mutation goes through the
// approval broker. A PTY is arbitrary code execution and honours none of that,
// so this module is deliberately NOT reachable by the agent:
//
//   * no SDK tool wraps it, and none may be added,
//   * the only entry points are the `pty:*` IPC channels, which are driven by
//     renderer user gestures,
//   * the engine never sees a session handle.
//
// The invariant is "a human typed this". If you ever expose a way for the model
// to write into a session, the read-only guarantee is gone — the approval
// broker cannot see keystrokes. src/main/__tests__/pty-isolation.test.ts pins
// this and should fail loudly rather than be updated.
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { PtyExit, PtySpawnRequest } from '../../shared/types'
import { log } from '../log'

const l = log('pty')

/** node-pty is CJS with a native binding; keep the import lazy so a machine
 *  where it failed to load still runs the rest of the app. */
type PtyProcess = {
  onData(cb: (d: string) => void): void
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void
  write(d: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
  readonly pid: number
}
type PtyModule = {
  spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess
}

let ptyModule: PtyModule | null = null
let loadError: string | null = null
async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule || loadError) return ptyModule
  try {
    // node-pty is CJS: depending on how the ESM/CJS interop resolves it, the
    // exports land either on the namespace or on `.default`. Take whichever
    // actually carries spawn rather than assuming the lexer found it.
    const mod = (await import('node-pty')) as unknown as PtyModule & { default?: PtyModule }
    ptyModule = typeof mod.spawn === 'function' ? mod : (mod.default ?? null)
    if (!ptyModule) throw new Error('node-pty loaded but exposes no spawn()')
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
    l.warn(`node-pty unavailable — terminal disabled: ${loadError}`)
  }
  return ptyModule
}

interface Session {
  id: string
  proc: PtyProcess
  /** everything written so far, so a remounting renderer can restore the view */
  scrollback: string
  exited: boolean
}

const MAX_SCROLLBACK = 256 * 1024 // plenty for a login flow; bounds memory
const MAX_SESSIONS = 8

export interface PtyHost {
  spawn(req: PtySpawnRequest): { id: string } | { error: string }
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  scrollback(id: string): string
  disposeAll(): void
}

/** Wire a PTY host to the renderer. `emit` streams data/exit back out. */
export function createPtyHost(emit: {
  data(p: { id: string; chunk: string }): void
  exit(p: PtyExit): void
}): PtyHost {
  const sessions = new Map<string, Session>()

  const host: PtyHost = {
    spawn(req) {
      if (!ptyModule) {
        // loadPty() is kicked off at startup; if it failed, say so plainly
        // rather than opening an empty black box the user can't diagnose.
        return { error: loadError ? `terminal unavailable: ${loadError}` : 'terminal still starting — try again' }
      }
      if (sessions.size >= MAX_SESSIONS) return { error: `too many terminals open (max ${MAX_SESSIONS})` }

      const shell = req.shell ?? process.env.SHELL ?? '/bin/zsh'
      // Always an interactive login shell, so the user's real PATH and aliases
      // apply and the session stays alive. A requested command is *typed into*
      // that shell once it's ready (see firstPrompt below) rather than passed
      // via -ilc, which would exit the moment the command finished and leave
      // the user staring at a dead pane.
      const args = ['-il']
      const id = randomUUID()
      try {
        const proc = ptyModule.spawn(shell, args, {
          name: 'xterm-256color',
          cols: req.cols ?? 80,
          rows: req.rows ?? 24,
          cwd: req.cwd ?? homedir(),
          env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
        })
        const s: Session = { id, proc, scrollback: '', exited: false }
        sessions.set(id, s)

        // Wait for the shell to print its first prompt before typing, otherwise
        // the keystrokes race rc-file loading and get swallowed.
        let pending = req.command ?? null
        proc.onData((chunk) => {
          s.scrollback = (s.scrollback + chunk).slice(-MAX_SCROLLBACK)
          emit.data({ id, chunk })
          if (pending) {
            const cmd = pending
            pending = null
            setTimeout(() => {
              if (!s.exited) proc.write(`${cmd}\n`)
            }, 120)
          }
        })
        proc.onExit(({ exitCode, signal }) => {
          s.exited = true
          sessions.delete(id)
          emit.exit({ id, exitCode, signal })
          l.info(`session ${id.slice(0, 8)} exited (code ${exitCode})`)
        })

        l.info(`session ${id.slice(0, 8)} spawned: ${shell} ${req.command ? `-ilc ${req.command}` : '-il'} (pid ${proc.pid})`)
        return { id }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        l.warn(`spawn failed: ${msg}`)
        return { error: msg }
      }
    },

    write(id, data) {
      sessions.get(id)?.proc.write(data)
    },
    resize(id, cols, rows) {
      try {
        sessions.get(id)?.proc.resize(Math.max(1, cols), Math.max(1, rows))
      } catch {
        /* a resize racing an exit is harmless */
      }
    },
    kill(id) {
      const s = sessions.get(id)
      if (!s || s.exited) return
      try {
        s.proc.kill()
      } catch {
        /* already gone */
      }
      sessions.delete(id)
    },
    scrollback(id) {
      return sessions.get(id)?.scrollback ?? ''
    },
    disposeAll() {
      for (const id of [...sessions.keys()]) host.kill(id)
    },
  }

  void loadPty()
  return host
}

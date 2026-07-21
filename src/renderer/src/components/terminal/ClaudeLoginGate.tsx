import { useEffect, useState } from 'react'
import type { ClaudeAuth } from '@shared/types'
import { getApi } from '../../lib/api'
import { useTerminal } from '../../stores/terminal'
import { Button, Modal } from '../ui'

/** Mesh runs on the user's own `claude` login rather than an API key, so a
 *  logged-out CLI means every investigation fails at the first turn. Catch it
 *  at launch and offer a one-click re-login in the embedded terminal, instead
 *  of surfacing an opaque SDK error halfway through a run. */
export function ClaudeLoginGate() {
  const [auth, setAuth] = useState<ClaudeAuth | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const { launch, exitNonce } = useTerminal()

  const check = async () => {
    const api = await getApi()
    setAuth(await api.getClaudeAuth())
  }

  // Re-check whenever a terminal session ends — the user may have just logged in.
  useEffect(() => {
    void check()
  }, [exitNonce])

  if (!auth || dismissed) return null
  if (auth.loggedIn) return null

  const notInstalled = !auth.installed
  const open = true

  return (
    <Modal open={open} onClose={() => setDismissed(true)} width={560}>
      <div className="border-b border-line px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-gold-400">Claude</div>
        <div className="mt-1 font-display text-[17px] font-semibold text-txt">
          {notInstalled ? 'Claude Code isn’t installed' : 'You’re signed out of Claude'}
        </div>
      </div>

      <div className="flex flex-col gap-3 px-5 py-4">
        <p className="text-[13.5px] leading-relaxed text-muted">
          {notInstalled ? (
            <>
              Mesh runs investigations through the <span className="font-mono text-txt">claude</span> CLI on your own login — it holds no API key of its own. Install
              Claude Code, then sign in.
            </>
          ) : (
            <>
              Mesh runs on your own Claude login, so investigations can’t start until you sign in again. This opens a terminal inside Mesh and runs the login for
              you — the browser step happens as usual.
            </>
          )}
        </p>

        <div className="select-all rounded-sm border border-line bg-ink-900 px-2.5 py-1.5 font-mono text-[11px] text-txt">
          {notInstalled ? 'npm install -g @anthropic-ai/claude-code' : 'claude auth login'}
        </div>

        {auth.error && <p className="font-mono text-[10.5px] text-subtle">{auth.error}</p>}

        <div className="mt-1 flex items-center justify-end gap-2">
          <Button variant="quiet" onClick={() => setDismissed(true)}>
            Later
          </Button>
          <Button
            onClick={() => {
              void launch({
                title: notInstalled ? 'Install Claude Code' : 'Sign in to Claude',
                command: notInstalled ? 'npm install -g @anthropic-ai/claude-code' : 'claude auth login',
              })
              setDismissed(true)
            }}
          >
            {notInstalled ? 'Install in terminal' : 'Log in'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

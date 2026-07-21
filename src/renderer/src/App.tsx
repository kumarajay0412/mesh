import { useEffect } from 'react'
import { TitleBar } from './components/layout/TitleBar'
import { Sidebar } from './components/layout/Sidebar'
import { ApprovalModal } from './components/approval/ApprovalModal'
import { Tour } from './components/onboarding/Tour'
import { TerminalDrawer } from './components/terminal/TerminalDrawer'
import { ClaudeLoginGate } from './components/terminal/ClaudeLoginGate'
import { wireTerminalEvents, useTerminal } from './stores/terminal'
import { useApp } from './stores/app'
import { useSettings } from './stores/settings'
import { Investigations } from './screens/Investigations'
import { InvestigationView } from './screens/InvestigationView'
import { Report } from './screens/Report'
import { Registry } from './screens/Registry'
import { KnowledgeMap } from './screens/KnowledgeMap'
import { Memory } from './screens/Memory'
import { Connections } from './screens/Connections'
import { Settings } from './screens/Settings'

export default function App() {
  const screen = useApp((s) => s.screen)
  const { settings, load } = useSettings()

  useEffect(() => {
    void load() // settings drive the theme, so load them at boot
    void wireTerminalEvents() // pty exit stream → re-check auth after a login
  }, [load])

  // ⌘J toggles the terminal, the way an editor would.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        const t = useTerminal.getState()
        if (t.open) void t.close()
        else void t.launch({ title: 'Terminal' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-ada-theme', settings?.theme ?? 'dark')
  }, [settings?.theme])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg text-txt">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {screen === 'investigations' && <Investigations />}
          {screen === 'investigation' && <InvestigationView />}
          {screen === 'report' && <Report />}
          {screen === 'registry' && <Registry />}
          {screen === 'map' && <KnowledgeMap />}
          {screen === 'memory' && <Memory />}
          {screen === 'connections' && <Connections />}
          {screen === 'settings' && <Settings />}
        </main>
      </div>
      {/* Section 10: the per-action gate lives above everything, always mounted */}
      <ApprovalModal />
      {/* embedded terminal — user-driven only; the agent has no route to it */}
      <TerminalDrawer />
      <ClaudeLoginGate />
      {/* onboarding: auto-opens on first run; the sidebar Tutorial button reopens it */}
      <Tour />
    </div>
  )
}

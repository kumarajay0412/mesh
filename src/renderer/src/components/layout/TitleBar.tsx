import type { CSSProperties } from 'react'
import { useApp } from '../../stores/app'
import { useSettings } from '../../stores/settings'
import { Dot } from '../ui'

const LABELS: Record<string, string> = {
  investigations: 'all',
  report: 'report',
  registry: 'registry',
  memory: 'memory',
  connections: 'connections',
  settings: 'settings',
}

/** Window chrome: breadcrumb + provider/read-only status, inset past the
 *  native macOS traffic lights. The whole bar is the Electron drag region. */
export function TitleBar() {
  const { screen, activeInvestigationId } = useApp()
  const provider = useSettings((s) => s.settings?.provider ?? 'claude')
  const crumb = screen === 'investigation' ? (activeInvestigationId ?? '—') : (LABELS[screen] ?? screen)

  return (
    <header
      className="drag flex h-11 shrink-0 items-center gap-3 border-b border-line bg-ink-900 pl-[88px] pr-4"
      style={{ WebkitAppRegion: 'drag' } as CSSProperties}
    >
      <div className="flex items-center gap-2 font-mono text-[12px] text-subtle">
        <span>Investigations</span>
        <span className="text-ink-500">/</span>
        <span className="text-muted">{crumb}</span>
      </div>

      <div className="flex-1" />

      <div className="flex items-center gap-2 font-mono text-[11px] text-subtle">
        <Dot tone="ok" />
        <span>{provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
        <span className="text-ink-500">·</span>
        <span>read-only</span>
      </div>
    </header>
  )
}

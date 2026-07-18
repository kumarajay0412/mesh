import type { ReactNode } from 'react'
import { useEffect } from 'react'
import { useApp, type ScreenId } from '../../stores/app'
import { useMemory } from '../../stores/memory'
import { timeAgo } from '../../lib/format'
import { Dot } from '../ui'
import { MeshMark } from '../ui/MeshMark'

interface NavItem {
  id: ScreenId
  label: string
  icon: ReactNode
}

const I = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
)

const NAV: NavItem[] = [
  { id: 'investigations', label: 'Investigations', icon: I('M3 6h18M3 12h18M3 18h12') },
  { id: 'memory', label: 'Memory', icon: I('M12 3a9 9 0 100 18 9 9 0 000-18zM12 8v4l3 2') },
  { id: 'registry', label: 'Service registry', icon: I('M4 7h16M4 12h16M4 17h16M8 4v16') },
  { id: 'map', label: 'Knowledge map', icon: I('M6 6m-2 0a2 2 0 104 0 2 2 0 10-4 0M18 6m-2 0a2 2 0 104 0 2 2 0 10-4 0M12 18m-2 0a2 2 0 104 0 2 2 0 10-4 0M7.5 7.5L10.5 16M16.5 7.5L13.5 16M8 6h8') },
  { id: 'connections', label: 'Connections', icon: I('M9 12l2 2 4-4M4 6h16v12H4z') },
  { id: 'settings', label: 'Settings', icon: I('M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1l2-1.6-2-3.4-2.3 1a7 7 0 00-1.7-1L14.5 2h-5l-.4 2.4a7 7 0 00-1.7 1l-2.3-1-2 3.4L3.1 11a7 7 0 000 2l-2 1.6 2 3.4 2.3-1a7 7 0 001.7 1l.4 2.4h5l.4-2.4a7 7 0 001.7-1l2.3 1 2-3.4-2-1.6a7 7 0 00.1-1z') },
]

export function Sidebar() {
  const { screen, go } = useApp()
  const { syncStates, init, refresh, progress } = useMemory()
  const active = screen === 'investigation' || screen === 'report' ? 'investigations' : screen

  useEffect(() => {
    void init()
  }, [init])

  const lastRun = syncStates.reduce<number | undefined>((acc, s) => (s.lastRunAt && (!acc || s.lastRunAt > acc) ? s.lastRunAt : acc), undefined)
  const running = Object.values(progress).some((p) => p.phase !== 'done' && p.phase !== 'error')

  return (
    <nav className="flex w-[228px] shrink-0 flex-col border-r border-line bg-ink-850">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <BrandMark />
        <div className="leading-tight">
          <div className="font-display text-[15px] font-semibold text-txt">Mesh</div>
          <div className="font-mono text-[10px] text-subtle">Incident Tracker</div>
        </div>
      </div>

      <div className="mt-1 flex flex-col gap-0.5 px-2.5">
        {NAV.map((item) => {
          const on = active === item.id
          return (
            <button
              key={item.id}
              onClick={() => go(item.id)}
              className={`no-drag group flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] transition-colors duration-100 ${
                on ? 'bg-raised text-txt' : 'text-muted hover:bg-ink-800 hover:text-txt'
              }`}
            >
              <span className={on ? 'text-gold-400' : 'text-subtle group-hover:text-muted'}>{item.icon}</span>
              <span className="font-medium">{item.label}</span>
            </button>
          )
        })}
      </div>

      <div className="flex-1" />

      <div className="m-2.5 rounded-md border border-line bg-ink-800 p-3">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Memory</span>
          <Dot tone={running ? 'live' : 'ok'} />
        </div>
        <div className="mt-1 text-[12px] text-muted">{running ? 'Syncing…' : `Synced ${timeAgo(lastRun)}`}</div>
        <button
          onClick={() => void refresh()}
          disabled={running}
          className="no-drag mt-2 w-full rounded-sm border border-line-strong py-1.5 text-[12px] font-medium text-txt transition-colors hover:bg-raised disabled:opacity-50"
        >
          Refresh
        </button>
      </div>
    </nav>
  )
}

function BrandMark() {
  return (
    <div className="grid h-8 w-8 place-items-center rounded-md border border-gold-600/50 bg-ink-900">
      <MeshMark size={20} />
    </div>
  )
}

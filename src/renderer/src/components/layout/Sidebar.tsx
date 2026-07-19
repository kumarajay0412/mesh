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

const I = (...ds: string[]) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {ds.map((d, i) => (
      <path key={i} d={d} />
    ))}
  </svg>
)

const NAV: NavItem[] = [
  { id: 'investigations', label: 'Investigations', icon: I('M3 6h18M3 12h18M3 18h12') },
  { id: 'memory', label: 'Memory', icon: I('M12 3a9 9 0 100 18 9 9 0 000-18zM12 8v4l3 2') },
  { id: 'registry', label: 'Service registry', icon: I('M4 7h16M4 12h16M4 17h16M8 4v16') },
  { id: 'map', label: 'Knowledge map', icon: I('M6 6m-2 0a2 2 0 104 0 2 2 0 10-4 0M18 6m-2 0a2 2 0 104 0 2 2 0 10-4 0M12 18m-2 0a2 2 0 104 0 2 2 0 10-4 0M7.5 7.5L10.5 16M16.5 7.5L13.5 16M8 6h8') },
  { id: 'connections', label: 'Connections', icon: I('M9 12l2 2 4-4M4 6h16v12H4z') },
  {
    id: 'settings',
    label: 'Settings',
    icon: I(
      'M12 9a3 3 0 100 6 3 3 0 000-6z',
      'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z',
    ),
  },
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

      <button
        onClick={() => useApp.getState().setTour(true)}
        className="no-drag mx-2.5 mb-1 flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-[13px] text-subtle transition-colors duration-100 hover:bg-ink-800 hover:text-muted"
      >
        {I('M12 17h.01', 'M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3', 'M12 3a9 9 0 100 18 9 9 0 000-18z')}
        <span className="font-medium">Tutorial</span>
      </button>

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

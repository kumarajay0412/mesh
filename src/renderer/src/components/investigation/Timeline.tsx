import { useEffect, useMemo, useRef } from 'react'
import type { AgentEvent } from '@shared/types'
import { TimelineEvent } from './TimelineEvent'
import { MeshMark } from '../ui/MeshMark'

type ToolResult = Extract<AgentEvent, { kind: 'tool_result' }>

/** The live agent stream. Auto-follows the tail unless the user scrolled up. */
export function Timeline({ events, working = false }: { events: AgentEvent[]; working?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const results = useMemo(() => {
    const m = new Map<string, ToolResult>()
    for (const e of events) if (e.kind === 'tool_result') m.set(e.id, e)
    return m
  }, [events])

  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [events])

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
      className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-4"
    >
      {events.length === 0 && (
        <div className="grid flex-1 place-items-center">
          <div className="flex flex-col items-center gap-3">
            <MeshMark size={28} spin />
            <span className="font-mono text-[12px] text-subtle">starting the agent…</span>
          </div>
        </div>
      )}
      {events.map((e, i) => (
        <TimelineEvent key={i} event={e} results={results} />
      ))}
      {working && events.length > 0 && (
        <div className="flex items-center gap-2.5 px-1 py-1.5">
          <MeshMark size={15} spin />
          <span className="font-mono text-[11.5px] text-gold-600" style={{ animation: 'meshPulse 1.4s ease-in-out infinite' }}>
            agent is working…
          </span>
        </div>
      )}
    </div>
  )
}

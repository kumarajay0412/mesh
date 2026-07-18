import type { AgentEvent } from '@shared/types'
import { clockTime } from '../../lib/format'
import { ToolCallRow } from './ToolCallRow'

type ToolResult = Extract<AgentEvent, { kind: 'tool_result' }>

/** Renders one timeline entry. tool_result events are absorbed by their call row. */
export function TimelineEvent({ event, results }: { event: AgentEvent; results: Map<string, ToolResult> }) {
  switch (event.kind) {
    case 'tool_call':
      return <ToolCallRow call={event} result={results.get(event.id)} />
    case 'tool_result':
      return null
    case 'reasoning':
      return (
        <div className="flex gap-2.5 px-1">
          <Rail label="reasoning" color="var(--ada-gray-600)" />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">{event.text}</p>
          <Ts ts={event.ts} />
        </div>
      )
    case 'finding':
      return (
        <div className="flex gap-2.5 rounded-md border border-gold-600/40 bg-[rgba(245,197,24,0.05)] px-3 py-2.5">
          <Rail label="finding" color="var(--ada-gold-400)" />
          <p className="min-w-0 flex-1 text-[13px] font-medium leading-relaxed text-txt">{event.text}</p>
          <Ts ts={event.ts} />
        </div>
      )
    case 'steered':
      return (
        <div className="flex gap-2.5 rounded-md border border-[color:var(--ada-info)]/40 bg-[rgba(79,167,218,0.06)] px-3 py-2.5">
          <Rail label="you" color="var(--ada-info)" />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-txt">{event.text}</p>
          <Ts ts={event.ts} />
        </div>
      )
    case 'status':
      return (
        <div className="flex items-center gap-2 px-1 font-mono text-[11px] text-subtle">
          <span className="h-px flex-1 bg-line" />
          {event.text}
          <span className="h-px flex-1 bg-line" />
        </div>
      )
    case 'stage':
      return (
        <div className="flex items-center gap-2 px-1 font-mono text-[11px] uppercase tracking-widest text-gold-600">
          <span className="h-px flex-1" style={{ background: 'var(--ada-gold-700)' }} />
          stage → {event.stage}
          <span className="h-px flex-1" style={{ background: 'var(--ada-gold-700)' }} />
        </div>
      )
    case 'error':
      return (
        <div className="rounded-md border border-[color:var(--ada-danger)]/40 bg-[rgba(242,102,74,0.06)] px-3 py-2.5 text-[13px] text-danger">
          {event.text}
        </div>
      )
    case 'evidence':
      return null // rendered in the evidence rail
    case 'done':
      return null
  }
}

function Rail({ label, color }: { label: string; color: string }) {
  return (
    <span className="mt-0.5 w-[68px] shrink-0 text-right font-mono text-[10px] uppercase tracking-wider" style={{ color }}>
      {label}
    </span>
  )
}

function Ts({ ts }: { ts: number }) {
  return <span className="shrink-0 font-mono text-[10px] text-subtle">{clockTime(ts)}</span>
}

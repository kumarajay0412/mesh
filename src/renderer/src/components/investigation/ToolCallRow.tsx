import { useState } from 'react'
import type { AgentEvent } from '@shared/types'

type ToolCall = Extract<AgentEvent, { kind: 'tool_call' }>
type ToolResult = Extract<AgentEvent, { kind: 'tool_result' }>

/** Collapsible tool invocation: label + args, and its paired result when it lands. */
export function ToolCallRow({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const [open, setOpen] = useState(false)
  const pending = !result
  return (
    <div className="rounded-md border border-line bg-ink-850">
      <button onClick={() => setOpen(!open)} className="no-drag flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded-sm border"
          style={{
            borderColor: pending ? 'var(--ada-gold-600)' : result.ok ? 'rgba(31,168,154,0.4)' : 'rgba(242,102,74,0.4)',
            color: pending ? 'var(--ada-gold-400)' : result.ok ? 'var(--ada-success)' : 'var(--ada-danger)',
          }}
        >
          {pending ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" style={{ animation: 'meshSpin 1.2s linear infinite' }}>
              <path d="M21 12a9 9 0 11-6.2-8.56" strokeLinecap="round" />
            </svg>
          ) : result.ok ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          )}
        </span>
        <span className="font-mono text-[11px] text-gold-400">{call.tool}</span>
        <span className="truncate text-[12px] text-muted">{call.title}</span>
        <div className="flex-1" />
        {result && <span className="max-w-[38%] truncate font-mono text-[11px] text-subtle">{result.summary}</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ada-gray-600)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? 'rotate(180deg)' : undefined, transition: 'transform 140ms' }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">args</div>
          <pre className="mt-1 overflow-x-auto rounded-sm bg-ink-900 p-2.5 font-mono text-[11px] leading-relaxed text-muted">
            {JSON.stringify(call.args, null, 2)}
          </pre>
          {result && (
            <>
              <div className="mt-2.5 font-mono text-[10px] uppercase tracking-widest text-subtle">result</div>
              <pre className="mt-1 overflow-x-auto rounded-sm bg-ink-900 p-2.5 font-mono text-[11px] leading-relaxed text-muted">
                {result.detail ?? result.summary}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

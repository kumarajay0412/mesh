import type { ReactNode } from 'react'
import type { RootCauseDetail, RootCauseService } from '@shared/types'
import { Card, Eyebrow } from '../ui'
import { MetricChart } from './MetricChart'

const VERDICT: Record<RootCauseService['verdict'], { label: string; color: string }> = {
  culprit: { label: 'CULPRIT', color: 'var(--ada-accent-coral)' },
  contributing: { label: 'CONTRIBUTING', color: 'var(--ada-gold-400)' },
  affected: { label: 'AFFECTED', color: 'var(--ada-accent-sky)' },
  cleared: { label: 'CLEARED', color: 'var(--ada-accent-teal)' },
}

/** Minimal inline markdown: **bold** and `code` — the two things reports use. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-semibold text-txt">
          {part.slice(2, -2)}
        </strong>
      )
    }
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="rounded-sm bg-ink-900 px-1 py-0.5 font-mono text-[12px] text-gold-400">
          {part.slice(1, -1)}
        </code>
      )
    }
    return <span key={i}>{part}</span>
  })
}

/** The team-readable root cause: the story in points, per-service views,
 *  measured charts, red herrings, and honest unknowns. */
export function RootCauseCard({ detail }: { detail: RootCauseDetail }) {
  return (
    <Card className="p-4">
      <Eyebrow>Root cause — the full story</Eyebrow>

      {detail.points.length > 0 && (
        <ol className="mt-3 space-y-2.5">
          {detail.points.map((p, i) => (
            <li key={i} className="flex gap-3">
              <span className="mt-0.5 h-5 w-5 shrink-0 rounded-full border border-gold-400/50 text-center font-mono text-[10.5px] leading-[18px] text-gold-400">
                {i + 1}
              </span>
              <p className="text-[13.5px] leading-relaxed text-muted">{inline(p)}</p>
            </li>
          ))}
        </ol>
      )}

      {detail.metrics?.map((m, i) => (
        <div key={i} className="mt-5 rounded-md border border-line bg-ink-900/60 p-3.5">
          <MetricChart metric={m} />
        </div>
      ))}

      {detail.services && detail.services.length > 0 && (
        <div className="mt-5">
          <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Service by service</span>
          <div className="mt-2 grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            {detail.services.map((s) => {
              const v = VERDICT[s.verdict]
              return (
                <div key={s.name} className="rounded-md border border-line bg-ink-850 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[12.5px] font-semibold text-txt">{s.name}</span>
                    <span
                      className="rounded-sm border px-1.5 py-0.5 font-mono text-[9px] tracking-wider"
                      style={{ borderColor: v.color, color: v.color }}
                    >
                      {v.label}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1.5">
                    {s.points.map((p, i) => (
                      <li key={i} className="flex gap-2 text-[12.5px] leading-relaxed text-muted">
                        <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-500" />
                        <span>{inline(p)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {detail.redHerrings && detail.redHerrings.length > 0 && (
        <div className="mt-4 rounded-md border border-[color:var(--ada-accent-coral)]/35 bg-ink-900/50 p-3">
          <span className="font-mono text-[10px] uppercase tracking-widest" style={{ color: 'var(--ada-accent-coral)' }}>
            Red herrings — looked causal, is not
          </span>
          <ul className="mt-1.5 space-y-1">
            {detail.redHerrings.map((r, i) => (
              <li key={i} className="text-[12.5px] leading-relaxed text-muted">
                {inline(r)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {detail.unknowns && detail.unknowns.length > 0 && (
        <div className="mt-3 rounded-md border border-line bg-ink-900/50 p-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Honest unknowns</span>
          <ul className="mt-1.5 space-y-1">
            {detail.unknowns.map((u, i) => (
              <li key={i} className="text-[12.5px] leading-relaxed text-subtle">
                {inline(u)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  )
}

import type { Report } from '@shared/types'
import { clockTime } from '../../lib/format'
import { Card, Eyebrow } from '../ui'

const KIND_COLOR: Record<Report['timeline'][number]['kind'], string> = {
  symptom: 'var(--ada-danger)',
  deploy: 'var(--ada-gold-400)',
  anomaly: 'var(--ada-warning)',
  action: 'var(--ada-info)',
}

/** Symptom onset vs deploys vs anomalies — the correlation at a glance. */
export function IncidentTimeline({ timeline }: { timeline: Report['timeline'] }) {
  const sorted = [...timeline].sort((a, b) => a.ts - b.ts)
  return (
    <Card className="p-4">
      <Eyebrow>Timeline</Eyebrow>
      <div className="relative mt-3 flex flex-col gap-0 pl-4">
        <span className="absolute bottom-2 left-[5px] top-2 w-px bg-line" />
        {sorted.map((t, i) => (
          <div key={i} className="relative flex items-baseline gap-3 py-1.5">
            <span className="absolute -left-4 top-[9px] h-2.5 w-2.5 rounded-full border-2 border-ink-900" style={{ background: KIND_COLOR[t.kind] }} />
            <span className="w-[74px] shrink-0 font-mono text-[11px] text-subtle">{clockTime(t.ts)}</span>
            <span className="font-mono text-[10px] uppercase tracking-wider" style={{ color: KIND_COLOR[t.kind] }}>{t.kind}</span>
            <span className="text-[13px] text-txt">{t.label}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

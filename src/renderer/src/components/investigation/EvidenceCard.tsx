import type { EvidenceItem, EvidenceType } from '@shared/types'

const TYPE_META: Record<EvidenceType, { label: string; color: string }> = {
  grafana: { label: 'GRAFANA', color: 'var(--ada-accent-sky)' },
  logql: { label: 'LOGQL', color: 'var(--ada-accent-teal)' },
  promql: { label: 'PROMQL', color: 'var(--ada-accent-teal)' },
  kubectl: { label: 'KUBECTL', color: 'var(--ada-accent-plum)' },
  commit: { label: 'COMMIT', color: 'var(--ada-gold-400)' },
  sentry: { label: 'SENTRY', color: 'var(--ada-accent-coral)' },
  file: { label: 'FILE', color: 'var(--ada-gray-400)' },
  memory: { label: 'MEMORY', color: 'var(--ada-accent-plum)' },
}

/** One sourced claim. The claim is the headline; the source is the proof. */
export function EvidenceCard({ item }: { item: EvidenceItem }) {
  const meta = TYPE_META[item.type]
  return (
    <div className="rounded-md border border-line bg-ink-850 p-3">
      <div className="flex items-center gap-2">
        <span className="rounded-sm border px-1.5 py-0.5 font-mono text-[9px] tracking-wider" style={{ borderColor: meta.color, color: meta.color }}>
          {meta.label}
        </span>
        <div className="flex-1" />
        {item.href && (
          <a href={item.href} target="_blank" rel="noreferrer" className="no-drag font-mono text-[10px] text-subtle underline-offset-2 hover:text-muted hover:underline">
            open ↗
          </a>
        )}
      </div>
      <p className="mt-2 text-[12.5px] font-medium leading-snug text-txt">{item.claim}</p>
      <div className="mt-1.5 break-all font-mono text-[10.5px] leading-relaxed text-subtle">{item.source}</div>
      {item.snippet && (
        <pre className="mt-2 overflow-x-auto rounded-sm bg-ink-900 p-2 font-mono text-[10.5px] leading-relaxed text-muted">{item.snippet}</pre>
      )}
    </div>
  )
}

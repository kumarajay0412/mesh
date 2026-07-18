import type { EvidenceItem } from '@shared/types'
import { EvidenceCard } from './EvidenceCard'

/** Right rail: every sourced claim accumulates here as it's made (Section 5, Section 9). */
export function EvidenceRail({ items }: { items: EvidenceItem[] }) {
  return (
    <aside className="flex w-[320px] shrink-0 flex-col border-l border-line bg-ink-900">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">Evidence</span>
        <span className="font-mono text-[11px] text-gold-400">{items.length}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {items.length === 0 && (
          <div className="mt-8 px-4 text-center font-mono text-[11px] leading-relaxed text-subtle">
            no evidence yet — every claim the agent makes lands here with its source
          </div>
        )}
        {items.map((e) => (
          <EvidenceCard key={e.id} item={e} />
        ))}
      </div>
    </aside>
  )
}

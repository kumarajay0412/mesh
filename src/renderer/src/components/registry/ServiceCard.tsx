import type { ServiceEntry } from '@shared/types'
import { Card, Pill } from '../ui'

/** One service knowledge card (Section 4): what it is, how it's served, its identifiers,
 *  and the standing solutions memory has promoted onto it. */
export function ServiceCard({ entry, onEdit }: { entry: ServiceEntry; onEdit: () => void }) {
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[14px] font-semibold text-txt">{entry.name}</span>
        <Pill tone={entry.source === 'manual' ? 'gold' : 'neutral'}>{entry.source.toUpperCase()}</Pill>
        <div className="flex-1" />
        <button onClick={onEdit} className="no-drag font-mono text-[11px] text-subtle hover:text-muted">
          edit
        </button>
      </div>

      {entry.does && <p className="mt-2 text-[13px] leading-snug text-muted">{entry.does}</p>}

      <div className="mt-3 flex flex-col gap-1.5 font-mono text-[11px]">
        <Row k="repo" v={entry.repo ?? '—'} />
        {entry.serving && <Row k="served" v={entry.serving} />}
        {Object.entries(entry.ids).map(([k, v]) => (
          <Row key={k} k={k} v={v} />
        ))}
        {entry.aliases.length > 0 && <Row k="aliases" v={entry.aliases.join(', ')} />}
      </div>

      {entry.knownSolutions.length > 0 && (
        <div className="mt-3 border-t border-line pt-2.5">
          <div className="font-mono text-[9px] uppercase tracking-widest text-gold-600">known solutions</div>
          {entry.knownSolutions.map((s, i) => (
            <div key={i} className="mt-1.5 text-[12px] leading-snug">
              <span className="text-muted">{s.symptom} → </span>
              <span className="text-txt">{s.fix}</span>
              {s.ref && <span className="ml-1 font-mono text-[10px] text-gold-600">[{s.ref}]</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-[84px] shrink-0 text-subtle">{k}</span>
      <span className="break-all text-muted">{v}</span>
    </div>
  )
}

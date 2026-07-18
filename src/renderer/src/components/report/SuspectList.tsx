import type { SuspectCommit } from '@shared/types'
import { shortSha } from '../../lib/format'
import { Card, ConfidenceBadge, Eyebrow, Pill } from '../ui'

/** Ranked suspect commits (Section 6.1) — a hypothesis list, never a verdict. */
export function SuspectList({ suspects }: { suspects: SuspectCommit[] }) {
  return (
    <Card className="p-4">
      <Eyebrow>Suspect commits · ranked</Eyebrow>
      <div className="mt-3 flex flex-col gap-2.5">
        {suspects.map((s, i) => (
          <div key={s.sha} className="flex items-start gap-3 rounded-md border border-line bg-ink-850 px-3 py-2.5">
            <span className="mt-0.5 font-mono text-[11px] text-subtle">#{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-sm border border-gold-600/50 px-1.5 font-mono text-[11px] text-gold-400">{shortSha(s.sha)}</span>
                <span className="font-mono text-[11px] text-subtle">{s.repo}</span>
                {s.author && <span className="font-mono text-[11px] text-subtle">· {s.author}</span>}
                <div className="flex-1" />
                <ConfidenceBadge value={s.confidence} />
              </div>
              <div className="mt-1 text-[13px] text-txt">{s.title}</div>
              {s.path && <div className="mt-0.5 break-all font-mono text-[11px] text-subtle">{s.path}</div>}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {s.signals.map((sig) => (
                  <Pill key={sig} tone="neutral">{sig}</Pill>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  )
}

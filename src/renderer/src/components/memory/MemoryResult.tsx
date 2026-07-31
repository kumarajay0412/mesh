import { useState } from 'react'
import type { MemorySearchHit } from '@shared/types'
import { timeAgo } from '../../lib/format'
import { Card, Pill } from '../ui'

/** One past incident: symptoms → resolution, with links back to the sources
 *  and the reusable step checklist behind a disclosure. */
export function MemoryResult({ hit }: { hit: MemorySearchHit }) {
  const { record } = hit
  const [showSteps, setShowSteps] = useState(false)
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        {record.identifier && <span className="font-mono text-[11px] text-gold-400">{record.identifier}</span>}
        <Pill tone={hit.matched === 'signature' ? 'gold' : hit.matched === 'semantic' ? 'info' : 'neutral'}>{hit.matched}</Pill>
        <Pill tone="neutral">{record.source}</Pill>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-subtle">{timeAgo(record.resolvedAt ?? record.updatedAt)}</span>
      </div>

      <div className="mt-2 text-[14.5px] font-medium text-txt">{record.title}</div>

      <div className="mt-2.5 grid gap-2 text-[13px] leading-relaxed">
        <Line label="symptoms" text={record.symptoms} />
        {record.rootCause && <Line label="root cause" text={record.rootCause} gold />}
        {record.resolution && <Line label="resolution" text={record.resolution} />}
      </div>

      {record.resolutionSteps && record.resolutionSteps.length > 0 && (
        <div className="mt-2.5">
          <button onClick={() => setShowSteps(!showSteps)} className="no-drag font-mono text-[11px] text-gold-600 hover:text-gold-400">
            {showSteps ? '▾' : '▸'} steps that worked ({record.resolutionSteps.length})
          </button>
          {showSteps && (
            <ol className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
              {record.resolutionSteps.map((s, i) => (
                <li key={i} className="font-mono text-[11.5px] leading-relaxed text-muted">
                  {i + 1}. {s}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      <div className="mt-3 flex gap-3 border-t border-line pt-2.5 font-mono text-[11px]">
        {record.identifier && <a className="no-drag text-subtle underline-offset-2 hover:text-muted hover:underline" href="#">{record.identifier} ↗</a>}
        {record.slackUrl && <a className="no-drag text-subtle underline-offset-2 hover:text-muted hover:underline" href={record.slackUrl} target="_blank" rel="noreferrer">slack thread ↗</a>}
        {record.url && (
          <a className="no-drag text-subtle underline-offset-2 hover:text-muted hover:underline" href={record.url} target="_blank" rel="noreferrer">
            open in {record.source === 'notion' ? 'Notion' : record.source === 'slack-corpus' ? 'Slack' : 'source'} ↗
          </a>
        )}
        <div className="flex-1" />
        <span className="text-subtle">score {hit.score.toFixed(2)}</span>
      </div>
    </Card>
  )
}

function Line({ label, text, gold }: { label: string; text: string; gold?: boolean }) {
  return (
    <div className="flex gap-2.5">
      <span className={`w-[76px] shrink-0 text-right font-mono text-[10px] uppercase tracking-wider ${gold ? 'text-gold-600' : 'text-subtle'}`} style={{ paddingTop: 3 }}>
        {label}
      </span>
      <span className="min-w-0 text-muted">{text}</span>
    </div>
  )
}

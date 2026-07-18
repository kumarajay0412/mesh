import type { SyncProgressEvent, SyncSourceState } from '@shared/types'
import { timeAgo } from '../../lib/format'
import { Button, Card, Dot, Eyebrow, Pill } from '../ui'

/** Per-source sync state + the Refresh action (Section 7.1 cursor-based incremental). */
export function SyncPanel({
  states,
  progress,
  onRefresh,
}: {
  states: SyncSourceState[]
  progress: Record<string, SyncProgressEvent>
  onRefresh: () => void
}) {
  const running = Object.values(progress).some((p) => p.phase !== 'done' && p.phase !== 'error')
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <Eyebrow>Ingestion · cursor-based</Eyebrow>
        <Button variant="primary" onClick={onRefresh} disabled={running}>
          {running ? 'Syncing…' : 'Refresh'}
        </Button>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {states.map((s) => {
          const p = progress[s.source]
          const active = p && p.phase !== 'done' && p.phase !== 'error'
          return (
            <div key={s.source} className="flex items-center gap-3 rounded-md border border-line bg-ink-850 px-3 py-2.5">
              <Dot tone={active ? 'live' : s.status === 'needs-connection' ? 'warn' : s.status === 'error' ? 'danger' : 'ok'} />
              <span className="font-mono text-[12px] text-txt">{s.source}</span>
              {s.status === 'needs-connection' && <Pill tone="warn">needs connection</Pill>}
              <div className="flex-1" />
              {active ? (
                <span className="font-mono text-[11px] text-gold-400">
                  {p.phase} {p.total ? `${p.done}/${p.total}` : ''}
                </span>
              ) : (
                <span className="font-mono text-[11px] text-subtle">
                  {s.lastRunAt ? `synced ${timeAgo(s.lastRunAt)}` : s.message ?? 'never synced'}
                </span>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-2.5 font-mono text-[10px] leading-relaxed text-subtle">
        first run = full backfill · every run after pulls only what changed · re-runs are idempotent
      </div>
    </Card>
  )
}

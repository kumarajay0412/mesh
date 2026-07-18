import { STAGES, type Stage } from '@shared/types'

/** Compact Intake→Scope→Investigate→Report progress pips. */
export function StagePips({ stage }: { stage: Stage }) {
  const idx = STAGES.indexOf(stage)
  return (
    <div className="flex items-center gap-1">
      {STAGES.map((s, i) => (
        <span
          key={s}
          title={s}
          className="h-1.5 rounded-full transition-all"
          style={{
            width: i === idx ? 18 : 8,
            background:
              i < idx ? 'var(--ada-gold-600)' : i === idx ? 'var(--ada-gold-400)' : 'var(--ada-ink-600)',
          }}
        />
      ))}
    </div>
  )
}

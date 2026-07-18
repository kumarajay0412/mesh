import { STAGES, type Stage } from '@shared/types'

const LABELS: Record<Stage, string> = {
  intake: 'Intake',
  scope: 'Scope',
  investigate: 'Investigate',
  report: 'Report',
}

/** Full-width stage progression for the investigation workspace. */
export function StageBar({ stage }: { stage: Stage }) {
  const idx = STAGES.indexOf(stage)
  return (
    <div className="flex items-center gap-2">
      {STAGES.map((s, i) => {
        const state = i < idx ? 'done' : i === idx ? 'active' : 'todo'
        return (
          <div key={s} className="flex items-center gap-2">
            {i > 0 && <div className="h-px w-6" style={{ background: i <= idx ? 'var(--ada-gold-600)' : 'var(--ada-ink-600)' }} />}
            <div
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest"
              style={{
                borderColor: state === 'todo' ? 'var(--ada-line)' : 'var(--ada-gold-600)',
                color: state === 'active' ? 'var(--ada-gold-400)' : state === 'done' ? 'var(--ada-gold-600)' : 'var(--ada-text-subtle)',
                background: state === 'active' ? 'rgba(245,197,24,0.07)' : 'transparent',
              }}
            >
              {state === 'done' && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 13l4 4L19 7" />
                </svg>
              )}
              {state === 'active' && <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--ada-gold-400)', animation: 'meshPulse 1.6s infinite' }} />}
              {LABELS[s]}
            </div>
          </div>
        )
      })}
    </div>
  )
}

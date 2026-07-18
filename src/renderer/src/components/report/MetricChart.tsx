import type { RootCauseMetric } from '@shared/types'

/** Small measured bar chart for the root-cause story (e.g. failed batches/day
 *  with the incident day highlighted). Pure SVG on PRESS tokens — no chart lib. */
export function MetricChart({ metric }: { metric: RootCauseMetric }) {
  const pts = metric.points
  if (pts.length === 0) return null

  const W = 640
  const H = 190
  const PAD = { top: 18, right: 12, bottom: 34, left: 46 }
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom
  const max = Math.max(...pts.map((p) => p.y), 1)
  const gap = Math.min(10, iw / pts.length / 4)
  const bw = iw / pts.length - gap
  const y = (v: number) => PAD.top + ih - (v / max) * ih

  // grid at 0 / half / max — enough to read magnitude without clutter
  const gridVals = [0, max / 2, max]
  // label every bar when they fit, otherwise thin out
  const labelEvery = Math.ceil(pts.length / 10)

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-muted">{metric.label}</span>
        {metric.unit && <span className="font-mono text-[10px] text-subtle">{metric.unit}</span>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-1.5 w-full" role="img" aria-label={metric.label}>
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--ada-line)" strokeWidth={1} />
            <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" fontSize={10} fill="var(--ada-gray-500)" fontFamily="ui-monospace, monospace">
              {v >= 1000 ? `${Math.round(v / 100) / 10}k` : Math.round(v)}
            </text>
          </g>
        ))}
        {pts.map((p, i) => {
          const hot = metric.highlightX != null && p.x === metric.highlightX
          const x = PAD.left + i * (bw + gap) + gap / 2
          const barY = y(p.y)
          return (
            <g key={`${p.x}-${i}`}>
              <rect
                x={x}
                y={barY}
                width={Math.max(bw, 2)}
                height={Math.max(PAD.top + ih - barY, 1.5)}
                rx={2}
                fill={hot ? 'var(--ada-accent-coral)' : 'var(--ada-gold-400)'}
                opacity={hot ? 1 : 0.45}
              />
              {hot && (
                <text x={x + bw / 2} y={barY - 6} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--ada-accent-coral)" fontFamily="ui-monospace, monospace">
                  {p.y}
                </text>
              )}
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={9.5} fill={hot ? 'var(--ada-accent-coral)' : 'var(--ada-gray-500)'} fontFamily="ui-monospace, monospace">
                  {p.x}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {metric.note && <p className="mt-1 font-mono text-[10.5px] leading-relaxed text-subtle">{metric.note}</p>}
    </div>
  )
}

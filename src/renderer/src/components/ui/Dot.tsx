export type DotTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'live'

const COLORS: Record<DotTone, string> = {
  neutral: 'var(--ada-gray-500)',
  ok: 'var(--ada-success)',
  warn: 'var(--ada-warning)',
  danger: 'var(--ada-danger)',
  live: 'var(--ada-gold-400)',
}

export function Dot({ tone = 'neutral' }: { tone?: DotTone }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: COLORS[tone], animation: tone === 'live' ? 'meshPulse 1.6s infinite' : undefined }}
    />
  )
}

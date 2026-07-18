import type { ReactNode } from 'react'

export type PillTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'gold'

const TONES: Record<PillTone, string> = {
  neutral: 'border-line text-muted',
  ok: 'border-[color:var(--ada-success)]/40 text-[color:var(--ada-success)]',
  warn: 'border-[color:var(--ada-warning)]/40 text-[color:var(--ada-warning)]',
  danger: 'border-[color:var(--ada-danger)]/40 text-[color:var(--ada-danger)]',
  info: 'border-[color:var(--ada-info)]/40 text-[color:var(--ada-info)]',
  gold: 'border-gold-600/50 text-gold-400',
}

export function Pill({ children, tone = 'neutral', className = '' }: { children: ReactNode; tone?: PillTone; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}

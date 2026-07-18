import type { ReactNode } from 'react'

/** Panel container — the only card fill, on any ground (PRESS "Card"). */
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-md border border-line bg-surface ${className}`}
      style={{ boxShadow: 'var(--ada-shadow-1)' }}
    >
      {children}
    </div>
  )
}

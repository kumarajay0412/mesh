import type { ReactNode } from 'react'

/** Mono uppercase section label with eyebrow letter-spacing. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase text-subtle" style={{ letterSpacing: 'var(--ada-ls-eyebrow)' }}>
      {children}
    </div>
  )
}

import type { ReactNode } from 'react'
import { Eyebrow } from '../ui'

/** Standard screen heading: eyebrow + display title + optional right actions. */
export function ScreenHeader({ eyebrow, title, right }: { eyebrow: string; title: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1 truncate font-display text-[26px] font-semibold tracking-tight text-txt">{title}</h1>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </div>
  )
}

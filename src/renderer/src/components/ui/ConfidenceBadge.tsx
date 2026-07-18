import type { Confidence } from '@shared/types'
import { Pill, type PillTone } from './Pill'

const TONE: Record<Confidence, PillTone> = {
  suspected: 'danger',
  probable: 'warn',
  confirmed: 'ok',
}

export function ConfidenceBadge({ value }: { value: Confidence }) {
  return (
    <Pill tone={TONE[value]}>
      <span className="capitalize">{value}</span>
    </Pill>
  )
}

// Pure state machine (Section 5): INTAKE → SCOPE → INVESTIGATE → REPORT, any → ABANDONED.
// Zero imports — vitest hits this directly.
import type { Stage } from '../../shared/types'

export type EngineState = Stage | 'abandoned'

const ORDER: Stage[] = ['intake', 'scope', 'investigate', 'report']

export function canTransition(from: EngineState, to: EngineState): boolean {
  if (from === 'abandoned') return false // terminal
  if (to === 'abandoned') return true // any live stage can abandon
  const fi = ORDER.indexOf(from as Stage)
  const ti = ORDER.indexOf(to as Stage)
  if (fi < 0 || ti < 0) return false
  return ti === fi + 1 // strictly forward, one step at a time
}

export function nextStage(from: Stage): Stage | null {
  const i = ORDER.indexOf(from)
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1] : null
}

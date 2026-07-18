import type { ModelStatus } from '@shared/types'
import { Pill } from '../ui'

/** Honest semantic-search state: lexical-only until the local model is ready (Section 7.1). */
export function ModelStatusPill({ status }: { status: ModelStatus }) {
  switch (status.state) {
    case 'ready':
      return <Pill tone="ok">semantic + lexical</Pill>
    case 'downloading':
      return <Pill tone="gold">model downloading {status.progress != null ? `${Math.round(status.progress)}%` : ''}</Pill>
    case 'error':
      return <Pill tone="danger">embeddings error — lexical only</Pill>
    case 'unavailable':
      return <Pill tone="neutral">lexical only</Pill>
    default:
      return <Pill tone="neutral">lexical only</Pill>
  }
}

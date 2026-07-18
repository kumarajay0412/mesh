import type { Report } from '@shared/types'
import { shortSha } from '../../lib/format'
import { Card, Eyebrow } from '../ui'

export function CulpritCard({ culprit }: { culprit: NonNullable<Report['culprit']> }) {
  return (
    <Card className="p-4">
      <Eyebrow>Culprit</Eyebrow>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[13px]">
        <span className="text-muted">{culprit.repo}</span>
        <span className="text-ink-500">·</span>
        <span className="rounded-sm border border-gold-600/50 px-1.5 py-0.5 text-gold-400">{shortSha(culprit.sha)}</span>
        <span className="text-ink-500">·</span>
        <span className="break-all text-txt">{culprit.path}</span>
      </div>
    </Card>
  )
}

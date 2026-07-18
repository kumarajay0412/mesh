import type { Report } from '@shared/types'
import { Card, ConfidenceBadge, Eyebrow } from '../ui'

export function HypothesisCard({ report }: { report: Report }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <Eyebrow>Root-cause hypothesis</Eyebrow>
        <ConfidenceBadge value={report.confidence} />
      </div>
      <p className="mt-2 text-[15px] font-medium leading-relaxed text-txt">{report.hypothesis}</p>
    </Card>
  )
}

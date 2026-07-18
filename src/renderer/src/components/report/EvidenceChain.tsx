import type { EvidenceItem } from '@shared/types'
import { Card, Eyebrow } from '../ui'
import { EvidenceCard } from '../investigation/EvidenceCard'

/** Every claim → its source. A claim without a source does not ship (Section 6 step 7). */
export function EvidenceChain({ evidence }: { evidence: EvidenceItem[] }) {
  return (
    <Card className="p-4">
      <Eyebrow>Evidence chain</Eyebrow>
      <div className="mt-3 grid grid-cols-1 gap-2.5 xl:grid-cols-2">
        {evidence.map((e) => (
          <EvidenceCard key={e.id} item={e} />
        ))}
      </div>
    </Card>
  )
}

import { useEffect, useState } from 'react'
import type { Learning } from '@shared/types'
import { getApi } from '../../lib/api'
import { Button, Card, Eyebrow, Pill } from '../ui'

/** The learnings gate: the agent proposes operational knowledge, the user
 *  decides what enters future prompts. Nothing lands without a click. */
export function LearningsCard({ investigationId }: { investigationId: string }) {
  const [items, setItems] = useState<Learning[]>([])

  const load = async () => {
    const api = await getApi()
    const all = await api.listLearnings()
    setItems(all.filter((l) => l.investigationId === investigationId && l.status !== 'rejected'))
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [investigationId])

  const decide = async (id: number, accept: boolean) => {
    const api = await getApi()
    await api.decideLearning(id, accept)
    await load()
  }

  if (items.length === 0) return null

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <Eyebrow>Learnings · what future investigations should know</Eyebrow>
        <span className="font-mono text-[10px] text-subtle">accepted lines ride in every future prompt</span>
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {items.map((l) => (
          <div key={l.id} className="flex items-start gap-3 rounded-md border border-line bg-ink-850 px-3 py-2.5">
            <svg className="mt-0.5 shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ada-gold-400)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a7 7 0 00-4 12.7V17a1 1 0 001 1h6a1 1 0 001-1v-2.3A7 7 0 0012 2zM9 21h6" />
            </svg>
            <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-txt">{l.text}</p>
            {l.status === 'accepted' ? (
              <Pill tone="ok">in context</Pill>
            ) : (
              <div className="flex shrink-0 gap-1.5">
                <Button variant="quiet" className="!px-2 !text-[12px]" onClick={() => void decide(l.id, false)}>
                  Dismiss
                </Button>
                <Button variant="primary" className="!px-2.5 !text-[12px]" onClick={() => void decide(l.id, true)}>
                  Add to context
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

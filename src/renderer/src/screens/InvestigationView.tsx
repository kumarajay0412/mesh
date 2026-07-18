import { useEffect, useMemo } from 'react'
import type { EvidenceItem } from '@shared/types'
import { useApp } from '../stores/app'
import { useInvestigations } from '../stores/investigations'
import { StageBar } from '../components/investigation/StageBar'
import { Timeline } from '../components/investigation/Timeline'
import { SteeringInput } from '../components/investigation/SteeringInput'
import { EvidenceRail } from '../components/investigation/EvidenceRail'
import { Button, Pill } from '../components/ui'

/** The hero screen: live timeline + steering (left) · evidence rail (right). */
export function InvestigationView() {
  const { activeInvestigationId: id, go } = useApp()
  const { list, load, timelines, watch, unwatch, steer, interrupt, abandon, engineStates } = useInvestigations()

  useEffect(() => {
    void load()
  }, [load])

  // The payoff moment: the engine says the report is ready → open it.
  const engineStage = id ? engineStates[id]?.stage : undefined
  useEffect(() => {
    if (id && engineStage === 'report') go('report', id)
  }, [id, engineStage, go])

  useEffect(() => {
    if (!id) return
    void watch(id)
    return () => unwatch(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const inv = list.find((i) => i.id === id)
  const events = (id && timelines[id]) || []

  const evidence = useMemo(() => {
    const out: EvidenceItem[] = []
    for (const e of events) if (e.kind === 'evidence') out.push(e.evidence)
    return out
  }, [events])

  const stage = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.kind === 'stage') return e.stage
    }
    return inv?.stage ?? 'intake'
  }, [events, inv])

  const done = events.some((e) => e.kind === 'done')

  if (!id) return null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className="flex items-center gap-4 border-b border-line px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-[11px] text-subtle">
            <span>{id}</span>
            {inv?.ticketRef && (
              <>
                <span className="text-ink-500">·</span>
                <span>{inv.ticketRef}</span>
              </>
            )}
            {inv?.similarTo?.[0] && (
              <>
                <span className="text-ink-500">·</span>
                <span className="text-gold-400">similar to {inv.similarTo[0].id}</span>
              </>
            )}
          </div>
          <h1 className="truncate font-display text-[19px] font-semibold tracking-tight text-txt">{inv?.title ?? id}</h1>
        </div>
        <div className="flex-1" />
        <StageBar stage={stage} />
        {done && (
          <Button variant="primary" onClick={() => go('report', id)}>
            View report
          </Button>
        )}
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2">
            <Pill tone="neutral">read-only session</Pill>
            {inv?.service && <span className="font-mono text-[11px] text-subtle">{inv.service}</span>}
            <div className="flex-1" />
            <span className="font-mono text-[10px] text-subtle">{events.length} events</span>
          </div>
          <Timeline events={events} working={!done && inv?.status === 'investigating'} />
          <SteeringInput
            onSteer={(t) => void steer(id, t)}
            onInterrupt={() => void interrupt(id)}
            onAbandon={() => {
              void abandon(id)
              go('investigations')
            }}
            disabled={done}
          />
        </section>
        <EvidenceRail items={evidence} />
      </div>
    </div>
  )
}

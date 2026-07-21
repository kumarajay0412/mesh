import { useEffect, useState } from 'react'
import type { Investigation, InvestigationStatus } from '@shared/types'
import { useApp } from '../stores/app'
import { useInvestigations } from '../stores/investigations'
import { ScreenHeader } from '../components/layout/ScreenHeader'
import { Button, ConfidenceBadge, Dot, EmptyState, Field, Input, Modal, Pill, StagePips, Tabs, TextArea } from '../components/ui'
import { formatUsd, timeAgo } from '../lib/format'

const STATUS_TONE: Record<InvestigationStatus, 'neutral' | 'gold' | 'info' | 'ok' | 'danger'> = {
  open: 'neutral',
  investigating: 'gold',
  report: 'info',
  closed: 'ok',
  abandoned: 'danger',
  failed: 'danger',
}

const STATUS_LABEL: Record<InvestigationStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  report: 'Report ready',
  closed: 'Closed',
  abandoned: 'Abandoned',
  failed: 'No report',
}

type Filter = 'all' | 'open' | 'closed'

export function Investigations() {
  const { list, loaded, load } = useInvestigations()
  const [filter, setFilter] = useState<Filter>('all')
  const [newOpen, setNewOpen] = useState(false)

  useEffect(() => {
    void load()
  }, [load])

  const filtered = list.filter((i) =>
    filter === 'all' ? true : filter === 'open' ? i.status === 'open' || i.status === 'investigating' || i.status === 'report' : i.status === 'closed' || i.status === 'abandoned',
  )

  return (
    <div className="mx-auto max-w-[1080px] px-8 py-7">
      <ScreenHeader
        eyebrow="Production"
        title="Investigations"
        right={
          <Button variant="primary" onClick={() => setNewOpen(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New investigation
          </Button>
        }
      />

      <div className="mt-5">
        <Tabs<Filter>
          items={[{ id: 'all', label: 'All' }, { id: 'open', label: 'Open' }, { id: 'closed', label: 'Closed' }]}
          value={filter}
          onChange={setFilter}
          right={<span className="font-mono text-[11px] text-subtle">{filtered.length} of {list.length}</span>}
        />
      </div>

      <div className="mt-3 flex flex-col gap-2">
        {loaded && filtered.length === 0 && (
          <EmptyState
            title="No investigations yet"
            note="Hand Mesh a Linear ticket, a Sentry error, or a Grafana link — it returns an evidence-linked root cause."
            action={<Button variant="primary" onClick={() => setNewOpen(true)}>Start one</Button>}
          />
        )}
        {filtered.map((inv) => (
          <Row key={inv.id} inv={inv} />
        ))}
      </div>

      {newOpen && <NewInvestigation onClose={() => setNewOpen(false)} />}
    </div>
  )
}

function Row({ inv }: { inv: Investigation }) {
  const go = useApp((s) => s.go)
  const live = inv.status === 'investigating'
  const target = inv.status === 'report' || inv.status === 'closed' ? 'report' : 'investigation'
  return (
    <button
      onClick={() => go(target, inv.id)}
      className="group w-full rounded-md border border-line bg-surface px-4 py-3.5 text-left transition-colors duration-100 hover:border-line-strong hover:bg-raised"
      style={{ boxShadow: 'var(--ada-shadow-1)' }}
    >
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] text-subtle">{inv.id}</span>
        <Pill tone={STATUS_TONE[inv.status]}>
          {live && <Dot tone="live" />}
          {STATUS_LABEL[inv.status]}
        </Pill>
        <div className="flex-1" />
        <span className="font-mono text-[11px] text-subtle">{timeAgo(inv.createdAt)}</span>
      </div>
      <div className="mt-2 text-[15px] font-medium text-txt group-hover:text-white">{inv.title}</div>
      <div className="mt-2.5 flex items-center gap-3">
        <StagePips stage={inv.stage} />
        {inv.service && <span className="font-mono text-[11px] text-subtle">{inv.service}</span>}
        <span className="text-ink-500">·</span>
        <span className="font-mono text-[11px] text-subtle">{inv.source}</span>
        <div className="flex-1" />
        {inv.similarTo?.[0] && (
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-gold-400">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M12 3v18M3 12h18" /></svg>
            similar to {inv.similarTo[0].id}
          </span>
        )}
        {inv.cost?.usd != null && (
          <span
            className="font-mono text-[11px] text-subtle"
            title={`API spend across ${inv.cost.turns} turn(s)${inv.cost.partial ? ' — some sessions predate cost tracking, so this is a floor' : ''}`}
          >
            {inv.cost.partial ? '≥' : ''}
            {formatUsd(inv.cost.usd)}
          </span>
        )}
        {inv.confidence && <ConfidenceBadge value={inv.confidence} />}
      </div>
    </button>
  )
}

function NewInvestigation({ onClose }: { onClose: () => void }) {
  const start = useInvestigations((s) => s.start)
  const go = useApp((s) => s.go)
  const [ticketRef, setTicketRef] = useState('')
  const [pasted, setPasted] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    const id = await start({ ticketRef: ticketRef.trim() || undefined, pasted: pasted.trim() || undefined, title: pasted.trim().slice(0, 80) || undefined })
    setBusy(false)
    onClose()
    go('investigation', id)
  }

  return (
    <Modal open onClose={onClose} width={520}>
      <div className="border-b border-line px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">Intake</div>
        <div className="mt-0.5 font-display text-[18px] font-semibold text-txt">New investigation</div>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Linear ticket / Grafana link / Sentry issue" hint="one reference">
          <Input value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} placeholder="ENG-1284 · https://grafana…/d/pay-main · SENTRY-4Q2" />
        </Field>
        <div className="text-center font-mono text-[10px] uppercase tracking-widest text-subtle">or</div>
        <Field label="Paste the alert / symptom text">
          <TextArea rows={4} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="payments-api throwing 5xx since ~14:20, checkout failing for ~8% of users…" />
        </Field>
      </div>
      <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
        <span className="font-mono text-[10px] text-subtle">intake extracts symptoms · services · time window</span>
        <div className="flex gap-2">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || (!ticketRef.trim() && !pasted.trim())}>
            {busy ? 'Starting…' : 'Start investigation'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

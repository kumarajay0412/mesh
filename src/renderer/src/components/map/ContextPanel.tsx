import { useEffect, useState } from 'react'
import type { ContextSummary } from '@shared/types'
import { getApi } from '../../lib/api'
import { useSettings } from '../../stores/settings'
import { Button, Input, Modal } from '../ui'

/** "What Mesh knows" — the transparency panel: totals for every inferred
 *  store, the EXACT text that rides in prompts, and a personal backlog of
 *  context to add later (never injected — it's the user's checklist). */
export function ContextPanel({ onClose }: { onClose: () => void }) {
  const [summary, setSummary] = useState<ContextSummary | null>(null)
  const { settings, update } = useSettings()
  const [draft, setDraft] = useState('')
  const backlog = settings?.contextBacklog ?? []

  useEffect(() => {
    void getApi().then((api) => api.getContextSummary().then(setSummary))
  }, [])

  const addItem = () => {
    const text = draft.trim()
    if (!text) return
    void update({ contextBacklog: [...backlog, text] })
    setDraft('')
  }
  const removeItem = (i: number) => {
    void update({ contextBacklog: backlog.filter((_, idx) => idx !== i) })
  }

  const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <div className="rounded-md border border-line bg-ink-900 px-3.5 py-2.5">
      <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">{label}</div>
      <div className="mt-0.5 font-display text-[20px] font-semibold text-txt">{value}</div>
      {sub && <div className="font-mono text-[10.5px] text-subtle">{sub}</div>}
    </div>
  )

  return (
    <Modal open onClose={onClose} width={680}>
      <div className="border-b border-line px-6 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">Knowledge map</div>
        <div className="mt-0.5 font-display text-[19px] font-semibold tracking-tight text-txt">What Mesh knows</div>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
        {!summary ? (
          <div className="py-8 text-center font-mono text-[12px] text-subtle">loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <Stat
                label="memory"
                value={summary.memory.total.toLocaleString()}
                sub={`${Object.entries(summary.memory.bySource)
                  .map(([s, n]) => `${s} ${n.toLocaleString()}`)
                  .join(' · ')} · ${summary.memory.embedded.toLocaleString()} embedded`}
              />
              <Stat label="registry" value={summary.registry.total} sub={`${summary.registry.manual} manual`} />
              <Stat
                label="map"
                value={`${summary.map.nodes} / ${summary.map.edges}`}
                sub={`nodes / edges${summary.map.proposed ? ` · ${summary.map.proposed} proposed` : ''}`}
              />
              <Stat label="learnings" value={summary.learnings.accepted} sub={summary.learnings.proposed ? `${summary.learnings.proposed} awaiting review` : 'accepted'} />
            </div>

            <div className="mt-5">
              <div className="font-mono text-[10px] uppercase tracking-widest text-gold-600">rides in every prompt — the exact map block</div>
              <pre className="mt-1.5 max-h-40 overflow-y-auto rounded-md border border-line bg-ink-900 p-3 font-mono text-[11px] leading-relaxed text-muted">
                {summary.mapPrompt.trim() || '(map is empty — seed it from a description)'}
              </pre>
            </div>

            {summary.learningTexts.length > 0 && (
              <div className="mt-4">
                <div className="font-mono text-[10px] uppercase tracking-widest text-gold-600">accepted learnings — injected as written</div>
                <ul className="mt-1.5 flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-line bg-ink-900 p-3">
                  {summary.learningTexts.map((t, i) => (
                    <li key={i} className="font-mono text-[11px] leading-relaxed text-muted">
                      - {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-5">
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">context to add later — your checklist, never injected</div>
              <div className="mt-1.5 flex gap-2">
                <Input
                  placeholder="e.g. map the ML pipeline · ingest #platform-alerts · add payments runbook"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addItem()}
                />
                <Button variant="quiet" onClick={addItem} disabled={!draft.trim()}>
                  Add
                </Button>
              </div>
              {backlog.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {backlog.map((item, i) => (
                    <li key={i} className="flex items-center gap-2.5 rounded-sm border border-line bg-ink-900 px-3 py-1.5">
                      <span className="flex-1 text-[12.5px] text-muted">{item}</span>
                      <button className="no-drag font-mono text-[11px] text-subtle hover:text-danger" onClick={() => removeItem(i)}>
                        done / remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line px-6 py-3.5">
        <span className="font-mono text-[10px] text-subtle">every item above is user-gated before it reaches a prompt</span>
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  )
}

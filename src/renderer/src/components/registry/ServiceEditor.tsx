import { useState } from 'react'
import type { ServiceEntry } from '@shared/types'
import { Button, Field, Input, Modal, TextArea } from '../ui'

/** Edit drawer for one registry entry. Saving marks the entry `manual` —
 *  manual always wins over inference on conflict (Section 4). */
export function ServiceEditor({ entry, onSave, onClose }: { entry: ServiceEntry; onSave: (e: ServiceEntry) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<ServiceEntry>({ ...entry, ids: { ...entry.ids }, aliases: [...entry.aliases] })
  const set = <K extends keyof ServiceEntry>(k: K, v: ServiceEntry[K]) => setDraft((d) => ({ ...d, [k]: v }))

  return (
    <Modal open onClose={onClose} width={560}>
      <div className="border-b border-line px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">Service registry</div>
        <div className="mt-0.5 font-display text-[18px] font-semibold text-txt">{entry.name}</div>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="What it does">
          <TextArea rows={2} value={draft.does ?? ''} onChange={(e) => set('does', e.target.value)} />
        </Field>
        <Field label="How it's served">
          <Input value={draft.serving ?? ''} onChange={(e) => set('serving', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Repo">
            <Input value={draft.repo ?? ''} onChange={(e) => set('repo', e.target.value)} />
          </Field>
          <Field label="Namespace">
            <Input value={draft.namespace ?? ''} onChange={(e) => set('namespace', e.target.value)} />
          </Field>
        </div>
        <Field label="Aliases" hint="comma-separated">
          <Input
            value={draft.aliases.join(', ')}
            onChange={(e) => set('aliases', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
          />
        </Field>
        <Field label="Identifiers" hint="key=value per line (dashboard_uid, loki_label, tenant_key…)">
          <TextArea
            rows={3}
            value={Object.entries(draft.ids).map(([k, v]) => `${k}=${v}`).join('\n')}
            onChange={(e) => {
              const ids: Record<string, string> = {}
              for (const line of e.target.value.split('\n')) {
                const m = line.match(/^\s*([\w.-]+)\s*=\s*(.+)\s*$/)
                if (m) ids[m[1]] = m[2]
              }
              set('ids', ids)
            }}
          />
        </Field>
      </div>
      <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
        <span className="font-mono text-[10px] text-subtle">saving marks this entry MANUAL — inference won't overwrite it</span>
        <div className="flex gap-2">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => onSave({ ...draft, source: 'manual' })}>Save changes</Button>
        </div>
      </div>
    </Modal>
  )
}

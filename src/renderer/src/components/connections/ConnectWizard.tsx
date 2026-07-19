import { useEffect, useState } from 'react'
import type { GrafanaInstance, SourceId } from '@shared/types'
import { getApi } from '../../lib/api'
import { Button, Field, Input, Modal, Pill, Toggle } from '../ui'

interface SlackChannelOption {
  id: string
  name: string
  isMember: boolean
}

interface FieldSpec {
  key: string
  label: string
  hint?: string
  placeholder?: string
  secret?: boolean
  optional?: boolean
}

const FORMS: Record<SourceId, { title: string; note: string; fields: FieldSpec[] }> = {
  grafana: {
    title: 'Grafana instances',
    note: 'Orgs often run several Grafanas (prod, azure, …). Add each with a read-scoped service-account token — existing ones are listed below.',
    fields: [
      { key: 'name', label: 'Name', placeholder: 'prod / azure / v2', hint: 'defaults to hostname', optional: true },
      { key: 'url', label: 'Grafana URL', placeholder: 'https://grafana.your-org.internal' },
      { key: 'token', label: 'Service-account token', hint: 'read-only scope', secret: true },
    ],
  },
  linear: {
    title: 'Connect Linear',
    note: 'Personal API key — used to backfill and incrementally sync resolved issues (with comments) into memory.',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, placeholder: 'lin_api_…' }],
  },
  slack: {
    title: 'Connect Slack',
    note: 'Token with channels:history + channels:read. Paste it, then pick the channels where incidents get reported AND where RCAs/postmortems get written up — each syncs independently and its threads become searchable memory.',
    fields: [{ key: 'token', label: 'Token', secret: true, placeholder: 'xoxp-…' }],
  },
  sentry: {
    title: 'Connect Sentry',
    note: 'User auth token — create one at sentry.io → Settings → Account → API → User Auth Tokens, with scopes: org:read, project:read, event:read. The agent gets live Sentry tools (issues, events, stack traces) in every investigation.',
    fields: [
      { key: 'token', label: 'User auth token', secret: true, placeholder: 'sntryu_…' },
      { key: 'org', label: 'Org slug', hint: 'optional', placeholder: 'your-org' },
    ],
  },
}

/** Single-source connect dialog. Validation is a read-only call on the other
 *  side; secrets go straight to safeStorage and never render back. */
export function ConnectWizard({
  source,
  onConnect,
  onClose,
}: {
  source: SourceId
  onConnect: (fields: Record<string, string>) => Promise<{ ok: boolean; message?: string }>
  onClose: () => void
}) {
  const spec = FORMS[source]
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instances, setInstances] = useState<GrafanaInstance[] | null>(null)

  // Slack: a live channel PICKER (conversations.list against the pasted,
  // not-yet-saved token) instead of hand-typing spellings. Manual entry
  // stays available as a fallback — a huge workspace or a missing
  // channels:read scope shouldn't block connecting entirely.
  const [slackChannels, setSlackChannels] = useState<SlackChannelOption[] | null>(null)
  const [slackChannelsError, setSlackChannelsError] = useState<string | null>(null)
  const [slackLoading, setSlackLoading] = useState(false)
  const [selectedChannels, setSelectedChannels] = useState<Set<string>>(new Set())
  const [manualChannels, setManualChannels] = useState(false)

  const findChannels = async () => {
    setSlackLoading(true)
    setSlackChannelsError(null)
    const api = await getApi()
    const res = await api.listSlackChannels(values.token ?? '')
    setSlackLoading(false)
    if (!res.ok) {
      setSlackChannelsError(res.message)
      setSlackChannels(null)
      return
    }
    setSlackChannels(res.channels)
  }

  const toggleChannel = (name: string) => {
    setSelectedChannels((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      setValues((v) => ({ ...v, channel: [...next].join(', ') }))
      return next
    })
  }

  const loadInstances = async () => {
    if (source !== 'grafana') return
    const api = await getApi()
    setInstances(await api.grafanaInstances())
  }

  useEffect(() => {
    void loadInstances()
    setSlackChannels(null)
    setSlackChannelsError(null)
    setSelectedChannels(new Set())
    setManualChannels(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source])

  const removeInstance = async (name: string) => {
    const api = await getApi()
    await api.removeGrafanaInstance(name)
    await loadInstances()
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    const res = await onConnect(values)
    setBusy(false)
    if (!res.ok) {
      setError(res.message ?? 'validation failed')
      return
    }
    if (source === 'grafana') {
      // stay open: show the updated list, allow adding another
      setValues({})
      await loadInstances()
    } else {
      onClose()
    }
  }

  return (
    <Modal open onClose={onClose} width={480}>
      <div className="border-b border-line px-5 py-4">
        <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">Connections</div>
        <div className="mt-0.5 font-display text-[18px] font-semibold text-txt">{spec.title}</div>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        <p className="text-[12.5px] leading-relaxed text-muted">{spec.note}</p>

        {source === 'grafana' && instances && instances.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">already connected</div>
            {instances.map((i) => (
              <div key={i.name} className="flex items-center gap-2.5 rounded-md border border-line bg-ink-900 px-3 py-2">
                <span className="font-mono text-[12px] text-gold-400">{i.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-subtle">{i.url}</span>
                <Pill tone={i.hasToken ? 'ok' : 'warn'}>{i.hasToken ? 'token stored' : 'no token'}</Pill>
                <button
                  className="no-drag font-mono text-[11px] text-subtle hover:text-danger"
                  onClick={() => void removeInstance(i.name)}
                  title="remove this instance"
                >
                  remove
                </button>
              </div>
            ))}
          </div>
        )}

        {spec.fields.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint}>
            <Input
              type={f.secret ? 'password' : 'text'}
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </Field>
        ))}

        {source === 'slack' && (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-widest text-subtle">channels</span>
              <button
                className="no-drag font-mono text-[11px] text-subtle hover:text-txt"
                onClick={() => setManualChannels((m) => !m)}
              >
                {manualChannels ? 'back to picker' : 'type names manually'}
              </button>
            </div>

            {manualChannels ? (
              <Field label="Channels (comma-separated)" hint="names or #names, no need to know exact casing">
                <Input
                  placeholder="reporting-prod, incidents, postmortems"
                  value={values.channel ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, channel: e.target.value }))}
                />
              </Field>
            ) : (
              <>
                {!slackChannels && (
                  <Button variant="quiet" onClick={() => void findChannels()} disabled={slackLoading || !values.token?.trim()}>
                    {slackLoading ? 'Finding channels…' : 'Find channels'}
                  </Button>
                )}
                {slackChannelsError && (
                  <div className="rounded-sm border border-[color:var(--ada-danger)]/40 bg-[rgba(242,102,74,0.06)] px-3 py-2 text-[12px] text-danger">
                    {slackChannelsError}
                  </div>
                )}
                {slackChannels && (
                  <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-line bg-ink-900 p-2">
                    {slackChannels.length === 0 && (
                      <p className="px-2 py-1.5 text-[12px] text-subtle">no channels visible to this token</p>
                    )}
                    {slackChannels.map((c) => (
                      <div key={c.id} className="flex items-center gap-2.5 rounded-sm px-2 py-1.5 hover:bg-ink-850">
                        <Toggle on={selectedChannels.has(c.name)} onChange={() => toggleChannel(c.name)} />
                        <span className="font-mono text-[12px] text-txt">#{c.name}</span>
                        {!c.isMember && <Pill tone="warn">not a member yet</Pill>}
                      </div>
                    ))}
                  </div>
                )}
                {slackChannels && (
                  <button className="no-drag self-start font-mono text-[11px] text-subtle hover:text-txt" onClick={() => void findChannels()}>
                    refresh list
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {error && <div className="rounded-sm border border-[color:var(--ada-danger)]/40 bg-[rgba(242,102,74,0.06)] px-3 py-2 text-[12px] text-danger">{error}</div>}
      </div>
      <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
        <span className="font-mono text-[10px] text-subtle">stored in the OS keychain · read-scoped · yours</span>
        <div className="flex gap-2">
          <Button variant="quiet" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={
              busy ||
              spec.fields.some((f) => !f.optional && !values[f.key]?.trim()) ||
              (source === 'slack' && !values.channel?.trim())
            }
          >
            {busy ? 'Validating…' : source === 'grafana' ? 'Add instance' : 'Connect'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

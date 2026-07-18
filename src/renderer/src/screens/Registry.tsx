import { useEffect, useState } from 'react'
import { useRegistry } from '../stores/registry'
import { getApi } from '../lib/api'
import { ScreenHeader } from '../components/layout/ScreenHeader'
import { ServiceCard } from '../components/registry/ServiceCard'
import { ServiceEditor } from '../components/registry/ServiceEditor'
import { Button, EmptyState } from '../components/ui'

export function Registry() {
  const { services, loaded, load, editing, edit, save } = useRegistry()
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<string | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const discover = async () => {
    setBusy(true)
    setSummary(null)
    try {
      const api = await getApi()
      const r = await api.discoverServices()
      const errs = r.instances.filter((i) => i.error)
      const details = r.instances.filter((i) => i.detail).map((i) => `${i.name}: ${i.detail}`)
      setSummary(
        `${r.discovered} services from ${r.instances.length} Grafana instance${r.instances.length === 1 ? '' : 's'} · ${r.matchedToRepos} matched to repos` +
          (errs.length ? ` · errors: ${errs.map((e) => `${e.name} (${e.error})`).join(', ')}` : '') +
          (details.length ? `\n${details.join('\n')}` : ''),
      )
      await load()
    } catch (e) {
      setSummary(`discovery failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1080px] px-8 py-7">
      <ScreenHeader
        eyebrow="Service → repo map"
        title="Service registry"
        right={
          <Button variant="primary" onClick={() => void discover()} disabled={busy}>
            {busy ? 'Discovering…' : 'Discover from Grafana'}
          </Button>
        }
      />
      {summary && (
        <div className="mt-3 whitespace-pre-wrap rounded-md border border-line bg-surface px-4 py-2.5 font-mono text-[12px] leading-relaxed text-muted">
          {summary}
        </div>
      )}

      {loaded && services.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title="No services mapped yet"
            note="Click Discover from Grafana — it reads your Loki labels and drafts a knowledge card per service, matched to your local repos."
            action={
              <Button variant="primary" onClick={() => void discover()} disabled={busy}>
                {busy ? 'Discovering…' : 'Discover from Grafana'}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {services.map((s) => (
            <ServiceCard key={s.name} entry={s} onEdit={() => edit(s)} />
          ))}
        </div>
      )}

      {editing && <ServiceEditor entry={editing} onSave={(e) => void save(e)} onClose={() => edit(null)} />}
    </div>
  )
}

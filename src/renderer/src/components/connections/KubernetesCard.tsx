import { useEffect, useState } from 'react'
import type { K8sStatus } from '@shared/types'
import { getApi } from '../../lib/api'
import { Button, Pill } from '../ui'

/** Connections → Kubernetes: detect local tooling + list contexts so the user
 *  can wire clusters to services. Mesh stores no cloud creds — it reads what
 *  gcloud/az/kubectl already have on your login. Mapping itself happens in the
 *  Service registry (each service's Cluster context field). */
export function KubernetesCard() {
  const [status, setStatus] = useState<K8sStatus | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setBusy(true)
    const api = await getApi()
    setStatus(await api.getK8sStatus())
    setBusy(false)
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tool = (name: string, present: boolean) => (
    <span className="flex items-center gap-1.5 font-mono text-[11px]">
      <span className={present ? 'text-[color:var(--ada-accent-teal)]' : 'text-subtle'}>{present ? '●' : '○'}</span>
      {name}
    </span>
  )

  const anyTool = status && (status.kubectl || status.gcloud || status.az)

  return (
    <div className="rounded-md border border-line bg-ink-850 p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 place-items-center rounded-md border border-line bg-ink-900 font-mono text-[11px] text-gold-400">K8s</span>
        <div className="flex-1">
          <div className="font-display text-[14px] font-semibold text-txt">Kubernetes</div>
          <div className="font-mono text-[10px] text-subtle">deploy/pod signals · live read-only kubectl · your own gcloud/az login</div>
        </div>
        <Button variant="quiet" onClick={() => void load()} disabled={busy}>
          {busy ? 'Checking…' : 'Re-check'}
        </Button>
      </div>

      {status && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-4 rounded-sm border border-line bg-ink-900 px-3 py-2">
            {tool('kubectl', status.kubectl)}
            {tool('gcloud', status.gcloud)}
            {tool('az', status.az)}
          </div>

          {!anyTool && (
            <p className="text-[12.5px] leading-relaxed text-muted">
              No cluster CLI found on PATH. Install <span className="font-mono text-txt">kubectl</span> plus{' '}
              <span className="font-mono text-txt">gcloud</span> (GKE) or <span className="font-mono text-txt">az</span> (AKS), then authenticate — Mesh uses your
              existing login, it never stores cloud credentials.
            </p>
          )}

          {status.contexts.length > 0 ? (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">kubectl contexts ({status.contexts.length})</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {status.contexts.map((c) => {
                  const used = status.mapped.some((m) => m.context === c)
                  return (
                    <span key={c} className="flex items-center gap-1.5 rounded-sm border border-line bg-ink-900 px-2 py-1 font-mono text-[11px] text-muted">
                      {c}
                      {used && <Pill tone="ok">mapped</Pill>}
                    </span>
                  )
                })}
              </div>
            </div>
          ) : (
            anyTool && (
              <p className="text-[12.5px] leading-relaxed text-muted">
                No kubectl contexts yet. Add one with{' '}
                <span className="font-mono text-txt">gcloud container clusters get-credentials …</span> or{' '}
                <span className="font-mono text-txt">az aks get-credentials …</span>, then Re-check.
              </p>
            )
          )}

          {status.mapped.length > 0 && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">service → cluster</div>
              <div className="mt-1.5 flex flex-col gap-1">
                {status.mapped.map((m) => (
                  <div key={m.service} className="font-mono text-[11px] text-muted">
                    {m.service} → {m.context}
                    {m.namespace && <span className="text-subtle"> · ns {m.namespace}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {status.contexts.length > 0 && status.unmappedServices.length > 0 && (
            <p className="text-[12px] leading-relaxed text-subtle">
              {status.unmappedServices.length} live service(s) not yet routed to a cluster ({status.unmappedServices.slice(0, 4).join(', ')}
              {status.unmappedServices.length > 4 ? '…' : ''}). Set each one’s <span className="text-muted">Cluster context</span> in the Service registry to enable live
              kubectl for it.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

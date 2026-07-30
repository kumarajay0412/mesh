import { useEffect, useState } from 'react'
import { useConnections } from '../stores/connections'
import { ScreenHeader } from '../components/layout/ScreenHeader'
import { ConnectionCard } from '../components/connections/ConnectionCard'
import { ConnectWizard } from '../components/connections/ConnectWizard'
import { KubernetesCard } from '../components/connections/KubernetesCard'
import { getApi } from '../lib/api'
import { timeAgo } from '../lib/format'
import type { ContextSummary } from '@shared/types'

export function Connections() {
  const { list, load, wizardOpen, openWizard, connect } = useConnections()
  const [repos, setRepos] = useState<ContextSummary['repos'] | null>(null)

  useEffect(() => {
    void load()
    void getApi()
      .then((a) => a.getContextSummary())
      .then((c) => setRepos(c.repos))
      .catch(() => setRepos(null))
  }, [load])

  return (
    <div className="mx-auto max-w-[880px] px-8 py-7">
      <ScreenHeader eyebrow="Set up Mesh" title="Connections" />
      <p className="mt-2 max-w-lg text-[14px] text-muted">
        Grafana comes first — service discovery seeds everything. All credentials stay yours; Mesh holds no
        secrets of its own and never writes without your approval.
      </p>

      <div className="mt-6 flex flex-col gap-2">
        {list.map((c) => (
          <ConnectionCard key={c.id} conn={c} onManage={() => openWizard(c.id)} />
        ))}
      </div>

      {repos && repos.count > 0 && (
        <div className="mt-3 flex items-center gap-2.5 rounded-md border border-line bg-ink-900 px-4 py-2.5">
          <span className="grid h-6 w-6 place-items-center rounded-sm border border-line bg-ink-850 font-mono text-[10px] text-gold-400">⌥</span>
          <span className="font-mono text-[11px] text-subtle">
            workspace · {repos.count.toLocaleString('en-US')} git repos cloned for blame/log
            {repos.lastFetchedAt ? ` · fetched ${timeAgo(repos.lastFetchedAt)}` : ''}
          </span>
        </div>
      )}

      <div className="mt-6">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-subtle">Clusters (read-only · your own login)</div>
        <KubernetesCard />
      </div>

      {wizardOpen && (
        <ConnectWizard source={wizardOpen} onConnect={(fields) => connect(wizardOpen, fields)} onClose={() => openWizard(null)} />
      )}
    </div>
  )
}

import { useEffect } from 'react'
import { useConnections } from '../stores/connections'
import { ScreenHeader } from '../components/layout/ScreenHeader'
import { ConnectionCard } from '../components/connections/ConnectionCard'
import { ConnectWizard } from '../components/connections/ConnectWizard'
import { KubernetesCard } from '../components/connections/KubernetesCard'

export function Connections() {
  const { list, load, wizardOpen, openWizard, connect } = useConnections()

  useEffect(() => {
    void load()
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

import { useEffect, useState } from 'react'
import type { CliAuth, K8sStatus } from '@shared/types'
import { getApi } from '../../lib/api'
import { useTerminal } from '../../stores/terminal'
import { Button, Pill } from '../ui'
import type { PillTone } from '../ui/Pill'

/** Connections → Kubernetes: detect local tooling, whether it's still logged
 *  in, and how registry services map onto kubectl contexts. Mesh stores no
 *  cloud creds — it reads what gcloud/az/kubectl already have on your login.
 *
 *  The card's job is to never look healthy when live reads would fail, so it
 *  reports three independently-breakable things: the CLI exists, it's logged
 *  in, and the exec credential plugin the kubeconfig names is installed. */

const AUTH_LABEL: Record<CliAuth, string> = {
  ok: 'signed in',
  stale: 'login expired',
  none: 'not signed in',
  absent: 'not installed',
  unknown: 'unverified',
}
const AUTH_TONE: Record<CliAuth, PillTone> = {
  ok: 'ok',
  stale: 'warn',
  none: 'warn',
  absent: 'neutral',
  unknown: 'neutral',
}

/** One actionable problem: what's wrong, and the command that fixes it. */
interface Remedy {
  key: string
  headline: string
  detail: string
  command?: string
}

const INSTALL_HINT: Record<'gcloud' | 'az', string> = {
  gcloud: 'brew install --cask google-cloud-sdk',
  az: 'brew install azure-cli',
}
const LOGIN_CMD: Record<'gcloud' | 'az', string> = { gcloud: 'gcloud auth login', az: 'az login' }

/** Remedy for a provider CLI whose contexts depend on it. `unknown` never
 *  produces one — an offline probe must not masquerade as an expired login. */
function cliRemedy(cli: 'gcloud' | 'az', auth: CliAuth, affected: string[]): Remedy | null {
  if (!affected.length || auth === 'ok' || auth === 'unknown') return null
  const list = affected.join(', ')
  if (auth === 'absent')
    return {
      key: `${cli}-absent`,
      headline: `${cli} not on Mesh's PATH`,
      detail: `${affected.length} context(s) authenticate through it (${list}), so live reads will fail. Install it, or launch Mesh from a shell that has it on PATH.`,
      command: INSTALL_HINT[cli],
    }
  return {
    key: `${cli}-${auth}`,
    headline: `${cli} ${AUTH_LABEL[auth]}`,
    detail: `${affected.length} context(s) authenticate through it (${list}), so live reads will fail until you sign in${auth === 'stale' ? ' again' : ''}.`,
    command: LOGIN_CMD[cli],
  }
}

export function KubernetesCard() {
  const [status, setStatus] = useState<K8sStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const launch = useTerminal((t) => t.launch)
  const exitNonce = useTerminal((t) => t.exitNonce)

  const load = async () => {
    setBusy(true)
    try {
      const api = await getApi()
      setStatus(await api.getK8sStatus())
      setError(null)
    } catch (e) {
      // Never leave a previous reading on screen as if it were current.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void load()
    // Re-run after a terminal session exits: the user may have just fixed this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exitNonce])

  /** One tooling row: presence dot, name, and login state when installed. */
  const tool = (name: 'gcloud' | 'az' | 'kubectl', present: boolean, auth?: CliAuth) => (
    <span className="flex items-center gap-1.5 font-mono text-[11px]">
      <span className={present ? 'text-[color:var(--ada-success)]' : 'text-subtle'}>{present ? '●' : '○'}</span>
      {name}
      {auth && present && <Pill tone={AUTH_TONE[auth]}>{AUTH_LABEL[auth]}</Pill>}
    </span>
  )

  const anyTool = status && (status.kubectl || status.gcloud || status.az)

  // Only nag about a CLI login when a context actually delegates auth to it —
  // AKS clusterUser contexts carry embedded creds and keep working regardless.
  const remedies: Remedy[] = []
  if (status) {
    for (const cli of ['gcloud', 'az'] as const) {
      const auth = cli === 'gcloud' ? status.gcloudAuth : status.azAuth
      const provider = cli === 'gcloud' ? 'gcp' : 'azure'
      const affected = status.contexts.filter((c) => c.needsCliLogin && c.provider === provider).map((c) => c.name)
      const r = cliRemedy(cli, auth, affected)
      if (r) remedies.push(r)
    }
    // A missing exec plugin fails reads even when the CLI login is perfect.
    const missing = new Map<string, string[]>()
    for (const c of status.contexts.filter((c) => c.execBinMissing && c.execBin)) {
      missing.set(c.execBin as string, [...(missing.get(c.execBin as string) ?? []), c.name])
    }
    for (const [bin, ctxs] of missing) {
      const short = bin.split('/').pop() ?? bin
      remedies.push({
        key: `plugin-${short}`,
        headline: `${short} not found`,
        detail: `${ctxs.length} context(s) (${ctxs.join(', ')}) authenticate through this plugin, but it isn't installed — reads fail with "executable not found" even though your CLI login is fine.`,
        command: short.includes('gke')
          ? 'gcloud components install gke-gcloud-auth-plugin'
          : 'az aks install-cli',
      })
    }
  }

  const orphans = (status?.mapped ?? []).filter((m) => !m.contextExists)

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

      {error && (
        <div className="mt-3 rounded-sm border border-[color:var(--ada-danger)]/40 bg-ink-900 px-3 py-2 text-[12.5px] text-muted">
          Couldn’t read cluster status: <span className="font-mono text-[11px]">{error}</span>
        </div>
      )}

      {status && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-sm border border-line bg-ink-900 px-3 py-2">
            {tool('kubectl', status.kubectl)}
            {tool('gcloud', status.gcloud, status.gcloudAuth)}
            {tool('az', status.az, status.azAuth)}
          </div>

          {!status.kubectl && (
            <div className="rounded-sm border border-[color:var(--ada-warning)]/40 bg-ink-900 px-3 py-2.5">
              <div className="text-[12.5px] leading-relaxed text-muted">
                <span className="text-[color:var(--ada-warning)]">kubectl not on Mesh’s PATH</span> — every live cluster read is unavailable, whatever the registry says.
              </div>
              <div className="mt-1.5 select-all rounded-sm border border-line bg-ink-850 px-2 py-1 font-mono text-[11px] text-txt">brew install kubectl</div>
            </div>
          )}

          {remedies.map((r) => (
            <div key={r.key} className="rounded-sm border border-[color:var(--ada-warning)]/40 bg-ink-900 px-3 py-2.5">
              <div className="text-[12.5px] leading-relaxed text-muted">
                <span className="text-[color:var(--ada-warning)]">{r.headline}</span> — {r.detail}
              </div>
              {r.command && (
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 select-all rounded-sm border border-line bg-ink-850 px-2 py-1 font-mono text-[11px] text-txt">{r.command}</div>
                  <Button onClick={() => void launch({ title: r.headline, command: r.command })}>Run</Button>
                </div>
              )}
            </div>
          ))}

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
                  const used = status.mapped.some((m) => m.context === c.name)
                  return (
                    <span key={c.name} className="flex items-center gap-1.5 rounded-sm border border-line bg-ink-900 px-2 py-1 font-mono text-[11px] text-muted">
                      {c.name}
                      {c.provider !== 'other' && <span className="text-subtle">{c.provider === 'gcp' ? 'GKE' : 'AKS'}</span>}
                      {c.execBinMissing && <Pill tone="warn">no plugin</Pill>}
                      {used && <Pill tone="ok">mapped</Pill>}
                    </span>
                  )
                })}
              </div>
            </div>
          ) : (
            anyTool &&
            status.kubectl && (
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
                  <div key={m.service} className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
                    <span>
                      {m.service} → {m.context}
                      {m.namespace && <span className="text-subtle"> · ns {m.namespace}</span>}
                    </span>
                    {!m.contextExists && <Pill tone="warn">not in kubeconfig</Pill>}
                  </div>
                ))}
              </div>
              {orphans.length > 0 && (
                <p className="mt-1.5 text-[12px] leading-relaxed text-subtle">
                  {orphans.length} mapping(s) point at a context this machine doesn’t have — live reads for those services fail with “no context exists”. Fix the{' '}
                  <span className="text-muted">Cluster context</span> field in the Service registry, or add the context with{' '}
                  <span className="font-mono">get-credentials</span>.
                </p>
              )}
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

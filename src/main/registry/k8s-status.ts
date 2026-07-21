// Kubernetes tooling detection for the Connections card (Phase 3). Read-only:
// which CLIs the machine has (gcloud / az / kubectl on the user's own login),
// whether those CLIs are still logged in, which kubectl contexts exist, and how
// the registry maps services onto them.
//
// The bar this file has to clear is "never show green when reads would fail".
// That means checking three separate things that can each break independently:
// the CLI exists, the CLI is logged in, and the exec credential plugin the
// kubeconfig points at is actually installed.
//
// Mesh stores no cloud credentials — this only reports what's already there.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Database } from 'better-sqlite3'
import type { CliAuth, K8sContext, K8sStatus } from '../../shared/types'
import { servicesRepo } from '../db/repos/services'
import { log } from '../log'

const exec = promisify(execFile)
const l = log('k8s-status')

interface RunResult {
  ok: boolean
  stdout: string
  stderr: string
  /** killed by our own timeout — the machine is slow/offline, not unauthenticated */
  timedOut: boolean
}

/** Run a command; never throws. Auth probes can hit the network, so they get a
 *  longer leash than the plain "is it installed" checks. */
async function run(bin: string, args: string[], timeout = 8_000): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(bin, args, { timeout })
    return { ok: true, stdout, stderr: stderr ?? '', timedOut: false }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; killed?: boolean; signal?: string }
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      timedOut: Boolean(err.killed) || err.signal === 'SIGTERM',
    }
  }
}

/** Is a binary present and runnable? (short, never throws) */
async function has(bin: string, args: string[]): Promise<boolean> {
  return (await run(bin, args, 5_000)).ok
}

// Signatures that mean "your credentials are the problem" rather than "the
// network is". Anything else keeps the state `unknown`, because nagging an
// offline user to re-login is the false alarm we're trying to avoid.
const GCLOUD_REAUTH = /reauthentication failed|invalid_grant|credentials have expired|do not have valid credentials|re-?run.*auth login/i
const AZ_REAUTH = /aadsts50173|aadsts700082|refresh token has expired|az login|interactive authentication is needed|please run .?az login/i
const OFFLINE = /network|temporary failure|could not resolve|connection reset|unable to reach|timed out|getaddrinfo|dns/i

/** Turn a failed token probe into a state, using the error text to separate
 *  "expired" from "offline". `hasAccount` decides expired-vs-never-signed-in. */
function classifyAuthFailure(r: RunResult, reauth: RegExp, hasAccount: boolean): CliAuth {
  if (r.timedOut) return 'unknown'
  const text = `${r.stderr}\n${r.stdout}`
  if (OFFLINE.test(text) && !reauth.test(text)) return 'unknown'
  if (reauth.test(text)) return hasAccount ? 'stale' : 'none'
  return hasAccount ? 'stale' : 'none'
}

/** gcloud login state. `print-access-token` is the honest probe — it actually
 *  refreshes, which is what a GKE exec plugin does on every call. `auth list`
 *  exits 0 even with zero accounts, so it's the stdout that distinguishes
 *  "token expired" from "never logged in". */
async function gcloudAuthState(installed: boolean): Promise<CliAuth> {
  if (!installed) return 'absent'
  const token = await run('gcloud', ['auth', 'print-access-token'])
  if (token.ok) return 'ok'
  const accounts = await run('gcloud', ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'])
  return classifyAuthFailure(token, GCLOUD_REAUTH, Boolean(accounts.stdout.trim()))
}

/** az login state. Same shape: can we mint a token, and if not, is there a
 *  signed-in account whose refresh token merely lapsed? */
async function azAuthState(installed: boolean): Promise<CliAuth> {
  if (!installed) return 'absent'
  const token = await run('az', ['account', 'get-access-token', '--output', 'none'])
  if (token.ok) return 'ok'
  const account = await run('az', ['account', 'show', '--output', 'none'])
  return classifyAuthFailure(token, AZ_REAUTH, account.ok)
}

/** Which provider a context belongs to, and whether it delegates auth to that
 *  provider's CLI. Driven by the kubeconfig's exec plugin: GKE shells out to
 *  gke-gcloud-auth-plugin and AKS-with-AAD to kubelogin, so those genuinely
 *  break on a stale login. Legacy GKE entries use the pre-exec
 *  `auth-provider: gcp` block, which is equally gcloud-gated. A context with
 *  neither carries its own credentials (e.g. AKS clusterUser certs) and is
 *  unaffected by CLI login. */
export function classify(
  execCommand: string | undefined,
  cluster: string,
  name: string,
  authProvider?: string,
): Omit<K8sContext, 'name'> {
  const cmd = (execCommand ?? '').toLowerCase()
  if (cmd.includes('gcloud')) return { provider: 'gcp', needsCliLogin: true, execBin: execCommand }
  if (cmd.includes('kubelogin')) return { provider: 'azure', needsCliLogin: true, execBin: execCommand }
  // Deprecated in-tree providers: still gcloud-gated, just without an exec block.
  if ((authProvider ?? '').toLowerCase() === 'gcp') return { provider: 'gcp', needsCliLogin: true }
  if ((authProvider ?? '').toLowerCase() === 'azure') return { provider: 'azure', needsCliLogin: true }

  // No delegation: infer the provider for labelling only — auth is embedded.
  const hay = `${cluster} ${name}`.toLowerCase()
  const provider = /gke|gcp|google/.test(hay) ? 'gcp' : /aks|azmk8s|azure/.test(hay) ? 'azure' : 'other'
  return { provider, needsCliLogin: false }
}

interface KubeconfigView {
  contexts?: { name: string; context?: { cluster?: string; user?: string } }[]
  users?: {
    name: string
    user?: { exec?: { command?: string }; 'auth-provider'?: { name?: string } }
  }[]
}

/** kubectl contexts with their auth shape. `degraded` means we couldn't read
 *  the kubeconfig at all, which must suppress any "context doesn't exist" claim.
 *  `config view` redacts secrets, so nothing sensitive is read here. */
async function contexts(): Promise<{ list: K8sContext[]; degraded: boolean }> {
  const viewed = await run('kubectl', ['config', 'view', '-o', 'json'], 5_000)
  if (viewed.ok) {
    try {
      const cfg = JSON.parse(viewed.stdout) as KubeconfigView
      const byUser = new Map((cfg.users ?? []).map((u) => [u.name, u.user]))
      const list = (cfg.contexts ?? [])
        .filter((c) => c?.name)
        .map((c) => {
          const u = byUser.get(c.context?.user ?? '')
          return {
            name: c.name,
            ...classify(u?.exec?.command, c.context?.cluster ?? '', c.name, u?.['auth-provider']?.name),
          }
        })
      return { list, degraded: false }
    } catch {
      // fall through to the name-only path below
    }
  }
  // Fallback: a kubeconfig we couldn't parse still yields usable names. Assume
  // no CLI dependency rather than nagging about a login that may not be needed.
  const names = await run('kubectl', ['config', 'get-contexts', '-o', 'name'], 5_000)
  const list = names.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, ...classify(undefined, '', name) }))
  // Degraded only if we truly learned nothing — an empty kubeconfig is a real
  // (and correctly reported) state, not a failure to read one.
  return { list, degraded: !names.ok }
}

/** Resolve each distinct exec credential plugin once. A kubeconfig can name a
 *  plugin that was never installed (gke-gcloud-auth-plugin ships as a separate
 *  gcloud component), in which case reads fail with "executable not found"
 *  even though `gcloud auth` is perfectly healthy — the exact false-green this
 *  card exists to prevent. */
async function markMissingExecPlugins(list: K8sContext[]): Promise<void> {
  const bins = [...new Set(list.map((c) => c.execBin).filter((b): b is string => Boolean(b)))]
  const present = new Map<string, boolean>()
  await Promise.all(
    bins.map(async (b) => {
      // Plugins accept --version; an absent binary fails with ENOENT either way.
      present.set(b, await has(b, ['--version']))
    }),
  )
  for (const c of list) if (c.execBin) c.execBinMissing = present.get(c.execBin) === false
}

export async function k8sStatus(db: Database): Promise<K8sStatus> {
  const [kubectl, gcloud, az] = await Promise.all([
    has('kubectl', ['version', '--client=true', '-o', 'json']),
    has('gcloud', ['--version']),
    has('az', ['version', '--output', 'none']),
  ])
  const [gcloudAuth, azAuth, ctx] = await Promise.all([
    gcloudAuthState(gcloud),
    azAuthState(az),
    kubectl ? contexts() : Promise.resolve({ list: [] as K8sContext[], degraded: false }),
  ])
  await markMissingExecPlugins(ctx.list)

  const known = new Set(ctx.list.map((c) => c.name))
  const services = servicesRepo(db).list()
  const mapped = services
    .filter((s) => s.ids.k8s_context)
    .map((s) => ({
      service: s.name,
      context: s.ids.k8s_context,
      namespace: s.namespace,
      // Can't claim a context is missing if we never managed to read the list.
      contextExists: ctx.degraded || !kubectl ? true : known.has(s.ids.k8s_context),
    }))
  // "unmapped" = services that have observability wiring (a Loki label, i.e.
  // real running services) but no cluster context yet — the ones worth mapping.
  const unmappedServices = services.filter((s) => s.ids.loki_label && !s.ids.k8s_context).map((s) => s.name)

  const missingPlugins = ctx.list.filter((c) => c.execBinMissing).length
  l.info(
    `k8s status: kubectl=${kubectl} gcloud=${gcloud}(${gcloudAuth}) az=${az}(${azAuth}) · ${ctx.list.length} contexts` +
      `${ctx.degraded ? ' (degraded)' : ''} · ${mapped.length} mapped · ${missingPlugins} missing exec plugin(s)`,
  )
  return {
    kubectl,
    gcloud,
    az,
    gcloudAuth,
    azAuth,
    contexts: ctx.list,
    contextsDegraded: ctx.degraded,
    mapped,
    unmappedServices,
  }
}

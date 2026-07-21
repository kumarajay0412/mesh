// Kubernetes tooling detection for the Connections card (Phase 3). Read-only:
// which CLIs the machine has (gcloud / az / kubectl on the user's own login),
// which kubectl contexts exist, and how the registry maps services onto them.
// Mesh stores no cloud credentials — this only reports what's already there.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Database } from 'better-sqlite3'
import type { K8sStatus } from '../../shared/types'
import { servicesRepo } from '../db/repos/services'
import { log } from '../log'

const exec = promisify(execFile)
const l = log('k8s-status')

/** Is a binary present and runnable? (short, never throws) */
async function has(bin: string, args: string[]): Promise<boolean> {
  try {
    await exec(bin, args, { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

/** kubectl context names, or [] if kubectl is absent/misconfigured. */
async function contexts(): Promise<string[]> {
  try {
    const { stdout } = await exec('kubectl', ['config', 'get-contexts', '-o', 'name'], { timeout: 5_000 })
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export async function k8sStatus(db: Database): Promise<K8sStatus> {
  const [kubectl, gcloud, az, ctxs] = await Promise.all([
    has('kubectl', ['version', '--client=true', '-o', 'json']),
    has('gcloud', ['--version']),
    has('az', ['version', '--output', 'none']),
    contexts(),
  ])

  const services = servicesRepo(db).list()
  const mapped = services
    .filter((s) => s.ids.k8s_context)
    .map((s) => ({ service: s.name, context: s.ids.k8s_context, namespace: s.namespace }))
  // "unmapped" = services that have observability wiring (a Loki label, i.e.
  // real running services) but no cluster context yet — the ones worth mapping.
  const unmappedServices = services.filter((s) => s.ids.loki_label && !s.ids.k8s_context).map((s) => s.name)

  l.info(`k8s status: kubectl=${kubectl} gcloud=${gcloud} az=${az} · ${ctxs.length} contexts · ${mapped.length} mapped`)
  return { kubectl, gcloud, az, contexts: ctxs, mapped, unmappedServices }
}

// The deterministic pre-collected brief (Move 2). Runbook steps 1-3 — pin the
// onset window, note deploy markers, triage error-rate deltas — are MECHANICAL.
// The agent used to do them by hand (python3 epoch math, annotation lookups,
// Loki queries), burning ~15 turns before reaching judgment. We run them as
// code here, before the session spawns, and inject the result so the agent
// starts at step 4.
//
// BEST-EFFORT by construction: no Grafana, no registry labels, or any failed
// query → the relevant section is simply absent (with an honest note) and the
// agent does that part itself, exactly as today. This never throws.
import type { Database } from 'better-sqlite3'
import type { ServiceEntry } from '../../shared/types'
import type { SecretStore } from '../security/secrets'
import { log } from '../log'

const l = log('precollect')
const QUERY_TIMEOUT_MS = 12_000
const MAX_SERVICES = 3 // bound the Loki fan-out

export interface OnsetWindow {
  fromMs: number
  toMs: number
  source: string // how we derived it, for the audit trail
}

export interface ErrorDelta {
  service: string
  instance: string
  windowCount: number
  baselineCount: number // same-length window, 24h earlier
}

export interface DeployMarker {
  instance: string
  text: string
  timeMs: number
}

/** Kubernetes state in the onset window, from kube-state-metrics via the
 *  Grafana Prometheus datasource — no cluster credentials needed. A null field
 *  means the metric wasn't present (different exporter, or no data). */
export interface K8sSignal {
  service: string
  instance: string
  restarts: number | null // pod container restarts in the window
  ooms: number | null // pods whose last termination was OOMKilled
  deploys: number | null // deployment generation changes (rollouts)
  maxUnavailable: number | null // peak unavailable replicas (readiness/liveness)
}

export interface PreCollectBrief {
  window: OnsetWindow | null
  deploys: DeployMarker[]
  errorDeltas: ErrorDelta[]
  k8s: K8sSignal[]
  notes: string[] // degradations, for honesty
}

/* ------------------------------------------------------- window parsing -- */

/** Best-effort onset window from the intake's free-text time string, anchored
 *  to the ticket's reported time when the string is time-only. Pure; tested. */
export function parseWindow(timeWindow: string | undefined, anchorMs: number | undefined): OnsetWindow | null {
  const anchor = anchorMs && anchorMs > 0 ? anchorMs : undefined
  const t = (timeWindow ?? '').trim()

  if (t) {
    // 1) a full range with two parseable endpoints ("2026-07-08T02:00Z to 15:00Z", "02:00-15:00Z")
    const iso = [...t.matchAll(/\b(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?Z?)\b/g)].map((m) => Date.parse(m[1])).filter((n) => !Number.isNaN(n))
    if (iso.length >= 2) return { fromMs: Math.min(iso[0], iso[1]), toMs: Math.max(iso[0], iso[1]), source: `stated range: ${t}` }
    if (iso.length === 1) return { fromMs: iso[0] - 30 * 60_000, toMs: iso[0] + 2 * 3600_000, source: `stated onset: ${t}` }

    // 2) clock times (HH:MM[Z]) anchored to the ticket's report date
    const clocks = [...t.matchAll(/\b(\d{1,2}):(\d{2})\s*(Z|UTC|IST)?/gi)]
    if (clocks.length && anchor) {
      const day = new Date(anchor)
      const at = (h: number, m: number) => Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m)
      const times = clocks.map((c) => at(Number(c[1]), Number(c[2]))).sort((a, b) => a - b)
      if (times.length >= 2) return { fromMs: times[0], toMs: times[times.length - 1], source: `clock range on report date: ${t}` }
      return { fromMs: times[0] - 30 * 60_000, toMs: times[0] + 2 * 3600_000, source: `clock onset on report date: ${t}` }
    }
  }

  // 3) fall back to a window around the ticket's report time
  if (anchor) return { fromMs: anchor - 3600_000, toMs: anchor + 2 * 3600_000, source: 'ticket report time (no explicit onset stated)' }
  return null
}

/* ---------------------------------------------------------- Grafana I/O -- */

async function gfetch(base: string, token: string, path: string): Promise<unknown> {
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`${res.status} ${path.split('?')[0]}`)
  return res.json()
}

function readInstances(db: Database): { name: string; url: string }[] {
  const r = db.prepare(`SELECT value_json FROM settings WHERE key = 'grafana.instances'`).get() as { value_json: string } | undefined
  return r ? (JSON.parse(r.value_json) as { name: string; url: string }[]) : []
}

/** Loki + Prometheus datasource uids on an instance, in one call. */
async function resolveDatasources(base: string, token: string): Promise<{ lokiUid: string | null; promUid: string | null }> {
  const dss = (await gfetch(base, token, '/api/datasources')) as { uid: string; type: string }[]
  return {
    lokiUid: dss.find((d) => d.type === 'loki')?.uid ?? null,
    promUid: dss.find((d) => d.type === 'prometheus')?.uid ?? null,
  }
}

/** Instant PromQL query → scalar (null when absent). Resources path (Grafana
 *  ≥8); best-effort, so any failure surfaces as null and a note upstream. */
async function promInstant(base: string, token: string, uid: string, query: string, timeMs: number): Promise<number | null> {
  const url = `/api/datasources/uid/${uid}/resources/api/v1/query?query=${encodeURIComponent(query)}&time=${Math.round(timeMs / 1000)}`
  const r = (await gfetch(base, token, url)) as { data?: { result?: { value?: [number, string] }[] } }
  const v = r.data?.result?.[0]?.value?.[1]
  return v != null ? Number(v) : null
}

/** Escape a service name for safe use inside a PromQL `=~` regex matcher. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The four kube-state-metrics queries for one service over [durMs]. Pod names
 *  are `<deployment>-<hash>`, so we match by prefix. Pure; tested. */
export function buildK8sQueries(name: string, durMs: number): { restarts: string; ooms: string; deploys: string; unavailable: string } {
  const dur = `${Math.max(1, Math.round(durMs / 60_000))}m`
  const pod = `pod=~"${escapeRe(name)}.*"`
  const dep = `deployment=~"${escapeRe(name)}.*"`
  return {
    restarts: `sum(increase(kube_pod_container_status_restarts_total{${pod}}[${dur}]))`,
    ooms: `sum(max_over_time(kube_pod_container_status_last_terminated_reason{reason="OOMKilled",${pod}}[${dur}]))`,
    deploys: `sum(changes(kube_deployment_status_observed_generation{${dep}}[${dur}]))`,
    unavailable: `max(max_over_time(kube_deployment_status_replicas_unavailable{${dep}}[${dur}]))`,
  }
}

/** `app=cmd-batch-asr` → `{app="cmd-batch-asr"}` (LogQL stream selector). */
function toSelector(lokiLabel: string): string | null {
  const m = lokiLabel.match(/^\s*([a-zA-Z_][\w]*)\s*=\s*(.+?)\s*$/)
  return m ? `{${m[1]}="${m[2]}"}` : null
}

/** count_over_time of error-ish lines over [ms window] ending at `endMs`. */
async function lokiErrorCount(base: string, token: string, uid: string, selector: string, endMs: number, durMs: number): Promise<number> {
  const dur = `${Math.max(1, Math.round(durMs / 60_000))}m`
  const query = `sum(count_over_time(${selector} |~ "(?i)(error|fatal|panic|exception|oomkill|timeout|refused|deadline)" [${dur}]))`
  const url = `/api/datasources/uid/${uid}/resources/loki/api/v1/query?query=${encodeURIComponent(query)}&time=${endMs}000000`
  const r = (await gfetch(base, token, url)) as { data?: { result?: { value?: [number, string] }[] } }
  const v = r.data?.result?.[0]?.value?.[1]
  return v ? Number(v) : 0
}

/** Deploy annotations on an instance within [from, to]. */
async function deployAnnotations(base: string, token: string, fromMs: number, toMs: number): Promise<{ text: string; timeMs: number }[]> {
  const r = (await gfetch(base, token, `/api/annotations?from=${fromMs}&to=${toMs}&limit=50`)) as { text?: string; time?: number }[]
  return (Array.isArray(r) ? r : []).filter((a) => a.time).map((a) => ({ text: (a.text ?? 'deploy').slice(0, 120), timeMs: a.time! }))
}

/* --------------------------------------------------------- the collector -- */

/** Run the deterministic pre-collection. Returns null only when there is
 *  nothing to collect (no Grafana AND no window) — otherwise a brief, possibly
 *  partial, with notes explaining any gaps. Never throws. */
export async function preCollect(
  db: Database,
  secrets: SecretStore,
  input: { services: ServiceEntry[]; timeWindow?: string; anchorMs?: number },
): Promise<PreCollectBrief | null> {
  const notes: string[] = []
  const window = parseWindow(input.timeWindow, input.anchorMs)
  const instances = readInstances(db)

  if (instances.length === 0) {
    // No Grafana → nothing deterministic to collect. Still report the window if
    // we could anchor one — it saves the agent the epoch math.
    return window ? { window, deploys: [], errorDeltas: [], k8s: [], notes: ['Grafana not connected — deploy/error/k8s signals not pre-collected'] } : null
  }
  if (!window) {
    notes.push('onset window could not be determined from the ticket — establish it first (runbook step 1)')
    return { window: null, deploys: [], errorDeltas: [], k8s: [], notes }
  }

  const durMs = Math.min(24 * 3600_000, Math.max(15 * 60_000, window.toMs - window.fromMs))
  const deploys: DeployMarker[] = []
  const errorDeltas: ErrorDelta[] = []
  const k8s: K8sSignal[] = []

  // token + datasource uids (loki + prometheus) per instance, resolved once
  const instCtx = new Map<string, { url: string; token: string; lokiUid: string | null; promUid: string | null }>()
  await Promise.all(
    instances.map(async (inst) => {
      const token = secrets.get(`grafana.token.${inst.name}`)
      if (!token) {
        notes.push(`Grafana "${inst.name}": no readable token`)
        return
      }
      let ds = { lokiUid: null as string | null, promUid: null as string | null }
      try {
        ds = await resolveDatasources(inst.url, token)
      } catch (e) {
        notes.push(`Grafana "${inst.name}": datasource lookup failed (${(e as Error).message})`)
      }
      instCtx.set(inst.name, { url: inst.url, token, ...ds })
      // deploy markers (instance-level, cheap)
      try {
        for (const a of await deployAnnotations(inst.url, token, window.fromMs, window.toMs)) deploys.push({ instance: inst.name, ...a })
      } catch (e) {
        notes.push(`Grafana "${inst.name}": annotations query failed (${(e as Error).message})`)
      }
    }),
  )

  // Per candidate service: Loki error-rate delta (needs loki_label) AND
  // kube-state-metrics signals (needs only the service/pod name).
  const candidates = input.services.slice(0, MAX_SERVICES)
  const podNameOf = (svc: ServiceEntry) => svc.ids.loki_label?.match(/=\s*(.+)$/)?.[1]?.trim() || svc.name
  await Promise.all(
    candidates.map(async (svc) => {
      const instName = svc.ids.grafana_instance
      const ctx = instName ? instCtx.get(instName) : [...instCtx.values()][0]
      if (!ctx) return

      // (a) Loki error-rate delta
      const selector = svc.ids.loki_label ? toSelector(svc.ids.loki_label) : null
      if (ctx.lokiUid && selector) {
        try {
          const [windowCount, baselineCount] = await Promise.all([
            lokiErrorCount(ctx.url, ctx.token, ctx.lokiUid, selector, window.toMs, durMs),
            lokiErrorCount(ctx.url, ctx.token, ctx.lokiUid, selector, window.toMs - 24 * 3600_000, durMs),
          ])
          errorDeltas.push({ service: svc.name, instance: instName ?? '?', windowCount, baselineCount })
        } catch (e) {
          notes.push(`${svc.name}: error-rate query failed (${(e as Error).message})`)
        }
      }

      // (b) Kubernetes signals via Prometheus — durable deploy/restart/OOM
      // history that live `kubectl get events` (~1h TTL) can't provide.
      if (ctx.promUid) {
        const q = buildK8sQueries(podNameOf(svc), durMs)
        try {
          const [restarts, ooms, deploysN, maxUnavailable] = await Promise.all([
            promInstant(ctx.url, ctx.token, ctx.promUid, q.restarts, window.toMs),
            promInstant(ctx.url, ctx.token, ctx.promUid, q.ooms, window.toMs),
            promInstant(ctx.url, ctx.token, ctx.promUid, q.deploys, window.toMs),
            promInstant(ctx.url, ctx.token, ctx.promUid, q.unavailable, window.toMs),
          ])
          if ([restarts, ooms, deploysN, maxUnavailable].some((v) => v != null)) {
            k8s.push({ service: svc.name, instance: instName ?? '?', restarts, ooms, deploys: deploysN, maxUnavailable })
          }
        } catch (e) {
          notes.push(`${svc.name}: k8s metrics query failed (${(e as Error).message})`)
        }
      }
    }),
  )

  const anyProm = [...instCtx.values()].some((c) => c.promUid)
  if (!anyProm && input.services.length) notes.push('no Prometheus datasource on the connected Grafana — pod restart/OOM/deploy signals unavailable (agent will use live kubectl if configured)')
  if (input.services.length && !input.services.some((s) => s.ids.loki_label)) notes.push('candidate services have no Loki label in the registry — run Discover from Grafana to enable error-rate triage')
  l.info(`pre-collect: window ${new Date(window.fromMs).toISOString()}–${new Date(window.toMs).toISOString()} · ${deploys.length} deploys · ${errorDeltas.length} error deltas · ${k8s.length} k8s`)
  return { window, deploys, errorDeltas, k8s, notes }
}

/* ----------------------------------------------------------- formatting -- */

const iso = (ms: number) => new Date(ms).toISOString().replace('.000', '')

/** Render the brief as the prompt block the agent reads. Empty string when
 *  there's nothing worth injecting. Pure; tested. */
export function formatBrief(brief: PreCollectBrief | null): string {
  if (!brief) return ''
  const lines: string[] = ['\nPRE-COLLECTED BRIEF (deterministic — gathered by Mesh in code before this session; AUDIT it, then start at the strongest signal):']

  if (brief.window) {
    lines.push(`- Onset window (${brief.window.source}): ${iso(brief.window.fromMs)} → ${iso(brief.window.toMs)}. Anchor every query to this; do NOT re-derive it.`)
  }

  if (brief.deploys.length) {
    const sorted = [...brief.deploys].sort((a, b) => a.timeMs - b.timeMs).slice(0, 8)
    lines.push('- Deploy markers in the window:')
    for (const d of sorted) lines.push(`    ${iso(d.timeMs)} · ${d.instance} · ${d.text}`)
  } else if (brief.window) {
    lines.push('- Deploy markers in the window: none found (a symptom NOT at a deploy boundary — weaker prior for a code change).')
  }

  if (brief.errorDeltas.length) {
    lines.push('- Error-rate triage (matching lines in-window vs the same window 24h earlier):')
    for (const e of brief.errorDeltas) {
      const ratio = e.baselineCount > 0 ? `${(e.windowCount / e.baselineCount).toFixed(1)}x` : e.windowCount > 0 ? 'new (baseline 0)' : 'flat'
      lines.push(`    ${e.service}: ${e.windowCount} vs ${e.baselineCount} baseline → ${ratio}`)
    }
    lines.push('  (A large delta = follow that service first. Flat = the error is elsewhere or pre-existing.)')
  }

  const k8sLines = brief.k8s
    .map((s) => {
      const bits: string[] = []
      if (s.restarts && s.restarts >= 1) bits.push(`${Math.round(s.restarts)} pod restart(s)`)
      if (s.ooms && s.ooms >= 1) bits.push(`${Math.round(s.ooms)} OOMKilled`)
      if (s.deploys && s.deploys >= 1) bits.push(`${Math.round(s.deploys)} deploy(s)`)
      if (s.maxUnavailable && s.maxUnavailable >= 1) bits.push(`peak ${Math.round(s.maxUnavailable)} unavailable replica(s)`)
      return bits.length ? `    ${s.service}: ${bits.join(' · ')}` : null
    })
    .filter((x): x is string => x !== null)
  if (k8sLines.length) {
    lines.push('- Kubernetes in the window (from Grafana Prometheus / kube-state-metrics — durable, unlike live `kubectl get events`):')
    lines.push(...k8sLines)
    lines.push('  (Restarts/OOMs at a deploy boundary point at that rollout; without one, look at resource limits, probes, or the node.)')
  }

  if (brief.notes.length) lines.push(`- Gaps (do these yourself): ${brief.notes.join('; ')}`)

  // Only worth injecting if we actually collected something beyond notes.
  const hasSignal = brief.window || brief.deploys.length || brief.errorDeltas.length || k8sLines.length
  return hasSignal ? lines.join('\n') : ''
}

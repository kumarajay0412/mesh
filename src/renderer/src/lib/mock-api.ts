import type {
  AgentEvent,
  ApprovalRequest,
  ConnectionInfo,
  EvidenceItem,
  IntakeInput,
  Investigation,
  MemoryRecord,
  MemorySearchResult,
  ModelStatus,
  Report,
  ServiceEntry,
  SettingsState,
  SourceId,
  SyncProgressEvent,
  SyncSourceState,
} from '@shared/types'
import type { MeshApi } from './api'

const now = Date.now()
const min = 60_000

/* ------------------------------------------------------------- fixtures -- */

const EVIDENCE: EvidenceItem[] = [
  {
    id: 'ev-1',
    type: 'grafana',
    claim: '5xx rate on payments-api jumped 0.2% → 8.4% at 14:21',
    source: 'dashboard pay-main · panel "HTTP status"',
    href: 'https://grafana.internal/d/pay-main?from=1699&to=1700',
    ts: now - 3 * min,
  },
  {
    id: 'ev-2',
    type: 'logql',
    claim: 'Errors are timeouts calling settlement upstream',
    source: '{app="payments-api"} |= "context deadline exceeded"',
    snippet: 'level=error msg="settle: context deadline exceeded" path=/api/pay/settle attempt=3',
    ts: now - 2.5 * min,
  },
  {
    id: 'ev-3',
    type: 'kubectl',
    claim: 'payments-api rolled out at 14:19, 2 min before onset',
    source: 'kubectl rollout history deploy/payments-api -n prod',
    snippet: 'REVISION 214 → deployed 14:19:04Z (image payments-service:9f31c2e)',
    ts: now - 2 * min,
  },
  {
    id: 'ev-4',
    type: 'commit',
    claim: 'Timeout cut 5s → 500ms on the settle client in this deploy',
    source: 'payments-service @ a41f9c2 src/clients/settlement.ts:88',
    snippet: '- timeout: 5_000,\n+ timeout: 500,',
    ts: now - 1.5 * min,
  },
]

const REPORT_050: Report = {
  hypothesis:
    'Search latency p99 regression caused by an unindexed filter added to the query builder in commit 3e8d1a0; p99 tracks the deploy boundary exactly.',
  confidence: 'confirmed',
  rootCauseDetail: {
    points: [
      'At **14:02Z** a deploy shipped commit `3e8d1a0`, adding a plan-tier filter to every search query.',
      'The filter column has **no index** — OpenSearch fell back to a full scan on the hot path, and p99 jumped **180ms → 2.4s** within one scrape interval of the rollout.',
      'Error rate stayed flat — this was a pure latency regression, which is why alerting missed it for 40 minutes.',
    ],
    services: [
      { name: 'search-api', verdict: 'culprit', points: ['`src/query/builder.ts` composes the unindexed filter into every query', 'Rollback restored p99 in one deploy cycle'] },
      { name: 'gateway', verdict: 'cleared', points: ['Upstream timeouts were symptoms, not causes — latency originated below it'] },
    ],
    redHerrings: ['The opensearch client bump `2.11 → 2.12` landed in the same window but reproduces cleanly on 2.11 with the filter applied.'],
    unknowns: ['Why the staging soak did not catch it — staging tenant data is too small to trigger the scan path.'],
    metrics: [
      {
        label: 'search p99 by hour',
        unit: 'ms',
        points: [
          { x: '10:00', y: 172 },
          { x: '11:00', y: 181 },
          { x: '12:00', y: 175 },
          { x: '13:00', y: 190 },
          { x: '14:00', y: 2400 },
          { x: '15:00', y: 2310 },
          { x: '16:00', y: 240 },
        ],
        highlightX: '14:00',
        note: 'from the p99 panel query cited in evidence; 16:00 bucket is post-rollback',
      },
    ],
  },
  culprit: { repo: 'search-api', sha: '3e8d1a07c41b', path: 'src/query/builder.ts' },
  suspects: [
    {
      sha: '3e8d1a07c41b',
      repo: 'search-api',
      path: 'src/query/builder.ts',
      title: 'feat(search): filter by tenant plan tier',
      author: 'r.mehta',
      confidence: 'confirmed',
      signals: ['blame on hot path', 'inside deploy window', 'p99 inflection at deploy'],
    },
    {
      sha: '77aa02cd919e',
      repo: 'search-api',
      title: 'chore: bump opensearch client 2.11 → 2.12',
      author: 'k.iyer',
      confidence: 'suspected',
      signals: ['inside deploy window'],
    },
  ],
  evidence: [
    {
      id: 'r-ev-1',
      type: 'promql',
      claim: 'p99 rose 240ms → 1.9s at 09:12, exactly the deploy marker',
      source: 'histogram_quantile(0.99, search_api_request_seconds_bucket)',
      ts: now - 120 * min,
    },
    {
      id: 'r-ev-2',
      type: 'commit',
      claim: 'New filter bypasses the composite index',
      source: 'search-api @ 3e8d1a0 src/query/builder.ts:141',
      snippet: '+ query.filter("plan_tier", tier)  // no index on plan_tier',
      ts: now - 115 * min,
    },
    {
      id: 'r-ev-3',
      type: 'logql',
      claim: 'OpenSearch slowlog full of plan_tier scans',
      source: '{app="opensearch"} |= "slowlog" |= "plan_tier"',
      ts: now - 110 * min,
    },
  ],
  timeline: [
    { ts: now - 125 * min, label: 'deploy search-api rev 98 (3e8d1a0)', kind: 'deploy' },
    { ts: now - 123 * min, label: 'p99 inflection begins', kind: 'anomaly' },
    { ts: now - 118 * min, label: 'Grafana alert: search p99 SLO burn', kind: 'symptom' },
    { ts: now - 60 * min, label: 'investigation started', kind: 'action' },
  ],
  suggestedFix:
    'Add plan_tier to the composite index (tenant_id, status, plan_tier) or gate the filter behind the existing indexed field set; roll back rev 98 in the interim.',
  unexplored: [
    'OpenSearch client bump (77aa02c) not ruled out as a contributing factor',
    'Cache hit-rate change during the window (looked normal at a glance, not verified)',
  ],
}

const REPORT_051: Report = {
  hypothesis:
    'Checkout 5xx spike caused by commit a41f9c2 cutting the settlement client timeout from 5s to 500ms — settlement p95 is 1.2s, so most settle calls now exceed their deadline and fail checkout.',
  confidence: 'probable',
  culprit: { repo: 'payments-service', sha: 'a41f9c2b7d10', path: 'src/clients/settlement.ts' },
  suspects: [
    {
      sha: 'a41f9c2b7d10',
      repo: 'payments-service',
      path: 'src/clients/settlement.ts',
      title: 'perf(checkout): make checkout snappier — tighten settle timeout',
      author: 'd.sharma',
      confidence: 'probable',
      signals: ['blame on faulting line', 'deployed 2m before onset', 'log signature matches'],
    },
  ],
  evidence: EVIDENCE,
  timeline: [
    { ts: now - 6 * min, label: 'deploy payments-api rev 214 (a41f9c2)', kind: 'deploy' },
    { ts: now - 4 * min, label: '5xx rate steps 0.2% → 8.4%', kind: 'anomaly' },
    { ts: now - 4 * min, label: 'Sentry: checkout 5xx group first seen', kind: 'symptom' },
    { ts: now - 3 * min, label: 'investigation started', kind: 'action' },
  ],
  suggestedFix:
    'Revert the timeout to 5s (or raise to ≥ p99 of settlement latency, ~2.5s) and re-deploy; longer-term, make the settle call async with a job + webhook so checkout latency stops depending on settlement.',
  unexplored: ['retry amplification during the incident window (suspected, not measured)'],
}

const INVESTIGATIONS: Investigation[] = [
  {
    id: 'INV-051',
    title: 'Checkout 5xx spike on payments-api',
    service: 'payments-api',
    status: 'investigating',
    stage: 'investigate',
    confidence: 'probable',
    source: 'sentry',
    ticketRef: 'ENG-1284',
    createdAt: now - 4 * min,
    similarTo: [{ id: 'INV-042', note: 'timeout regression in settle client' }],
  },
  {
    id: 'INV-050',
    title: 'Search latency p99 climbing after deploy',
    service: 'search-api',
    status: 'report',
    stage: 'report',
    confidence: 'confirmed',
    source: 'grafana',
    createdAt: now - 130 * min,
    report: REPORT_050,
  },
  {
    id: 'INV-049',
    title: 'auth-gateway OOMKilled during settlement batch',
    service: 'auth-gateway',
    status: 'closed',
    stage: 'report',
    confidence: 'confirmed',
    source: 'linear',
    ticketRef: 'ENG-1201',
    createdAt: now - 26 * 60 * min,
    closedAt: now - 24 * 60 * min,
    similarTo: [{ id: 'INV-042', note: 'memory limit' }],
  },
  {
    id: 'INV-048',
    title: 'Webhook delivery failures to billing provider',
    service: 'billing-worker',
    status: 'closed',
    stage: 'report',
    confidence: 'probable',
    source: 'linear',
    createdAt: now - 50 * 60 * min,
    closedAt: now - 48 * 60 * min,
  },
  {
    id: 'INV-047',
    title: 'Intermittent 502s from the ingress on prod',
    service: 'ingress-nginx',
    status: 'closed',
    stage: 'report',
    source: 'grafana',
    createdAt: now - 72 * 60 * min,
    closedAt: now - 71 * 60 * min,
  },
]

const MEMORY: MemoryRecord[] = [
  {
    id: 'mem-1',
    source: 'linear',
    ticketId: 'lin_abc042',
    identifier: 'ENG-1042',
    slackUrl: 'https://acme.slack.com/archives/C0REPORT/p1699',
    title: 'payments-api OOMKilled under settlement batch load',
    symptoms: 'payments-api pods OOMKilled during nightly settlement batch; checkout 500s; restarts every ~8m',
    rootCause: 'batch size regression in 9c2210b blew the heap — settle worker loaded full ledger into memory',
    resolution: 'Reverted 9c2210b, raised memory limit 1Gi → 2Gi as a stopgap, then paginated the ledger read',
    investigationSummary:
      'checked deploys → OOMKilled events in kubectl → heap profile pointed at ledger load → git blame settle worker → confirmed via memory metric inflection at deploy',
    resolutionSteps: [
      'kubectl get events -n prod | grep OOM',
      'compare deploy markers vs first OOM timestamp',
      'grep Loki for "settle" errors in the window',
      'git log --since=<window> -- services/settle/',
      'revert candidate commit; watch memory trend',
    ],
    errorSignature: 'OOMKilled:settle-worker',
    labels: ['payments', 'oom', 'batch'],
    priority: 'urgent',
    reportedAt: now - 40 * 24 * 60 * min,
    resolvedAt: now - 40 * 24 * 60 * min + 180 * min,
    updatedAt: now - 40 * 24 * 60 * min + 180 * min,
  },
  {
    id: 'mem-2',
    source: 'slack',
    slackUrl: 'https://acme.slack.com/archives/C0REPORT/p1702',
    title: 'Search p95 spikes when reindexer runs',
    symptoms: 'search latency doubles 02:00–02:20 daily; correlates with reindex cron; no errors, just slow',
    rootCause: 'reindexer saturated OpenSearch bulk queue; search threads starved',
    resolution: 'Throttled reindex bulk size and moved cron to 04:30 low-traffic window',
    investigationSummary: 'correlated latency window with cron schedule → bulk queue metrics → throttle test confirmed',
    resolutionSteps: ['overlay cron schedule on latency graph', 'check thread_pool.bulk queue metric', 'halve bulk size, re-measure'],
    labels: ['search', 'latency', 'cron'],
    reportedAt: now - 20 * 24 * 60 * min,
    resolvedAt: now - 19 * 24 * 60 * min,
    updatedAt: now - 19 * 24 * 60 * min,
  },
  {
    id: 'mem-3',
    source: 'linear',
    identifier: 'ENG-1101',
    title: 'Ingress 502s from keepalive mismatch',
    symptoms: 'intermittent 502 from ingress-nginx to payments-api, ~0.05%, worse under load',
    rootCause: 'upstream keepalive timeout (nginx 60s) longer than pod server idle timeout (30s) — races on reuse',
    resolution: 'Set nginx upstream keepalive_timeout 25s < server idleTimeout 30s',
    resolutionSteps: ['confirm 502 recv() failed pattern in ingress logs', 'compare keepalive timeouts both sides', 'align: proxy < upstream'],
    errorSignature: 'recv() failed (104: Connection reset by peer)',
    labels: ['ingress', '502', 'keepalive'],
    reportedAt: now - 60 * 24 * 60 * min,
    resolvedAt: now - 59 * 24 * 60 * min,
    updatedAt: now - 59 * 24 * 60 * min,
  },
]

const SERVICES: ServiceEntry[] = [
  {
    name: 'payments-api',
    repo: 'payments-service',
    namespace: 'prod',
    source: 'inferred',
    aliases: ['payments', 'pay-svc'],
    does: 'Checkout + settlement; owns the payments Postgres.',
    serving: 'Deployment, 4 replicas behind payments-api Service; ingress /api/pay',
    ids: { dashboard_uid: 'pay-main', loki_label: 'app=payments-api', tenant_key: 'KKC' },
    knownSolutions: [
      { symptom: 'OOMKilled under settlement batch load', fix: 'paginate ledger read / check batch size regression', ref: 'INV-042' },
    ],
  },
  {
    name: 'search-api',
    repo: 'search-api',
    namespace: 'prod',
    source: 'inferred',
    aliases: ['search'],
    does: 'Full-text + filtered search over cases and orders (OpenSearch).',
    serving: 'Deployment, 6 replicas; ingress /api/search',
    ids: { dashboard_uid: 'search-slo', loki_label: 'app=search-api' },
    knownSolutions: [{ symptom: 'p95 spikes during reindex', fix: 'throttle bulk + off-peak cron', ref: 'mem-2' }],
  },
  {
    name: 'auth-gateway',
    repo: 'auth-gateway',
    namespace: 'prod',
    source: 'manual',
    aliases: ['auth', 'gateway'],
    does: 'Session + JWT issuing; fronts Google SSO.',
    serving: 'Deployment, 3 replicas; ingress /auth',
    ids: { dashboard_uid: 'auth-ops', loki_label: 'app=auth-gateway' },
    knownSolutions: [],
  },
  {
    name: 'billing-worker',
    repo: 'billing',
    namespace: 'prod',
    source: 'inferred',
    aliases: ['billing'],
    does: 'Async invoicing + webhook delivery to the payment provider.',
    serving: 'Deployment (queue consumer), 2 replicas',
    ids: { loki_label: 'app=billing-worker' },
    knownSolutions: [],
  },
]

const CONNECTIONS: ConnectionInfo[] = [
  { id: 'grafana', name: 'Grafana', status: 'connected', detail: 'grafana.acme.internal · 12 services', requiredFirst: true },
  { id: 'linear', name: 'Linear', status: 'connected', detail: 'ENG · 1,204 issues' },
  { id: 'slack', name: 'Slack', status: 'connected', detail: '#reporting · synced 4m ago' },
  { id: 'sentry', name: 'Sentry', status: 'connected', detail: 'payments, auth, search' },
]

/* --------------------------------------------------- scripted live stream -- */

function script(id: string): AgentEvent[] {
  const t = Date.now()
  return [
    { kind: 'status', text: `session started · claude code · read-only · ${id}`, ts: t },
    { kind: 'stage', stage: 'investigate', ts: t },
    { kind: 'reasoning', text: 'Anchoring to symptom onset. Sentry first-seen for the 5xx group is 14:21:04Z — querying Grafana around onset, not "last hour".', ts: t },
    { kind: 'tool_call', id: 'tc-1', tool: 'grafana.query_prometheus', title: 'Error rate around onset', args: { query: 'sum(rate(http_requests_total{app="payments-api",code=~"5.."}[1m]))', from: '14:10', to: '14:35' }, ts: t },
    { kind: 'tool_result', id: 'tc-1', ok: true, summary: '0.2% → 8.4% step at 14:21:10', ts: t },
    { kind: 'evidence', evidence: EVIDENCE[0], ts: t },
    { kind: 'reasoning', text: 'Step change, not a ramp — consistent with a deploy or config flip. Checking what changed in the window.', ts: t },
    { kind: 'tool_call', id: 'tc-2', tool: 'kubectl', title: 'Rollout history in the window', args: { cmd: 'kubectl rollout history deploy/payments-api -n prod' }, ts: t },
    { kind: 'tool_result', id: 'tc-2', ok: true, summary: 'rev 214 deployed 14:19:04Z — 2m before onset', ts: t },
    { kind: 'evidence', evidence: EVIDENCE[2], ts: t },
    { kind: 'finding', text: 'Deploy boundary 2 minutes before symptom onset — strong prior (runbook Section 2).', ts: t },
    { kind: 'tool_call', id: 'tc-3', tool: 'grafana.query_loki', title: 'Error logs at onset', args: { query: '{app="payments-api"} |= "error" | json', window: '14:19–14:30' }, ts: t },
    { kind: 'tool_result', id: 'tc-3', ok: true, summary: '96% of errors: "settle: context deadline exceeded" from settlement client', ts: t },
    { kind: 'evidence', evidence: EVIDENCE[1], ts: t },
    { kind: 'reasoning', text: 'Timeouts, not 5xx from the upstream itself — smells like a client-side timeout change. Reading the deploy diff for the settle client.', ts: t },
    { kind: 'tool_call', id: 'tc-4', tool: 'git', title: 'Diff the deployed revision', args: { cmd: 'git log -p 214^..214 -- src/clients/settlement.ts', repo: 'payments-service' }, ts: t },
    { kind: 'tool_result', id: 'tc-4', ok: true, summary: 'a41f9c2 cuts settle client timeout 5s → 500ms', detail: '- timeout: 5_000,\n+ timeout: 500,   // "make checkout snappier"', ts: t },
    { kind: 'evidence', evidence: EVIDENCE[3], ts: t },
    { kind: 'finding', text: 'Settlement p95 is 1.2s — a 500ms client timeout guarantees deadline-exceeded under normal latency. Blame line + deploy window + log signature all align.', ts: t },
    { kind: 'reasoning', text: 'Verification: need a second independent signal (runbook Section 6). Settlement upstream latency unchanged through the window — the regression is purely client-side. Hypothesis reaches "probable"; will mark "confirmed" after checking retry amplification.', ts: t },
    { kind: 'stage', stage: 'report', ts: t },
    { kind: 'status', text: 'drafting evidence-linked report…', ts: t },
    { kind: 'done', ts: t },
  ]
}

/* ------------------------------------------------------------------ mock -- */

export class MockApi implements MeshApi {
  readonly isElectron = false

  private investigations = [...INVESTIGATIONS]
  private services = [...SERVICES]
  private memory = [...MEMORY]
  private settings: SettingsState = { theme: 'dark', provider: 'claude', permissionMode: 'default', syncIntervalMin: 30, autoSync: true, repoRoot: '~/mesh/repos' }

  private agentSubs = new Map<string, Set<(e: AgentEvent) => void>>()
  private played = new Map<string, AgentEvent[]>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private approvalSubs = new Set<(r: ApprovalRequest) => void>()
  private syncSubs = new Set<(e: SyncProgressEvent) => void>()
  private modelSubs = new Set<(s: ModelStatus) => void>()

  async listInvestigations() {
    return [...this.investigations]
  }

  async getInvestigation(id: string) {
    return this.investigations.find((i) => i.id === id) ?? null
  }

  async startInvestigation(input: IntakeInput) {
    const id = `INV-${52 + this.investigations.filter((i) => i.id.startsWith('INV-0')).length}`
    this.investigations.unshift({
      id,
      title: input.title || input.ticketRef || 'Pasted alert',
      status: 'investigating',
      stage: 'intake',
      source: input.ticketRef ? 'linear' : 'manual',
      ticketRef: input.ticketRef,
      createdAt: Date.now(),
      similarTo: [{ id: 'INV-042', note: 'similar symptoms in memory' }],
    })
    return { id }
  }

  async getTimeline(id: string) {
    return this.played.get(id) ?? []
  }

  onEngineState() {
    return () => {} // mock investigations transition via the scripted stream instead
  }

  onAgentEvent(id: string, cb: (e: AgentEvent) => void) {
    let subs = this.agentSubs.get(id)
    if (!subs) {
      subs = new Set()
      this.agentSubs.set(id, subs)
    }
    subs.add(cb)
    // First subscriber for a live investigation kicks off the scripted replay.
    if (!this.played.has(id)) {
      this.played.set(id, [])
      const events = script(id)
      events.forEach((e, i) => {
        const timer = setTimeout(() => {
          const stamped = { ...e, ts: Date.now() } as AgentEvent
          this.played.get(id)!.push(stamped)
          this.agentSubs.get(id)?.forEach((fn) => fn(stamped))
          // Script finished → the investigation gains its report (as the real
          // engine does on the REPORT stage).
          if (e.kind === 'done') {
            const inv = this.investigations.find((x) => x.id === id)
            if (inv && !inv.report) {
              inv.report = REPORT_051
              inv.status = 'report'
              inv.stage = 'report'
              inv.confidence = REPORT_051.confidence
            }
          }
        }, 900 * (i + 1))
        this.timers.add(timer)
      })
    }
    return () => subs!.delete(cb)
  }

  async steer(id: string, text: string) {
    const e: AgentEvent = { kind: 'steered', text, ts: Date.now() }
    this.played.get(id)?.push(e)
    this.agentSubs.get(id)?.forEach((fn) => fn(e))
    const ack: AgentEvent = { kind: 'reasoning', text: `Steering acknowledged — ${text.slice(0, 80)}. Adjusting the next step.`, ts: Date.now() + 1 }
    const timer = setTimeout(() => {
      this.played.get(id)?.push(ack)
      this.agentSubs.get(id)?.forEach((fn) => fn(ack))
    }, 700)
    this.timers.add(timer)
  }

  async comment(id: string, text: string) {
    await this.steer(id, `[feedback] ${text}`)
  }

  async interrupt(id: string) {
    const e: AgentEvent = { kind: 'status', text: 'interrupted by user', ts: Date.now() }
    this.played.get(id)?.push(e)
    this.agentSubs.get(id)?.forEach((fn) => fn(e))
  }

  async abandon(id: string) {
    const inv = this.investigations.find((i) => i.id === id)
    if (inv) inv.status = 'abandoned'
  }

  /* gated actions — both must raise an approval request */
  async postReportToLinear(id: string) {
    this.raiseApproval({
      id: `ap-${Date.now()}`,
      investigationId: id,
      tool: 'linear.create_comment',
      title: 'Post report to Linear',
      description: `Post the root-cause report for ${id} as a comment on the linked ticket.`,
      payloadPreview: 'ENG-1284 · comment · ~1.2k chars\n"Root cause (confirmed): timeout cut 5s→500ms in a41f9c2 …"',
      requestedAt: Date.now(),
      expiresAt: Date.now() + 10 * min,
    })
  }

  async openFixSession(id: string) {
    this.raiseApproval({
      id: `ap-${Date.now()}`,
      investigationId: id,
      tool: 'provider.fix_session',
      title: 'Open fix session',
      description: 'Open a write-enabled Claude Code session in the culprit repo, seeded with this investigation.',
      payloadPreview: 'repo: payments-service\nbranch: fix/settle-timeout (new)\ncontext: full report + evidence chain',
      requestedAt: Date.now(),
      expiresAt: Date.now() + 10 * min,
    })
  }

  private raiseApproval(r: ApprovalRequest) {
    this.approvalSubs.forEach((fn) => fn(r))
  }

  /* memory */
  async searchMemory(query: string): Promise<MemorySearchResult> {
    const q = query.toLowerCase().trim()
    if (!q) return { hits: [], semantic: false }
    const terms = q.split(/\s+/)
    const hits = this.memory
      .map((record) => {
        const hay = `${record.title} ${record.symptoms} ${record.rootCause ?? ''} ${record.labels.join(' ')}`.toLowerCase()
        const matched = terms.filter((t) => hay.includes(t)).length
        return { record, score: matched / terms.length, matched: 'lexical' as const }
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
    return { hits, semantic: false }
  }

  async syncStates(): Promise<SyncSourceState[]> {
    return [
      { source: 'linear', lastRunAt: now - 4 * min, cursor: '2026-07-06T10:58:00Z', status: 'idle' },
      { source: 'slack:#reporting', lastRunAt: now - 4 * min, cursor: '1751790000.000100', status: 'idle' },
      { source: 'repos', lastRunAt: now - 12 * min, status: 'idle', message: '182 checkouts fresh' },
    ]
  }

  async refresh(sources?: string[]) {
    const runId = `run-${Date.now()}`
    const src = sources?.length ? sources : ['linear', 'slack:#reporting']
    src.forEach((source, si) => {
      const phases: SyncProgressEvent['phase'][] = ['fetch', 'link', 'distill', 'upsert', 'done']
      phases.forEach((phase, pi) => {
        const timer = setTimeout(() => {
          this.syncSubs.forEach((fn) =>
            fn({ runId, source, phase, done: phase === 'done' ? 12 : pi * 3, total: 12, message: phase === 'done' ? 'up to date' : undefined }),
          )
        }, 600 * (si * phases.length + pi + 1))
        this.timers.add(timer)
      })
    })
    return { runId }
  }

  onSyncProgress(cb: (e: SyncProgressEvent) => void) {
    this.syncSubs.add(cb)
    return () => this.syncSubs.delete(cb)
  }

  onModelStatus(cb: (s: ModelStatus) => void) {
    this.modelSubs.add(cb)
    cb({ state: 'unavailable', message: 'semantic search runs in the desktop app' })
    return () => this.modelSubs.delete(cb)
  }

  /* registry */
  async listServices() {
    return [...this.services]
  }

  async discoverServices() {
    return { instances: [{ name: 'prod', services: 12 }], discovered: 12, matchedToRepos: 9, upserted: 12 }
  }

  async saveService(entry: ServiceEntry) {
    const i = this.services.findIndex((s) => s.name === entry.name)
    if (i >= 0) this.services[i] = { ...entry, source: 'manual' }
    else this.services.push(entry)
  }

  /* connections */
  async listConnections() {
    return [...CONNECTIONS]
  }

  async setSecret(id: SourceId, _fields: Record<string, string>) {
    const c = CONNECTIONS.find((c) => c.id === id)
    if (c) {
      c.status = 'connected'
      c.detail = 'validated just now'
    }
    return { ok: true }
  }

  async grafanaInstances() {
    return [
      { name: 'prod', url: 'https://grafana.acme.internal', hasToken: true },
      { name: 'azure', url: 'https://grafana-azure.acme.internal', hasToken: true },
    ]
  }
  async removeGrafanaInstance(_name: string) {}

  async listSlackChannels(token: string) {
    if (!token.trim()) return { ok: false as const, message: 'no token provided' }
    return {
      ok: true as const,
      channels: [
        { id: 'C001', name: 'reporting-prod', isMember: true },
        { id: 'C002', name: 'incidents', isMember: true },
        { id: 'C003', name: 'postmortems', isMember: false },
        { id: 'C004', name: 'random', isMember: true },
      ],
    }
  }

  private learnings = [
    { id: 1, investigationId: 'INV-050', text: 'Search latency issues: check the OpenSearch slowlog via {app="opensearch"} |= "slowlog" before anything else', status: 'proposed' as const, createdAt: now - 60 * min },
    { id: 2, investigationId: 'INV-049', text: 'OOM investigations: memory limits live in acme-charts, not the service repos', status: 'accepted' as const, createdAt: now - 26 * 60 * min },
  ]
  async listLearnings(status?: 'proposed' | 'accepted' | 'rejected') {
    return status ? this.learnings.filter((l) => l.status === status) : [...this.learnings]
  }
  async decideLearning(id: number, accept: boolean) {
    const l = this.learnings.find((x) => x.id === id)
    if (l) l.status = accept ? 'accepted' : ('rejected' as never)
  }

  /* approvals */
  onApprovalRequest(cb: (r: ApprovalRequest) => void) {
    this.approvalSubs.add(cb)
    return () => this.approvalSubs.delete(cb)
  }

  async respondApproval(_id: string, _approved: boolean) {
    // mock: nothing blocks on it; the modal closing is the whole story
  }

  /* system knowledge map — same seed as the real app */
  private mapNodes: import('@shared/types').MapNode[] = [
    { id: 'acme-showcase', label: 'Showcase (frontend)', kind: 'frontend', repo: 'acme-showcase', grafana: 'prod' },
    { id: 'acme-party', label: 'PartyKit (docs realtime)', kind: 'edge', repo: 'acme-party', grafana: 'prod' },
    { id: 'cryptic', label: 'Cryptic', kind: 'backend', repo: 'cryptic', grafana: 'prod' },
    { id: 'dashboard-service', label: 'Dashboard Service', kind: 'backend', repo: 'dashboard-service', grafana: 'prod', notes: 'the core backend' },
    { id: 'caseflow-service', label: 'Caseflow Service', kind: 'backend', repo: 'caseflow-service', grafana: 'prod' },
    { id: 'speech-orchestrator', label: 'Speech Orchestrator', kind: 'backend', repo: 'speech-orchestrator', grafana: 'azure', notes: 'single replica' },
    { id: 'data-autonomy', label: 'Data Autonomy', kind: 'backend', repo: 'data-autonomy', grafana: 'azure' },
    { id: 'cmd-vad', label: 'CMD VAD', kind: 'ml', repo: 'cmd-vad', grafana: 'azure' },
    { id: 'cmd-batch-asr', label: 'CMD Batch ASR', kind: 'ml', repo: 'cmd-batch-asr', grafana: 'azure', notes: 'GPU bottleneck' },
    { id: 'itn-service', label: 'ITN Service', kind: 'ml', repo: 'itn-service', grafana: 'azure' },
    { id: 'document-translate', label: 'Document Translate', kind: 'ml', repo: 'document-translate', grafana: 'azure' },
    { id: 'legal-lens', label: 'Legal Lens', kind: 'ml', repo: 'legal-lens', grafana: 'azure' },
    { id: 'azure-google-stt', label: 'Azure / Google STT', kind: 'external' },
    { id: 'postgres', label: 'Postgres', kind: 'datastore' },
    { id: 'acme-charts', label: 'Acme Charts (Helm)', kind: 'infra', repo: 'acme-charts' },
  ]
  private mapEdges: import('@shared/types').MapEdge[] = (
    [
      ['acme-showcase', 'acme-party', 'docs realtime (Yjs)', 'ws'],
      ['acme-party', 'cryptic', 'doc persistence', 'http'],
      ['cryptic', 'dashboard-service', 'doc CRUD', 'http'],
      ['acme-showcase', 'dashboard-service', 'GraphQL: updateNode…', 'graphql'],
      ['dashboard-service', 'caseflow-service', 'case flows', 'http'],
      ['dashboard-service', 'postgres', 'owns schema', 'db'],
      ['acme-showcase', 'speech-orchestrator', 'ws: all dictation modes', 'ws'],
      ['acme-showcase', 'data-autonomy', 'duplicate audio', 'http'],
      ['speech-orchestrator', 'cmd-vad', 'audio segments', 'http'],
      ['speech-orchestrator', 'cmd-batch-asr', 'batch/smart ASR', 'queue'],
      ['speech-orchestrator', 'azure-google-stt', 'live modes', 'ws'],
      ['speech-orchestrator', 'itn-service', 'normalize', 'http'],
      ['speech-orchestrator', 'document-translate', 'translation', 'http'],
      ['speech-orchestrator', 'legal-lens', 'legal NLP', 'http'],
      ['speech-orchestrator', 'dashboard-service', 'media status events', 'http'],
    ] as [string, string, string, string][]
  )
    .map(([from, to, label, kind], i) => ({ id: i + 1, from, to, label, kind: kind as never, status: 'accepted' as 'accepted' | 'proposed' }))
    .concat([{ id: 99, from: 'acme-showcase', to: 'caseflow-service', label: 'direct case query — found by INV-014', kind: 'graphql' as never, status: 'proposed' }])

  async getMap() {
    return { nodes: [...this.mapNodes], edges: [...this.mapEdges] }
  }
  async saveMapNode(node: import('@shared/types').MapNode) {
    const i = this.mapNodes.findIndex((n) => n.id === node.id)
    if (i >= 0) this.mapNodes[i] = node
    else this.mapNodes.push(node)
  }
  async addMapEdge(from: string, to: string, label: string | undefined, kind: import('@shared/types').MapEdge['kind']) {
    this.mapEdges.push({ id: this.mapEdges.length + 1, from, to, label, kind, status: 'accepted' })
  }
  async decideMapEdge(id: number, accept: boolean) {
    const e = this.mapEdges.find((x) => x.id === id)
    if (!e) return
    if (accept) e.status = 'accepted'
    else this.mapEdges = this.mapEdges.filter((x) => x.id !== id)
  }
  async getContextSummary() {
    return {
      memory: { total: this.memory.length, bySource: { linear: 3, slack: 2, mesh: 1 }, embedded: this.memory.length - 1 },
      registry: { total: this.services.length, manual: 1 },
      map: {
        nodes: this.mapNodes.length,
        edges: this.mapEdges.filter((e) => e.status === 'accepted').length,
        proposed: this.mapEdges.filter((e) => e.status === 'proposed').length,
      },
      learnings: { accepted: this.learnings.filter((l) => l.status === 'accepted').length, proposed: this.learnings.filter((l) => l.status === 'proposed').length },
      mapPrompt: 'SYSTEM MAP (accepted topology — trust it):\n- acme-showcase → dashboard-service (graphql)\n- acme-showcase → speech-orchestrator (ws)\n- speech-orchestrator → cmd-batch-asr (http)',
      learningTexts: this.learnings.filter((l) => l.status === 'accepted').map((l) => l.text),
    }
  }

  async getK8sStatus() {
    // Mirrors a realistic machine: gcloud logged in but token lapsed, az fine.
    // GKE contexts delegate auth to the gcloud plugin (so they're blocked);
    // the AKS context carries embedded creds and keeps working.
    return {
      kubectl: true,
      gcloud: true,
      az: true,
      gcloudAuth: 'stale' as const,
      azAuth: 'ok' as const,
      contexts: [
        { name: 'gke-prod', provider: 'gcp' as const, needsCliLogin: true, execBin: 'gke-gcloud-auth-plugin' },
        { name: 'gke-staging', provider: 'gcp' as const, needsCliLogin: true, execBin: 'gke-gcloud-auth-plugin' },
        { name: 'aks-dictation', provider: 'azure' as const, needsCliLogin: false },
      ],
      contextsDegraded: false,
      mapped: [
        { service: 'payments-api', context: 'gke-prod', namespace: 'prod', contextExists: true },
        // a stale mapping left behind after a cluster rename — must be flagged
        { service: 'billing-worker', context: 'gke-old-prod', namespace: 'prod', contextExists: false },
      ],
      unmappedServices: ['search-api', 'auth-gateway'],
    }
  }

  async getClaudeAuth() {
    return { installed: true, loggedIn: false as boolean, authMethod: 'claude.ai', subscriptionType: 'max' }
  }

  // Browser dev has no real PTY, so simulate one well enough that the terminal
  // renders and can be designed against: a prompt, echoed keystrokes, and a
  // couple of canned command responses.
  private ptyListeners = new Set<(p: { id: string; chunk: string }) => void>()
  private ptyLine = ''
  private ptyBuf = ''

  private ptyPrompt = '\x1b[38;5;179majay\x1b[0m@\x1b[38;5;109mmesh\x1b[0m \x1b[38;5;245m~\x1b[0m %\u0020'

  private ptyEmit(chunk: string) {
    this.ptyBuf += chunk
    for (const cb of this.ptyListeners) cb({ id: 'mock-pty', chunk })
  }

  async ptySpawn(req: { command?: string }) {
    this.ptyBuf = ''
    setTimeout(() => {
      this.ptyEmit('Last login: today on ttys004\r\n')
      this.ptyEmit(this.ptyPrompt)
      // Browser dev only: replay a short realistic session so the terminal can
      // be designed against actual output rather than a bare prompt.
      if (req?.command) {
        setTimeout(() => this.ptyRun(req.command as string), 300)
      } else {
        setTimeout(() => this.ptyRun('kubectl config get-contexts -o name'), 220)
        setTimeout(() => this.ptyRun('ls'), 520)
        setTimeout(() => this.ptyRun('kubectl rollout status deploy/payments-api'), 820)
      }
    }, 60)
    return { id: 'mock-pty' }
  }

  private ptyRun(cmd: string) {
    this.ptyEmit(cmd + '\r\n')
    const c = cmd.trim()
    if (c.startsWith('gcloud auth login')) {
      this.ptyEmit('Your browser has been opened to visit:\r\n\r\n')
      this.ptyEmit('    \x1b[4mhttps://accounts.google.com/o/oauth2/auth?...\x1b[0m\r\n\r\n')
      setTimeout(() => {
        this.ptyEmit('\x1b[32m✓\x1b[0m You are now logged in as [ajay@adalat.ai].\r\n')
        this.ptyEmit(this.ptyPrompt)
      }, 900)
      return
    }
    if (c.startsWith('claude auth login')) {
      this.ptyEmit('Opening browser to sign in…\r\n')
      setTimeout(() => {
        this.ptyEmit('\x1b[32m✓\x1b[0m Signed in as ajay@adalat.ai (max)\r\n')
        this.ptyEmit(this.ptyPrompt)
      }, 900)
      return
    }
    if (c === 'kubectl config get-contexts -o name') {
      this.ptyEmit('adalatAI-staging-dictation-aks\r\naks-dictation\r\ngke-alpha\r\ngke-gpu\r\ngke-prod\r\n')
    } else if (c.startsWith('kubectl rollout status')) {
      this.ptyEmit('Waiting for deployment "payments-api" rollout to finish: 2 of 3 updated…\r\n')
      this.ptyEmit('\x1b[33mwarning:\x1b[0m 1 pod restarted (OOMKilled) in the last 5m\r\n')
      this.ptyEmit('deployment "payments-api" successfully rolled out\r\n')
    } else if (c === 'ls') {
      this.ptyEmit('\x1b[38;5;109mdist\x1b[0m  \x1b[38;5;109mnode_modules\x1b[0m  \x1b[38;5;109msrc\x1b[0m  package.json  README.md\r\n')
    } else if (c.length) {
      this.ptyEmit(`zsh: command not found: ${c.split(' ')[0]}\r\n`)
    }
    this.ptyEmit(this.ptyPrompt)
  }

  async ptyWrite(_id: string, data: string) {
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = this.ptyLine
        this.ptyLine = ''
        this.ptyEmit('\r\n')
        this.ptyRun(line)
      } else if (ch === '\u007f') {
        if (this.ptyLine) {
          this.ptyLine = this.ptyLine.slice(0, -1)
          this.ptyEmit('\b \b')
        }
      } else if (ch >= ' ') {
        this.ptyLine += ch
        this.ptyEmit(ch)
      }
    }
  }
  async ptyResize() {}
  async ptyKill() {
    this.ptyListeners.clear()
  }
  async ptyScrollback() {
    return this.ptyBuf
  }
  onPtyData(cb: (p: { id: string; chunk: string }) => void) {
    this.ptyListeners.add(cb)
    return () => this.ptyListeners.delete(cb)
  }
  onPtyExit() {
    return () => {}
  }

  async seedMapFromText(text: string) {
    if (!text.trim()) return { ok: false as const, message: 'paste a description first' }
    // simulate an extraction: two nodes + one edge appear on the map
    this.mapNodes.push(
      { id: 'demo-api', label: 'Demo API (from your text)', kind: 'backend' },
      { id: 'demo-db', label: 'Demo DB', kind: 'datastore' },
    )
    this.mapEdges.push({ id: this.mapEdges.length + 100, from: 'demo-api', to: 'demo-db', label: 'reads/writes', kind: 'db', status: 'accepted' })
    return { ok: true as const, nodes: 2, edges: 1 }
  }

  /* settings */
  async getSettings() {
    return { ...this.settings }
  }

  async setSettings(patch: Partial<SettingsState>) {
    this.settings = { ...this.settings, ...patch }
    return { ...this.settings }
  }

  /* workspace repos — browser mock: no native dialog, simulate the pick */
  async pickRepoRoot() {
    this.settings.repoRoot = '/Users/ajaykumar/Documents/GitHub'
    return { path: this.settings.repoRoot, repos: ['mesh-ai', 'payments-service', 'search-api', 'auth-gateway'] }
  }

  async scanRepos() {
    return { root: this.settings.repoRoot, repos: ['mesh-ai', 'payments-service', 'search-api', 'auth-gateway'] }
  }
}

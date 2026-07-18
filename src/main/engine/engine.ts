// The effectful investigation runner (Section 5): drives intake → scope → investigate
// → report, persists every event, streams to the renderer, saves the finished
// report into memory. One interactive session per investigation (v1).
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import type { AgentEvent, IntakeInput, Investigation, Report } from '../../shared/types'
import { investigationsRepo } from '../db/repos/investigations'
import { eventsRepo } from '../db/repos/events'
import { memoryRepo } from '../db/repos/memory'
import { servicesRepo } from '../db/repos/services'
import type { Provider, Session, StartOptions } from '../providers/types'
import type { ApprovalBroker } from '../ipc/approvals'
import type { SecretStore } from '../security/secrets'
import { searchMemory } from '../memory/search'
import { selectLearnings } from '../memory/learnings-select'
import type { Embeddings } from '../memory/embeddings'
import { settingsRepo } from '../db/repos/settings'
import { sessionsRepo } from '../db/repos/sessions'
import { learningsRepo } from '../db/repos/learnings'
import { mapRepo } from '../db/repos/map'
import { expandHome, scanGitRepos } from '../repos/workspace'
import { findIssueIdByIdentifier, postLinearComment } from '../sync/linear'
import { runIntake } from './intake'
import { buildMemoryMcp } from './memory-tools'
import { buildSystemPrompt } from './runbook'
import { formatReportComment } from './report-format'
import { extractReport } from './report-schema'
import { extractSignature } from '../memory/signature'
import { log } from '../log'

const l = log('engine')

export interface EngineDeps {
  db: Database
  vecAvailable: boolean
  embeddings: Embeddings | null
  provider: () => Provider
  approvals: ApprovalBroker
  secrets: SecretStore
  emitAgentEvent: (investigationId: string, e: AgentEvent) => void
  emitState: (investigationId: string, stage: Investigation['stage'], status: Investigation['status']) => void
}

export class Engine {
  private sessions = new Map<string, Session>()
  /** accumulated assistant text per investigation — the report is parsed from it */
  private transcripts = new Map<string, string>()
  /** prompts kept for the wedge-retry path */
  private prompts = new Map<string, { system: string; initial: string }>()
  /** investigations whose session died on the duplicate-tool_use SDK glitch */
  private wedged = new Set<string>()
  private retried = new Set<string>()
  /** current sessions-ledger row per investigation — every event is tagged with it */
  private sessionRows = new Map<string, number>()
  /** in-flight memory tool calls (tool_use id → call info) — paired with their
   *  results so mid-run memory lookups surface in the evidence rail */
  private memoryCalls = new Map<string, { tool: string; args: Record<string, unknown> }>()

  constructor(private deps: EngineDeps) {}

  async start(input: IntakeInput): Promise<{ id: string }> {
    const { db } = this.deps
    const invs = investigationsRepo(db)
    const events = eventsRepo(db)
    const services = servicesRepo(db)
    const provider = this.deps.provider()

    const id = invs.nextId()

    // — Stage 1 · Intake
    // If the ticket is already ingested (ENG-2903 …), pull its content from
    // memory — the agent must NEVER need to fetch linear.app (auth-walled SPA).
    const memory = memoryRepo(db)
    const ticketMatch = input.ticketRef?.match(/\b([A-Z]{2,6}-\d+)\b/i)
    const ticketRecord = ticketMatch ? memory.byIdentifier(ticketMatch[1]) : null

    const intake = await runIntake(input, provider)
    if (ticketRecord) {
      intake.title = ticketRecord.title
      intake.symptoms = [ticketRecord.symptoms, intake.symptoms].filter(Boolean).join('\n')
    }
    const similar = await searchMemory(db, this.deps.vecAvailable, this.deps.embeddings, intake.symptoms)
    // The ticket under investigation is itself in memory — drop the self-match
    // so it can't eat a similar-incident slot (its full content is injected
    // separately below).
    const selfId = ticketMatch?.[1]?.toUpperCase()
    const similarHits = similar.hits.filter((h) => !selfId || (h.record.identifier ?? '').toUpperCase() !== selfId)

    // — Stage 2 · Scope (v1-lite: auto-resolve mentions via the registry)
    const resolved = intake.serviceMentions
      .map((m) => services.resolveMention(m))
      .filter((s): s is NonNullable<typeof s> => s !== null)
    const uniqueServices = [...new Map(resolved.map((s) => [s.name, s])).values()]

    invs.create({
      id,
      title: intake.title,
      service: uniqueServices[0]?.name,
      status: 'investigating',
      stage: 'intake',
      source: input.ticketRef ? 'linear' : 'manual',
      ticketRef: input.ticketRef,
      createdAt: Date.now(),
      similarTo: similarHits.slice(0, 3).map((h) => ({ id: h.record.identifier ?? h.record.id, note: h.record.title.slice(0, 60) })),
    })
    events.append(id, 'intake.parsed', intake)
    // Memory retrieval is the first step of every investigation — make it
    // visible on the timeline and auditable in events (which retrievers ran,
    // what matched, what got injected).
    events.append(id, 'intake.similar', {
      semantic: similar.semantic,
      hits: similarHits.slice(0, 5).map((h) => ({ id: h.record.identifier ?? h.record.id, title: h.record.title, matched: h.matched })),
    })
    this.push(id, {
      kind: 'status',
      text: similarHits.length
        ? `memory search (${similar.semantic ? 'vector + lexical' : 'lexical only — embeddings not ready'}) · ${similarHits.length} similar past incident(s) · injecting: ${similarHits
            .slice(0, 3)
            .map((h) => h.record.identifier ?? h.record.id)
            .join(', ')}`
        : `memory search (${similar.semantic ? 'vector + lexical' : 'lexical only — embeddings not ready'}) · no similar past incidents`,
      ts: Date.now(),
    })

    // The matches themselves land in the evidence rail — "we've seen this
    // before" is a sourced claim, and the user should see memory contributing.
    similarHits.slice(0, 3).forEach((h, i) => {
      const ref = h.record.identifier ?? h.record.id
      this.push(id, {
        kind: 'evidence',
        evidence: {
          id: `mem-intake-${i + 1}`,
          type: 'memory',
          claim: `similar past incident: ${ref} — ${h.record.title.slice(0, 80)}`,
          source: `memory:${ref} · matched by ${h.matched} search`,
          snippet: h.record.rootCause ? `root cause then: ${h.record.rootCause.slice(0, 180)}` : undefined,
          ts: Date.now(),
        },
        ts: Date.now(),
      })
    })

    this.push(id, { kind: 'status', text: `intake parsed · ${uniqueServices.length} candidate service(s)`, ts: Date.now() })
    this.setStage(id, 'scope')
    events.append(id, 'scope.resolved', { services: uniqueServices.map((s) => s.name) })

    // — Stage 3 · Investigate — the session works INSIDE the user's repo
    // folder (read-only): git log/blame/show + rg across every clone (Section 6.1).
    const repoRoot = expandHome(settingsRepo(db).get().repoRoot)
    const repoNames = scanGitRepos(repoRoot)
    // user-approved learned context: relevance-selected for these symptoms
    // (small libraries inject whole; large ones retrieve top-K + newest)
    const learned = await selectLearnings(db, this.deps.vecAvailable, this.deps.embeddings, intake.symptoms)
    let systemPrompt = buildSystemPrompt(uniqueServices, similarHits, intake.timeWindow, learned)
    // the org's topology rides in every session — the agent starts knowing the flows
    systemPrompt += `\n\n${mapRepo(db).promptText()}`
    if (repoNames.length > 0) {
      systemPrompt += `\n\nREPOS AVAILABLE (read-only checkouts, cwd = ${repoRoot}):\n${repoNames.map((r) => `- ${r}/`).join('\n')}\nUse git log/blame/show and rg inside these to correlate symptoms to commits and name the exact file:line.`
    } else {
      systemPrompt += `\n\nNOTE: no repos found under ${repoRoot} — code-level pinpointing is degraded; say so in the report.`
    }

    // Ticket content travels IN the prompt — linear.app cannot be fetched
    // (auth-walled SPA), and the ingested record already has everything.
    if (ticketRecord) {
      const comments = ticketRecord.rawCommentsJson ? boundedComments(ticketRecord.rawCommentsJson) : ''
      systemPrompt += `\n\nTHE TICKET UNDER INVESTIGATION (${ticketRecord.identifier} — full content, already fetched; do NOT WebFetch linear.app):\ntitle: ${ticketRecord.title}\nsymptoms: ${ticketRecord.symptoms}${ticketRecord.labels.length ? `\nlabels: ${ticketRecord.labels.join(', ')}` : ''}${comments ? `\n--- discussion so far ---\n${comments}` : ''}`
    }
    this.setStage(id, 'investigate')
    const initialPrompt = [
      `Investigate this incident. ${intake.timeWindow ? `Onset window: ${intake.timeWindow}.` : ''}`,
      `Symptoms: ${intake.symptoms}`,
      input.ticketRef ? `Ticket: ${input.ticketRef}` : '',
      `When done, end with the \`\`\`mesh-report block.`,
    ]
      .filter(Boolean)
      .join('\n')

    this.prompts.set(id, { system: systemPrompt, initial: initialPrompt })
    this.spawnSession(id, invs.getSessionId(id) ?? undefined)

    return { id }
  }

  /** Spawn (or respawn) the provider session for an investigation. */
  private spawnSession(id: string, resumeSessionId?: string): void {
    const provider = this.deps.provider()
    const invs = investigationsRepo(this.deps.db)
    const p = this.prompts.get(id)
    if (!p) return
    const settings = settingsRepo(this.deps.db).get()
    const repoRoot = expandHome(settings.repoRoot)

    // sessions ledger: one row per spawn (a wedge-retry = a new row)
    const sessionRow = sessionsRepo(this.deps.db).start(id, provider.id, settings.model, settings.effort, settings.permissionMode)
    this.sessionRows.set(id, sessionRow)

    // Org memory rides in as in-process tools — the intake similar-incidents
    // block is a one-shot snapshot; these let the agent re-query mid-session
    // as it extracts better signatures. Self-matches are filtered out.
    const mcpServers: StartOptions['mcpServers'] = {}
    const selfRef = invs.get(id)?.ticketRef?.match(/\b([A-Za-z]{2,6}-\d+)\b/)?.[1]
    mcpServers.memory = buildMemoryMcp(this.deps.db, this.deps.vecAvailable, this.deps.embeddings, selfRef)

    // Sentry rides in as an MCP server when a token is connected — the agent
    // gets live issue/event/trace query tools, scoped by the user's own token.
    const sentryToken = this.deps.secrets.get('sentry.token')
    if (sentryToken) {
      mcpServers.sentry = {
        command: 'npx',
        args: ['-y', '@sentry/mcp-server@latest', `--access-token=${sentryToken}`],
      }
    }

    this.transcripts.set(id, '')
    const session = provider.start({
      cwd: repoRoot,
      systemPrompt: p.system + (sentryToken ? '\n\nSENTRY: live Sentry tools are available (mcp: sentry) — use them for issue details, events, stack traces, and firstSeen/release data.' : ''),
      initialPrompt: p.initial,
      model: settings.model || undefined,
      effort: settings.effort,
      permissionMode: settings.permissionMode,
      resumeSessionId,
      mcpServers: Object.keys(mcpServers).length ? mcpServers : undefined,
      onEvent: (e) => this.onAgentEvent(id, e),
      requestApproval: async (tool, title, description, payloadPreview) => {
        const d = await this.deps.approvals.request({ investigationId: id, tool, title, description, payloadPreview })
        return d.approved
      },
    })
    this.sessions.set(id, session)

    void session.finished.then(() => {
      const sid = session.sessionId
      if (sid) {
        invs.setSessionId(id, sid)
        const row = this.sessionRows.get(id)
        if (row) sessionsRepo(this.deps.db).setNativeId(row, sid)
      }
      this.finalize(id)
    })
  }

  steer(id: string, text: string): void {
    this.push(id, { kind: 'steered', text, ts: Date.now() })
    this.sessions.get(id)?.send(text)
  }

  /** Post-report feedback: resume the finished session with the user's
   *  verdict/correction. The agent responds in the timeline and may emit a
   *  REVISED mesh-report — which flows through finalize like any report. */
  comment(id: string, text: string): void {
    const live = this.sessions.get(id)
    if (live) {
      // still running — feedback is just steering
      this.steer(id, text)
      return
    }

    const invs = investigationsRepo(this.deps.db)
    const inv = invs.get(id)
    if (!inv) return
    const nativeId = invs.getSessionId(id) ?? undefined

    const feedbackPrompt = [
      `USER FEEDBACK on your investigation report for ${id}:`,
      `"${text}"`,
      '',
      'Respond honestly. If this feedback changes your conclusion, re-investigate the',
      'specific point (read-only tools as before) and output a REVISED ```mesh-report',
      'block (full schema — hypothesis, suspects, evidence, learnings). If you stand by',
      'the report, explain why in 2-3 sentences, citing the evidence — do not output a',
      'new report block. If the feedback contains a reusable operational lesson, include',
      'it in the learnings of your revised report.',
      // no native session to resume → give the agent its old report as context
      !nativeId && inv.report ? `\nYOUR ORIGINAL REPORT:\n${JSON.stringify(inv.report, null, 2)}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    // keep/rebuild prompts for the spawn (original entry may be gone after finalize)
    const existing = this.prompts.get(id)
    this.prompts.set(id, {
      system: existing?.system ?? buildSystemPrompt([], [], undefined, learningsRepo(this.deps.db).acceptedTexts()),
      initial: feedbackPrompt,
    })
    this.retried.delete(id) // feedback turn gets its own wedge-retry budget

    this.push(id, { kind: 'steered', text, ts: Date.now() })
    invs.setStatus(id, 'investigating')
    this.deps.emitState(id, 'investigate', 'investigating')
    this.spawnSession(id, nativeId)
  }

  interrupt(id: string): void {
    this.sessions.get(id)?.interrupt()
    this.push(id, { kind: 'status', text: 'interrupted by user', ts: Date.now() })
  }

  abandon(id: string): void {
    const session = this.sessions.get(id)
    session?.interrupt()
    this.sessions.delete(id)
    const row = this.sessionRows.get(id)
    if (row) sessionsRepo(this.deps.db).end(row, 'abandoned', session?.usage)
    investigationsRepo(this.deps.db).setStatus(id, 'abandoned', Date.now())
    this.deps.emitState(id, 'report', 'abandoned')
  }

  /** window closed / app quitting — kill sessions so nothing dangles */
  shutdown(): void {
    for (const s of this.sessions.values()) s.interrupt()
    this.sessions.clear()
  }

  /* ------------------------------------------------------------ gated actions */

  async postReport(id: string): Promise<void> {
    const inv = investigationsRepo(this.deps.db).get(id)
    if (!inv?.report) return

    const body = formatReportComment(inv, inv.report)
    const d = await this.deps.approvals.request({
      investigationId: id,
      tool: 'linear.create_comment',
      title: 'Post report to Linear',
      description: `Post the root-cause report for ${id} as a comment on ${inv.ticketRef ?? 'the linked ticket'}.`,
      payloadPreview: body.slice(0, 1200),
    })
    if (!d.approved) return
    eventsRepo(this.deps.db).append(id, 'report.post.approved', { at: Date.now() })

    // The real write — only ever reached through the gate above (Section 10).
    try {
      const apiKey = this.deps.secrets.get('linear.apiKey')
      if (!apiKey) throw new Error('Linear is not connected')
      const identifier = inv.ticketRef?.match(/\b([A-Za-z]{2,6}-\d+)\b/)?.[1]
      if (!identifier) throw new Error(`no ticket reference on ${id}`)

      // fastest path: the ingested record already holds the issue UUID
      const memId = memoryRepo(this.deps.db).byIdentifier(identifier)?.ticketId
      const issueId = memId ?? (await findIssueIdByIdentifier(apiKey, identifier))
      if (!issueId) throw new Error(`could not resolve ${identifier} to a Linear issue`)

      await postLinearComment(apiKey, issueId, body)
      eventsRepo(this.deps.db).append(id, 'report.posted', { identifier, issueId })
      this.push(id, { kind: 'status', text: `report posted to ${identifier} ✓`, ts: Date.now() })
    } catch (e) {
      this.push(id, { kind: 'error', text: `post to Linear failed: ${(e as Error).message}`, ts: Date.now() })
    }
  }

  async openFixSession(id: string): Promise<void> {
    const inv = investigationsRepo(this.deps.db).get(id)
    const culprit = inv?.report?.culprit
    const d = await this.deps.approvals.request({
      investigationId: id,
      tool: 'provider.fix_session',
      title: 'Open fix session',
      description:
        'Open YOUR Claude Code in a Terminal at the culprit repo, on a new fix branch, seeded with the full investigation. You drive it; Mesh steps back.',
      payloadPreview: culprit
        ? `repo: ${culprit.repo}\nbranch: fix/${id.toLowerCase()} (new)\nseed: ${culprit.repo}/.mesh/FIX-${id}.md — report + evidence chain`
        : '(no culprit identified)',
    })
    if (!d.approved) return
    eventsRepo(this.deps.db).append(id, 'fix_session.approved', { culprit })

    try {
      if (!inv?.report) throw new Error('no report to seed from')
      if (!culprit) throw new Error('no culprit repo identified')
      const repoPath = join(expandHome(settingsRepo(this.deps.db).get().repoRoot), culprit.repo)
      if (!existsSync(repoPath)) throw new Error(`repo not found locally: ${culprit.repo}`)

      // 1 · seed file — the investigation travels with the repo
      const seedDir = join(repoPath, '.mesh')
      mkdirSync(seedDir, { recursive: true })
      const seedPath = join(seedDir, `FIX-${id}.md`)
      const seed = [
        `# Fix handoff · ${id} — ${inv.title}`,
        '',
        formatReportComment(inv, inv.report),
        '',
        '## Your task',
        `1. Create a branch: \`git checkout -b fix/${id.toLowerCase()}\``,
        `2. Implement the suggested fix (culprit: \`${culprit.path}\`). Verify against the evidence above.`,
        '3. Run the tests. Do NOT push — the human reviews and pushes.',
      ].join('\n')
      writeFileSync(seedPath, seed)

      // 2 · hand off to the user's own Claude Code in a real terminal
      const prompt = `Read .mesh/FIX-${id}.md and do what it says — implement the fix on a new branch. Do not push.`
      const script = `tell application "Terminal"
  activate
  do script "cd ${repoPath.replace(/"/g, '\\"')} && claude ${JSON.stringify(prompt)}"
end tell`
      execFile('osascript', ['-e', script], (err) => {
        if (err) {
          this.push(id, { kind: 'error', text: `could not open Terminal: ${err.message} — seed written to ${seedPath}`, ts: Date.now() })
        }
      })

      eventsRepo(this.deps.db).append(id, 'fix_session.opened', { repo: culprit.repo, seedPath })
      this.push(id, { kind: 'status', text: `fix session opened → Terminal · ${culprit.repo} · seeded from .mesh/FIX-${id}.md`, ts: Date.now() })
    } catch (e) {
      this.push(id, { kind: 'error', text: `fix session failed: ${(e as Error).message}`, ts: Date.now() })
    }
  }

  /* ----------------------------------------------------------------- internal */

  private onAgentEvent(id: string, e: AgentEvent): void {
    if (e.kind === 'error' && /tool_use[\s\S]*must be unique/i.test(e.text)) {
      this.wedged.add(id) // SDK transcript-corruption glitch — retried in finalize
    }
    // Mid-run memory lookups → evidence rail. Deterministic pairing: remember
    // the call, and when its result lands, extract what memory contributed.
    if (e.kind === 'tool_call' && e.tool.startsWith('mcp__memory__')) {
      this.memoryCalls.set(e.id, { tool: e.tool, args: e.args })
    }
    if (e.kind === 'tool_result' && this.memoryCalls.has(e.id)) {
      const call = this.memoryCalls.get(e.id)!
      this.memoryCalls.delete(e.id)
      const detail = e.detail ?? e.summary
      // our own result format leads each hit with "[ENG-3443] title"
      const refs = [...new Set([...detail.matchAll(/^\[([^\]]{2,40})\]/gm)].map((m) => m[1]))].slice(0, 4)
      if (e.ok && refs.length > 0) {
        const isSearch = call.tool.endsWith('search_memory')
        const q = typeof call.args.query === 'string' ? call.args.query : String(call.args.id ?? '')
        this.push(id, {
          kind: 'evidence',
          evidence: {
            id: `mem-${e.id.slice(-8)}`,
            type: 'memory',
            claim: isSearch ? `memory search "${q.slice(0, 70)}" → ${refs.join(', ')}` : `pulled full record ${refs[0]} (root cause + discussion)`,
            source: call.tool.replace('mcp__memory__', 'memory: '),
            snippet: detail.split('\n').slice(0, 2).join('\n').slice(0, 200),
            ts: e.ts,
          },
          ts: e.ts,
        })
      }
    }
    if (e.kind === 'reasoning') {
      this.transcripts.set(id, (this.transcripts.get(id) ?? '') + '\n' + e.text)
    }
    // The report block is plumbing, not conversation — keep it off the
    // timeline, but PERSIST it immediately: the in-memory transcript dies
    // with a respawn, the events table doesn't.
    if (e.kind === 'reasoning' && e.text.includes('```mesh-report')) {
      eventsRepo(this.deps.db).append(id, 'report.raw', { text: e.text }, this.sessionRows.get(id))
      this.push(id, { kind: 'status', text: 'report received — validating…', ts: e.ts })
      return
    }
    this.push(id, e)
  }

  private finalize(id: string): void {
    const invs = investigationsRepo(this.deps.db)
    const inv = invs.get(id)
    if (!inv || inv.status === 'abandoned') return

    const transcript = this.transcripts.get(id) ?? ''
    let report = extractReport(transcript)
    if (!report) {
      // Respawn-durable fallback: the raw report block persisted in events —
      // scoped to THIS session so a feedback turn can't resurrect the old one.
      const sessionRow = this.sessionRows.get(id)
      const rows = this.deps.db
        .prepare(`SELECT payload_json FROM events WHERE investigation_id = ? AND type = 'report.raw' AND session_id IS ? ORDER BY id DESC LIMIT 1`)
        .all(id, sessionRow ?? null) as { payload_json: string }[]
      if (rows[0]) report = extractReport((JSON.parse(rows[0].payload_json) as { text: string }).text)
    }

    // Wedge-retry: the duplicate-tool_use 400 corrupts the SDK transcript and
    // kills the session before any report. One fresh restart (NO resume — the
    // corrupted history is the disease), then give up honestly.
    if (!report && this.wedged.has(id) && !this.retried.has(id)) {
      this.retried.add(id)
      this.wedged.delete(id)
      const row = this.sessionRows.get(id)
      if (row) sessionsRepo(this.deps.db).end(row, 'wedge-retried')
      this.push(id, { kind: 'status', text: 'provider session hit an SDK glitch (duplicate tool_use ids) — restarting fresh', ts: Date.now() })
      this.spawnSession(id) // no resumeSessionId on purpose
      return
    }

    const sessionRow = this.sessionRows.get(id)
    if (sessionRow) sessionsRepo(this.deps.db).end(sessionRow, report ? 'report' : 'no-report', this.sessions.get(id)?.usage)

    if (report) {
      invs.setReport(id, report, report.confidence)
      this.setStage(id, 'report')
      this.deps.emitState(id, 'report', 'report')
      this.saveToMemory(inv, report)
      // learnings go in as PROPOSED — the user gates them into context (Report UI)
      if (report.learnings?.length) learningsRepo(this.deps.db).propose(id, report.learnings)
      // map deltas likewise: proposed edges (+ stub nodes for unknown ids),
      // gated on the Knowledge Map screen; only accepted edges reach prompts
      if (report.mapUpdates?.length) {
        const map = mapRepo(this.deps.db)
        let proposed = 0
        for (const u of report.mapUpdates.slice(0, 12)) {
          for (const nid of [u.from, u.to]) {
            if (!map.hasNode(nid)) {
              map.upsertNode({ id: nid, label: nid, kind: 'backend', notes: `auto-created by ${id} — verify kind/repo` })
            }
          }
          map.addEdge(u.from, u.to, u.label, u.kind ?? 'other', 'proposed')
          proposed++
        }
        if (proposed) this.push(id, { kind: 'status', text: `${proposed} map update(s) proposed — review on the Knowledge Map`, ts: Date.now() })
      }
      this.push(id, { kind: 'status', text: `report ready · ${report.confidence}`, ts: Date.now() })
    } else if (inv.report) {
      // feedback turn where the agent stood by its original report
      invs.setStatus(id, 'report')
      this.deps.emitState(id, 'report', 'report')
      this.push(id, { kind: 'status', text: 'agent responded — original report stands', ts: Date.now() })
    } else {
      this.push(id, { kind: 'status', text: 'session ended without a structured report', ts: Date.now() })
    }
    this.sessions.delete(id)
    this.transcripts.delete(id)
    this.wedged.delete(id)
    // prompts intentionally kept — the post-report comment loop reuses them
  }

  /** Section 7 feedback loop: every completed investigation becomes memory. */
  private saveToMemory(inv: Investigation, report: Report): void {
    const memory = memoryRepo(this.deps.db)
    memory.upsert({
      id: `mesh:${inv.id}`,
      source: 'mesh',
      identifier: inv.id,
      title: inv.title,
      symptoms: report.evidence.map((e) => e.claim).join('; ') || inv.title,
      rootCause: report.hypothesis,
      resolution: report.suggestedFix,
      investigationSummary: report.timeline.map((t) => t.label).join(' → '),
      resolutionSteps: [],
      errorSignature: extractSignature(inv.title + ' ' + report.hypothesis) ?? undefined,
      labels: inv.service ? [inv.service] : [],
      reportedAt: inv.createdAt,
      resolvedAt: Date.now(),
      updatedAt: Date.now(),
    })
    void this.deps.embeddings?.drainPending()
    l.info(`saved ${inv.id} to memory`)
  }

  private setStage(id: string, stage: Investigation['stage']): void {
    investigationsRepo(this.deps.db).setStage(id, stage)
    this.push(id, { kind: 'stage', stage, ts: Date.now() })
    this.deps.emitState(id, stage, 'investigating')
  }

  private push(id: string, e: AgentEvent): void {
    eventsRepo(this.deps.db).appendAgentEvent(id, e, this.sessionRows.get(id))
    this.deps.emitAgentEvent(id, e)
  }
}

/** Head+tail of the raw comment thread, bounded for the prompt — the
 *  resolution discussion tends to live at the end. */
function boundedComments(rawJson: string, budget = 6000): string {
  try {
    const raw = JSON.parse(rawJson) as { ticketComments?: { body: string; author?: string }[]; threadReplies?: { body: string; author?: string }[] }
    const all = [...(raw.ticketComments ?? []), ...(raw.threadReplies ?? [])]
    const text = all.map((c) => `[${c.author ?? '?'}] ${c.body}`).join('\n')
    if (text.length <= budget) return text
    return `${text.slice(0, budget / 2)}\n[… trimmed …]\n${text.slice(-budget / 2)}`
  } catch {
    return ''
  }
}

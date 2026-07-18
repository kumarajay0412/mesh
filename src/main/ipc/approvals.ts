// The approval broker — the main-process half of the Section 10 per-action gate.
// A provider's canUseTool blocks on request(); the renderer modal resolves it.
// INVARIANT: no promise ever dangles. Unanswered → timeout-deny. Window
// closed / app quitting → deny-all sweep. A dangling canUseTool promise
// wedges the SDK session forever (plan risk #3).
import { randomUUID } from 'node:crypto'
import type { ApprovalOutcome, ApprovalRequest } from '../../shared/types'
import { log } from '../log'

const l = log('approvals')
const DEFAULT_TIMEOUT_MS = 10 * 60_000 // human-paced

export interface ApprovalDecision {
  approved: boolean
  outcome: ApprovalOutcome
  reason?: string
}

interface PendingEntry {
  resolve: (d: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
  request: ApprovalRequest
}

export class ApprovalBroker {
  private pending = new Map<string, PendingEntry>()

  constructor(
    private emitRequest: (r: ApprovalRequest) => void,
    private emitResolved: (id: string, outcome: ApprovalOutcome) => void,
    private audit: (investigationId: string | undefined, type: string, payload: unknown) => void,
  ) {}

  request(input: Omit<ApprovalRequest, 'id' | 'requestedAt' | 'expiresAt'>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ApprovalDecision> {
    const request: ApprovalRequest = {
      ...input,
      id: randomUUID(),
      requestedAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    }

    this.audit(request.investigationId, 'approval.requested', request)

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => this.settle(request.id, { approved: false, outcome: 'timeout', reason: 'no response within the approval window' }), timeoutMs)
      this.pending.set(request.id, { resolve, timer, request })
      this.emitRequest(request)
    })
  }

  respond(id: string, approved: boolean, reason?: string): void {
    // unknown/consumed ids return cleanly — respond is idempotent
    this.settle(id, { approved, outcome: approved ? 'approved' : 'denied', reason })
  }

  /** Deny everything in flight — window closed, renderer gone, app quitting. */
  denyAll(outcome: ApprovalOutcome = 'window-closed'): void {
    const ids = [...this.pending.keys()]
    if (ids.length > 0) l.warn(`denying ${ids.length} pending approval(s): ${outcome}`)
    for (const id of ids) this.settle(id, { approved: false, outcome, reason: outcome })
  }

  private settle(id: string, decision: ApprovalDecision): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    this.audit(entry.request.investigationId, 'approval.resolved', { id, ...decision })
    this.emitResolved(id, decision.outcome)
    entry.resolve(decision)
  }
}

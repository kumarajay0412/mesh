import type { Database } from 'better-sqlite3'
import type { AgentEvent } from '../../../shared/types'

/** Append-only event log per investigation (Section 8) — the timeline is replayed
 *  from here on reopen; approvals are audited here too. */
export function eventsRepo(db: Database) {
  return {
    append(investigationId: string, type: string, payload: unknown, sessionId?: number): void {
      db.prepare('INSERT INTO events (investigation_id, ts, type, payload_json, session_id) VALUES (?, ?, ?, ?, ?)').run(
        investigationId,
        Date.now(),
        type,
        JSON.stringify(payload ?? {}),
        sessionId ?? null,
      )
    },

    appendAgentEvent(investigationId: string, event: AgentEvent, sessionId?: number): void {
      this.append(investigationId, `agent.${event.kind}`, event, sessionId)
    },

    timeline(investigationId: string): AgentEvent[] {
      const rows = db
        .prepare(`SELECT payload_json FROM events WHERE investigation_id = ? AND type LIKE 'agent.%' ORDER BY id ASC`)
        .all(investigationId) as { payload_json: string }[]
      return rows.map((r) => JSON.parse(r.payload_json) as AgentEvent)
    },
  }
}

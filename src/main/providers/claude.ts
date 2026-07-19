// Claude Code adapter — the primary provider (Section 3). Embeds the Agent SDK:
// streaming-input query() for mid-flight steering, canUseTool for the Section 10
// per-action gate, session_id capture for resume. Auth rides the user's own
// Claude Code login (personal use — no app key).
//
// SDK message shapes are treated as a BOUNDARY: mapped defensively through
// runtime guards so minor SDK drift degrades to a status line, not a crash.
import { query, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '../../shared/types'

/** Where is a spawnable Claude CLI?
 *  Packaged apps CANNOT rely on the SDK's own resolution: it points inside
 *  app.asar, and child_process.spawn gets no asar rewriting (only fork/
 *  execFile do) → "spawn ENOTDIR". Order: explicit override → the unpacked
 *  bundled binary → the user's own install → undefined (dev: SDK resolves). */
function resolveClaudeCli(): string | undefined {
  if (process.env.MESH_CLAUDE_PATH) return process.env.MESH_CLAUDE_PATH
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (res) {
    const unpacked = join(res, 'app.asar.unpacked', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude')
    if (existsSync(unpacked)) return unpacked
  }
  for (const p of [join(homedir(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(p)) return p
  }
  return undefined
}
import type { Provider, Session, SessionUsage, StartOptions } from './types'
import { isReadOnlyCommand, isReadOnlyTool } from './readonly'
import { log } from '../log'

const l = log('provider:claude')

/** Push-queue → async iterable: the SDK's streaming-input mode. */
class UserTurnQueue {
  private buffer: string[] = []
  private waiting: ((v: IteratorResult<{ type: 'user'; message: { role: 'user'; content: string } }>) => void) | null = null
  private closed = false

  get isClosed(): boolean {
    return this.closed
  }

  /** Returns false if the queue is closed — the turn was NOT delivered. */
  push(text: string): boolean {
    if (this.closed) return false
    const item = { type: 'user' as const, message: { role: 'user' as const, content: text } }
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w({ value: item, done: false })
    } else {
      this.buffer.push(text)
    }
    return true
  }

  close(): void {
    this.closed = true
    if (this.waiting) {
      const w = this.waiting
      this.waiting = null
      w({ value: undefined as never, done: true })
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: (): Promise<IteratorResult<{ type: 'user'; message: { role: 'user'; content: string } }>> => {
        const text = this.buffer.shift()
        if (text !== undefined) {
          return Promise.resolve({ value: { type: 'user', message: { role: 'user', content: text } }, done: false })
        }
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => {
          this.waiting = resolve
        })
      },
    }
  }
}

export function claudeProvider(): Provider {
  return {
    id: 'claude',
    capabilities: { approvals: true, steering: true },

    start(opts: StartOptions): Session {
      const turns = new UserTurnQueue()
      turns.push(opts.initialPrompt)
      const abort = new AbortController()
      let sessionId: string | null = opts.resumeSessionId ?? null
      let usage: SessionUsage | null = null
      // running total folded from each assistant message's usage — the salvage
      // value when a session dies before its terminal 'result'
      const running: SessionUsage = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: null, numTurns: null }
      const mode = opts.permissionMode ?? 'default'

      const emit = (e: AgentEvent) => opts.onEvent(e)

      const finished = (async () => {
        try {
          // Split prompt → [cached, BOUNDARY, dynamic] so the invariant prefix
          // is cross-session prompt-cached; plain string passes through.
          const systemPrompt =
            typeof opts.systemPrompt === 'string'
              ? opts.systemPrompt
              : [opts.systemPrompt.cached, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, opts.systemPrompt.dynamic]

          const q = query({
            prompt: turns as AsyncIterable<never>, // streaming-input mode
            options: {
              cwd: opts.cwd,
              systemPrompt,
              pathToClaudeCodeExecutable: resolveClaudeCli(),
              model: opts.model,
              effort: opts.effort,
              permissionMode: mode,
              // required flag when the user explicitly opts into bypass
              allowDangerouslySkipPermissions: mode === 'bypassPermissions' ? true : undefined,
              resume: opts.resumeSessionId,
              abortController: abort,
              mcpServers: opts.mcpServers,
              // Ceiling, not a target: prevents pathological 100+-turn runs
              // whose late turns are the most expensive (full-prefix re-read).
              // Hitting it is user-visible and resumable via the feedback box.
              maxTurns: 60,
              // Oversized tool results get head+tail-capped before entering
              // the transcript — a 49KB dump re-read 40x was half of INV-016's
              // tool bytes. Full guidance lives in OUTPUT DISCIPLINE.
              hooks: {
                PostToolUse: [
                  {
                    hooks: [async (input: { hook_event_name: string; tool_response?: unknown }) => (input.hook_event_name === 'PostToolUse' ? capToolOutput(input.tool_response) : {})],
                  },
                ],
              },
              // The Section 10 gate: reads auto-approve, mutations block on the broker.
              canUseTool: async (toolName: string, input: Record<string, unknown>) => {
                // Auth-walled SPAs can never be fetched — the ticket/thread
                // content is already injected into the prompt from memory.
                if ((toolName === 'WebFetch' || toolName === 'WebSearch') && typeof input.url === 'string' && /linear\.app|slack\.com/.test(input.url)) {
                  return {
                    behavior: 'deny' as const,
                    message:
                      'linear.app/slack.com are auth-walled and cannot be fetched. The full ticket content and discussion are already in your context (see "THE TICKET UNDER INVESTIGATION"); similar past incidents are listed too. Proceed from those.',
                  }
                }
                // NB: SDK 0.3.x's RUNTIME zod schema requires `updatedInput`
                // as a record on allow (its .d.ts marks it optional — trust
                // the runtime). Omitting it fails every permission check with
                // "Tool permission request failed: ZodError: invalid_union".
                if (isReadOnlyTool(toolName)) return { behavior: 'allow' as const, updatedInput: input }
                if (toolName === 'Bash' && typeof input.command === 'string' && isReadOnlyCommand(input.command)) {
                  return { behavior: 'allow' as const, updatedInput: input }
                }
                // Mode-aware write handling (mirrors Claude Code):
                //   auto/bypass — the user opted out of per-action approvals
                //   plan       — writes are quietly refused; planning only
                //   default/acceptEdits — the Section 10 broker gate below
                if (mode === 'auto' || mode === 'bypassPermissions') {
                  return { behavior: 'allow' as const, updatedInput: input }
                }
                if (mode === 'plan') {
                  return { behavior: 'deny' as const, message: 'Plan mode: no mutations — describe the change instead.' }
                }
                if (mode === 'acceptEdits' && (toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit')) {
                  return { behavior: 'allow' as const, updatedInput: input }
                }
                const preview = JSON.stringify(input, null, 2).slice(0, 1200)
                const approved = await opts.requestApproval(
                  toolName,
                  `Agent wants to run ${toolName}`,
                  `The investigation agent asked for a mutating action via ${toolName}.`,
                  preview,
                )
                return approved
                  ? { behavior: 'allow' as const, updatedInput: input }
                  : { behavior: 'deny' as const, message: 'Denied by the user (per-action approval, Section 10).' }
              },
            } as never, // structural boundary: keep compiling across minor SDK option drift
          })

          for await (const raw of q as AsyncIterable<unknown>) {
            const m = raw as Record<string, unknown>
            const newSession = mapMessage(m, emit)
            if (newSession) sessionId = newSession
            // Accumulate per-message usage as the stream flows, so a session
            // that dies before its 'result' (e.g. the duplicate-tool_use wedge
            // after 50 turns) still records what it spent, not NULL.
            accumulateUsage(m, running)
            // Streaming-input mode never ends on its own — the queue would
            // wait for more user turns forever after the agentic turn
            // completes. 'result' = the turn is done: close the queue so the
            // generator drains and the session finalizes. (Steering is a
            // MID-turn feature; post-result the investigation is over.)
            if (m.type === 'result') {
              usage = extractUsage(m) ?? (running.outputTokens > 0 ? running : null)
              if (usage) {
                emit({
                  kind: 'status',
                  text: `tokens: ${fmtTok(usage.inputTokens + usage.cacheWriteTokens)} in · ${fmtTok(usage.cacheReadTokens)} cached-read · ${fmtTok(usage.outputTokens)} out · ${usage.numTurns ?? '?'} turns${usage.costUsd != null ? ` · $${usage.costUsd.toFixed(2)}` : ''}`,
                  ts: Date.now(),
                })
              }
              turns.close()
              break
            }
          }
          emit({ kind: 'done', ts: Date.now() })
        } catch (e) {
          if (!abort.signal.aborted) {
            l.error('session error:', (e as Error).message)
            emit({ kind: 'error', text: `provider error: ${(e as Error).message}`, ts: Date.now() })
          }
          // Close the queue on error too — otherwise a later send() would feed
          // a dead generator and be silently lost (it now returns false).
          turns.close()
          // On a wedged/errored session, salvage the streamed usage.
          if (!usage && running.outputTokens > 0) usage = running
          emit({ kind: 'done', ts: Date.now() })
        }
      })()

      return {
        get sessionId() {
          return sessionId
        },
        get usage() {
          return usage
        },
        send(text: string): boolean {
          return turns.push(text) // false if the session is no longer accepting turns
        },
        interrupt() {
          abort.abort()
          turns.close()
        },
        finished,
      }
    },

    /** One-shot, tool-less — intake extraction + the distill pass. These are
     *  zod-validated JSON extraction with heuristic fallbacks: Haiku-class
     *  work. `tools: []` matters as much as the model — allowedTools only
     *  gates permissions; without tools:[] every call ships the full built-in
     *  tool schema (~10-15K tokens) that nothing here can ever use. */
    async oneShot(system: string, prompt: string): Promise<string> {
      const chunks: string[] = []
      const q = query({
        prompt,
        options: {
          systemPrompt: system,
          pathToClaudeCodeExecutable: resolveClaudeCli(),
          maxTurns: 1,
          model: 'claude-haiku-4-5-20251001',
          effort: 'low',
          tools: [],
          allowedTools: [],
          permissionMode: 'default',
          canUseTool: async () => ({ behavior: 'deny' as const, message: 'one-shot: no tools' }),
        } as never,
      })
      for await (const raw of q as AsyncIterable<unknown>) {
        const m = raw as Record<string, unknown>
        if (m.type === 'assistant') {
          for (const block of contentBlocks(m)) {
            if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text)
          }
        }
        if (m.type === 'result' && typeof (m as { result?: unknown }).result === 'string') {
          return (m as { result: string }).result
        }
      }
      return chunks.join('')
    },
  }
}

/* --------------------------------------------- oversized tool-result cap -- */

// A single 49KB git -p dump re-read on every later turn dominated INV-016's
// token bill (4 results >20KB = 51% of all tool bytes). Head+tail keeps the
// stack frame AND the tail where conclusions live; the marker tells the agent
// to re-query narrower (OUTPUT DISCIPLINE in the runbook).
const CAP_ABOVE = 20_000
const HEAD = 12_000
const TAIL = 4_000

function capText(text: string): string {
  return `${text.slice(0, HEAD)}\n[… Mesh truncated ${text.length - HEAD - TAIL} chars — result too broad; re-query narrower (see OUTPUT DISCIPLINE) …]\n${text.slice(-TAIL)}`
}

/** PostToolUse hook: replaces pathological tool outputs before they enter the
 *  model transcript. Handles plain strings and MCP-style content arrays. */
function capToolOutput(toolResponse: unknown): { hookSpecificOutput: { hookEventName: 'PostToolUse'; updatedToolOutput: unknown } } | Record<string, never> {
  if (typeof toolResponse === 'string' && toolResponse.length > CAP_ABOVE) {
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: capText(toolResponse) } }
  }
  if (toolResponse && typeof toolResponse === 'object' && Array.isArray((toolResponse as { content?: unknown }).content)) {
    let changed = false
    const content = ((toolResponse as { content: unknown[] }).content).map((block) => {
      const b = block as { type?: string; text?: string }
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.length > CAP_ABOVE) {
        changed = true
        return { ...b, text: capText(b.text) }
      }
      return block
    })
    if (changed) return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...(toolResponse as object), content } } }
  }
  return {}
}

/** Result-message usage → SessionUsage. Field names per SDKResultSuccess. */
function extractUsage(m: Record<string, unknown>): SessionUsage | null {
  const u = m.usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } | undefined
  if (!u) return null
  return {
    inputTokens: u.input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : null,
    numTurns: typeof m.num_turns === 'number' ? m.num_turns : null,
  }
}

/** Fold an assistant message's usage into the running total. The API attaches
 *  usage to each assistant message; summing these salvages the spend of a
 *  session that never reaches its terminal 'result'. */
function accumulateUsage(m: Record<string, unknown>, running: SessionUsage): void {
  if (m.type !== 'assistant') return
  const u = (m.message as { usage?: Record<string, number> } | undefined)?.usage
  if (!u) return
  running.inputTokens += u.input_tokens ?? 0
  running.cacheWriteTokens += u.cache_creation_input_tokens ?? 0
  running.cacheReadTokens += u.cache_read_input_tokens ?? 0
  running.outputTokens += u.output_tokens ?? 0
  running.numTurns = (running.numTurns ?? 0) + 1
}

function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/* ------------------------------------------------ SDK message → AgentEvent -- */

function contentBlocks(m: Record<string, unknown>): { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }[] {
  const msg = m.message as { content?: unknown } | undefined
  return Array.isArray(msg?.content) ? (msg.content as never[]) : []
}

/** Returns a session id when the message carries one. */
function mapMessage(m: Record<string, unknown>, emit: (e: AgentEvent) => void): string | null {
  const ts = Date.now()
  const sid = typeof m.session_id === 'string' ? m.session_id : null

  switch (m.type) {
    case 'system': {
      if (m.subtype === 'init') emit({ kind: 'status', text: 'session started · claude code · read-only', ts })
      return sid
    }
    case 'assistant': {
      for (const block of contentBlocks(m)) {
        if (block.type === 'text' && block.text?.trim()) {
          emit({ kind: 'reasoning', text: block.text, ts })
        } else if (block.type === 'tool_use' && block.id && block.name) {
          emit({
            kind: 'tool_call',
            id: block.id,
            tool: block.name,
            title: summarizeArgs(block.name, block.input ?? {}),
            args: block.input ?? {},
            ts,
          })
        }
      }
      return sid
    }
    case 'user': {
      for (const block of contentBlocks(m)) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          emit({
            kind: 'tool_result',
            id: block.tool_use_id,
            ok: !block.is_error,
            summary: resultSummary(block.content),
            detail: resultDetail(block.content),
            ts,
          })
        }
      }
      return sid
    }
    case 'result': {
      const sub = typeof m.subtype === 'string' ? m.subtype : 'done'
      if (/max_turns/.test(sub)) {
        emit({ kind: 'status', text: 'hit the 60-turn ceiling — the session is resumable: send feedback/steering to continue where it stopped', ts })
      } else {
        emit({ kind: 'status', text: `session result: ${sub}`, ts })
      }
      return sid
    }
    default:
      return sid
  }
}

function summarizeArgs(tool: string, input: Record<string, unknown>): string {
  const c = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url
  const s = typeof c === 'string' ? c : JSON.stringify(input)
  return `${tool === 'Bash' ? '' : ''}${s}`.slice(0, 120)
}

function resultSummary(content: unknown): string {
  return resultDetail(content).split('\n')[0]?.slice(0, 160) || '(empty result)'
}

function resultDetail(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : typeof (b as { text?: string }).text === 'string' ? (b as { text: string }).text : ''))
      .join('\n')
  }
  return JSON.stringify(content ?? '')
}

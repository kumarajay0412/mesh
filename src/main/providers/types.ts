import type { AgentEvent } from '../../shared/types'

/** Section 3 Provider interface — Claude Code and Codex behind one shape. */
export interface ProviderCapabilities {
  approvals: boolean // can gate writes per-action mid-session
  steering: boolean // can accept user turns mid-flight
}

export interface StartOptions {
  cwd: string
  systemPrompt: string
  initialPrompt: string
  /** model override; undefined = provider default */
  model?: string
  /** reasoning effort; undefined = provider default */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Claude-Code-style permission mode; 'default' = approve writes per action */
  permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'plan' | 'bypassPermissions'
  /** resume a previous provider session (durability without Temporal) */
  resumeSessionId?: string
  /** MCP servers to expose to the session — either stdio configs (e.g. Sentry:
   *  { command, args, env }) or in-process SDK server instances (e.g. the
   *  memory tools: createSdkMcpServer's { type: 'sdk', name, instance }).
   *  Kept structural so this file stays SDK-import-free. */
  mcpServers?: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> } | { type: 'sdk'; name: string; instance: unknown }
  >
  onEvent: (e: AgentEvent) => void
  /** Section 10 gate — resolves true only on explicit user approval */
  requestApproval: (tool: string, title: string, description: string, payloadPreview: string) => Promise<boolean>
}

/** Token accounting from the provider's result message — persisted to the
 *  sessions ledger so cost-per-investigation is measured, not guessed. */
export interface SessionUsage {
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number | null
  numTurns: number | null
}

export interface Session {
  /** provider-native session id (for resume), once known */
  readonly sessionId: string | null
  /** usage totals, known once the session's result message arrives */
  readonly usage: SessionUsage | null
  /** steering: append a user turn mid-flight */
  send(text: string): void
  interrupt(): void
  /** resolves when the session ends (done/error) */
  readonly finished: Promise<void>
}

export interface Provider {
  readonly id: 'claude' | 'codex'
  readonly capabilities: ProviderCapabilities
  start(opts: StartOptions): Session
  /** one-shot, no tools — used by intake extraction and the distill pass */
  oneShot(system: string, prompt: string): Promise<string>
}

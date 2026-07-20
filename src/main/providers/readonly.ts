// Read-only command classifier for the Section 10 gate: reads auto-approve,
// everything else goes to the approval broker. Deny-by-default shape —
// a command must MATCH a read pattern to skip approval.

const READ_ONLY_PATTERNS: RegExp[] = [
  /^git\s+(log|show|diff|blame|status|branch\b|rev-parse|describe|shortlog|ls-files|grep)\b/,
  /^(rg|grep|ls|cat|head|tail|wc|find|stat|file|du|df|pwd|which|whoami|date|env)\b/,
  /^(jq|yq|sort|uniq|cut|awk|sed\s+-n)\b/, // text filters (sed only in -n print mode)
  /^echo\b/,
]

// Shell metacharacters that can smuggle a write past a read-only prefix.
const SMUGGLING = /[;&|]|\$\(|`|>\s*\S|>>/

const KUBECTL_READ_VERBS = new Set(['get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info', 'events'])
// Global flags safe to appear BEFORE the verb. Cluster/namespace targeting is
// the whole point of Phase 2; auth-changing flags (--as, --token, --username…)
// are deliberately NOT here, so impersonation still hits the approval gate.
const KUBECTL_SAFE_FLAGS = new Set([
  '--context', '--namespace', '-n', '--cluster', '--kubeconfig', '--request-timeout', '-o', '--output',
  '--field-selector', '--selector', '-l', '--sort-by', '--all-namespaces', '-A', '--since', '--tail', '--previous', '-p',
])
const KUBECTL_BOOL_FLAGS = new Set(['--all-namespaces', '-A', '--previous', '-p'])

/** kubectl is read-only when, after any leading SAFE global flags, the verb is
 *  a read verb (or `rollout history|status`). Tolerates `--context X -n Y`,
 *  which the old anchored regex rejected — every such call hit the approval
 *  modal. SMUGGLING is already screened out by isReadOnlyCommand before here. */
function isReadOnlyKubectl(cmd: string): boolean {
  const tokens = cmd.split(/\s+/)
  if (tokens[0] !== 'kubectl') return false
  let i = 1
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const flag = tokens[i].split('=')[0]
    if (!KUBECTL_SAFE_FLAGS.has(flag)) return false // unknown/unsafe flag before the verb → gate it
    const consumesValue = !tokens[i].includes('=') && !KUBECTL_BOOL_FLAGS.has(flag)
    i += consumesValue ? 2 : 1 // skip the flag's separate value token too
  }
  const verb = tokens[i]
  if (verb === 'rollout') return tokens[i + 1] === 'history' || tokens[i + 1] === 'status'
  return KUBECTL_READ_VERBS.has(verb)
}

export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim()
  if (SMUGGLING.test(cmd)) return false
  if (cmd.startsWith('kubectl')) return isReadOnlyKubectl(cmd)
  return READ_ONLY_PATTERNS.some((p) => p.test(cmd))
}

/** SDK tools that never mutate anything. 'Task'/'Agent' (subagent spawn) are
 *  safe to auto-allow: the sub-agent's own tool calls still route through
 *  canUseTool (the SDK tags them with agentID), so the Section 10 gate holds. */
export const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'NotebookRead', 'TodoWrite', 'Task', 'Agent'])

/**
 * Exact tool NAMES from external MCP connectors the SDK auto-inherits from
 * the user's own Claude Code environment (project .mcp.json, user settings,
 * claude.ai cloud connectors) — additive on top of whatever Mesh itself
 * wires, unless strictMcpConfig/settingSources opt out (Mesh does neither).
 * These connectors are NOT prefix-allowed like our own mcp__memory__*: the
 * same Slack connector that can search/read can also send/schedule/create,
 * so only individually-verified read/search tools go in this set. Anything
 * write-shaped from the same connector (slack_send_message,
 * slack_schedule_message, slack_create_canvas, slack_update_canvas, …) is
 * deliberately absent and stays behind the approval broker.
 */
const EXTERNAL_READ_ONLY_TOOL_NAMES = new Set([
  // Slack cloud connector
  'slack_search_public',
  'slack_search_public_and_private',
  'slack_search_channels',
  'slack_search_users',
  'slack_read_channel',
  'slack_read_thread',
  'slack_read_user_profile',
  'slack_read_canvas',
])

/** Gate predicate for tool NAMES. Our in-process `memory` MCP tools
 *  (mcp__memory__*) are read-only by construction — they wrap searchMemory /
 *  memoryRepo lookups and never write, so the whole prefix is trusted.
 *  External MCP servers (Sentry, and whatever else the environment
 *  inherits) are NOT prefix-allowed — matched by exact tool-name suffix
 *  instead: the `mcp__<server>__<tool>` server segment is unstable (a UUID
 *  in one environment, a human-readable connector name in another), so only
 *  the tool-name portion is checked against EXTERNAL_READ_ONLY_TOOL_NAMES. */
export function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY_TOOLS.has(name) || name.startsWith('mcp__memory__')) return true
  const m = name.match(/^mcp__.+__([a-z0-9_]+)$/i)
  return !!m && EXTERNAL_READ_ONLY_TOOL_NAMES.has(m[1])
}

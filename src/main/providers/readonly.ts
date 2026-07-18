// Read-only command classifier for the Section 10 gate: reads auto-approve,
// everything else goes to the approval broker. Deny-by-default shape —
// a command must MATCH a read pattern to skip approval.

const READ_ONLY_PATTERNS: RegExp[] = [
  /^git\s+(log|show|diff|blame|status|branch\b|rev-parse|describe|shortlog|ls-files|grep)\b/,
  /^kubectl\s+(get|describe|logs|top|explain|api-resources|version|cluster-info)\b/,
  /^kubectl\s+rollout\s+(history|status)\b/,
  /^(rg|grep|ls|cat|head|tail|wc|find|stat|file|du|df|pwd|which|whoami|date|env)\b/,
  /^(jq|yq|sort|uniq|cut|awk|sed\s+-n)\b/, // text filters (sed only in -n print mode)
  /^echo\b/,
]

// Shell metacharacters that can smuggle a write past a read-only prefix.
const SMUGGLING = /[;&|]|\$\(|`|>\s*\S|>>/

export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim()
  if (SMUGGLING.test(cmd)) return false
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

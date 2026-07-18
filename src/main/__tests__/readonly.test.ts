import { describe, expect, it } from 'vitest'
import { isReadOnlyCommand, isReadOnlyTool } from '../providers/readonly'

describe('isReadOnlyTool', () => {
  it('allows built-in read-only tools by exact name', () => {
    expect(isReadOnlyTool('Read')).toBe(true)
    expect(isReadOnlyTool('Grep')).toBe(true)
    expect(isReadOnlyTool('Bash')).toBe(false)
  })

  it('trusts the whole mcp__memory__ prefix (ours, read-only by construction)', () => {
    expect(isReadOnlyTool('mcp__memory__search_memory')).toBe(true)
    expect(isReadOnlyTool('mcp__memory__get_incident')).toBe(true)
  })

  it('allows known Slack read/search tools regardless of the server-segment naming', () => {
    // UUID-style server segment (this environment's connector id)
    expect(isReadOnlyTool('mcp__dad1a13d-3f57-4a8d-ac86-b662975eaa12__slack_search_public')).toBe(true)
    // human-readable server segment (observed in INV-016's actual trace)
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_read_thread')).toBe(true)
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_search_channels')).toBe(true)
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_read_user_profile')).toBe(true)
  })

  it('NEVER allows write-shaped tools from the same inherited connector', () => {
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_send_message')).toBe(false)
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_send_message_draft')).toBe(false)
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_schedule_message')).toBe(false)
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_create_canvas')).toBe(false)
    expect(isReadOnlyTool('mcp__claude_ai_Slack__slack_update_canvas')).toBe(false)
    expect(isReadOnlyTool('mcp__dad1a13d-3f57-4a8d-ac86-b662975eaa12__slack_send_message')).toBe(false)
  })

  it('does not allow unrecognized external MCP tools (e.g. Sentry stays gated)', () => {
    expect(isReadOnlyTool('mcp__sentry__search_events')).toBe(false)
    expect(isReadOnlyTool('mcp__grafana-v2__get_annotations')).toBe(false)
  })

  it('ignores malformed mcp tool names rather than throwing', () => {
    expect(isReadOnlyTool('mcp__onlyoneseparator')).toBe(false)
    expect(isReadOnlyTool('')).toBe(false)
  })
})

describe('isReadOnlyCommand (unchanged behavior sanity check)', () => {
  it('still allows git log and denies smuggled writes', () => {
    expect(isReadOnlyCommand('git log -5')).toBe(true)
    expect(isReadOnlyCommand('git log; rm -rf /')).toBe(false)
  })
})

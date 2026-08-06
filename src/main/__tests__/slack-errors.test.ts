import { describe, expect, it } from 'vitest'
import { friendlySlackError } from '../sync/slack'

describe('friendlySlackError', () => {
  it('maps known Slack platform error codes to plain language', () => {
    expect(friendlySlackError({ data: { error: 'invalid_auth' } })).toBe('invalid token')
    expect(friendlySlackError({ data: { error: 'missing_scope' } })).toBe('token is missing the channels:read scope')
    expect(friendlySlackError({ data: { error: 'account_inactive' } })).toBe('token revoked, or the account was deactivated')
  })

  it('explains membership errors with the action to take', () => {
    // the exact failure a public-but-not-joined channel produces
    expect(friendlySlackError({ data: { error: 'not_in_channel' } })).toMatch(/\/invite/)
    expect(friendlySlackError({ data: { error: 'channel_not_found' } })).toMatch(/re-pick/)
  })

  it('falls back to the raw code for unrecognized platform errors', () => {
    expect(friendlySlackError({ data: { error: 'fatal_error' } })).toBe('fatal_error')
  })

  it('falls back to the error message when there is no platform error code', () => {
    expect(friendlySlackError(new Error('network unreachable'))).toBe('network unreachable')
  })

  it('never throws on a shapeless input', () => {
    expect(friendlySlackError({})).toBe('unknown error')
    expect(friendlySlackError(null)).toBe('unknown error')
  })
})

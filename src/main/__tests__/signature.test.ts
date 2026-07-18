import { describe, expect, it } from 'vitest'
import { extractSignature } from '../memory/signature'

describe('error-signature extraction', () => {
  it('exception + js frame', () => {
    const sig = extractSignature('TypeError: cannot read x\n    at settleOrder (src/clients/settlement.ts:88:12)')
    expect(sig).toBe('TypeError:settleOrder')
  })

  it('exception + file:line fallback', () => {
    const sig = extractSignature('ValidationError raised in billing/invoice.py:142 during nightly run')
    expect(sig).toBe('ValidationError:invoice.py')
  })

  it('bare exception when no frame is present', () => {
    expect(extractSignature('caught a NullPointerException somewhere')).toBe('NullPointerException')
  })

  it('OOMKilled with and without a pod name', () => {
    expect(extractSignature('pod payments-api OOMKilled again')).toBe('OOMKilled:payments-api')
    expect(extractSignature('the batch job got OOMKilled overnight')).toBe('OOMKilled')
  })

  it('deadline + connection-reset idioms', () => {
    expect(extractSignature('settle: context deadline exceeded path=/api/pay/settle')).toBe('DeadlineExceeded:/api/pay/settle')
    expect(extractSignature('recv() failed: connection reset by peer')).toBe('ConnResetByPeer')
  })

  it('null when nothing error-like appears', () => {
    expect(extractSignature('p99 latency is climbing slowly since the deploy')).toBeNull()
  })
})

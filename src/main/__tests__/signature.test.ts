import { describe, expect, it } from 'vitest'
import { extractSignature, isSpecificSignature } from '../memory/signature'
import { findSignature } from '../sync/distill'

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

  // Batch 2: unify ingest + query, extend coverage
  it('ingest (findSignature) and query (extractSignature) canonicalize identically', () => {
    const raw = 'TypeError: cannot read x\n    at handleTranscript (src/dictate/cmd.ts:88)'
    expect(findSignature(raw)).toBe(extractSignature(raw))
    expect(findSignature(raw)).toBe('TypeError:handleTranscript')
  })

  it('Python tracebacks (previously reduced to bare type)', () => {
    const py = 'Traceback (most recent call last):\n  File "app/parser.py", line 42, in parse_html\n    x = y\nValueError: bad case_no'
    expect(extractSignature(py)).toBe('ValueError:parse_html')
  })

  it('Go panics (previously null — lowercase panic:/fatal error:)', () => {
    expect(extractSignature('panic: runtime error: invalid memory address')).toMatch(/^Panic:runtime error/)
    expect(extractSignature('fatal error: concurrent map writes')).toMatch(/^Panic:concurrent map writes/)
  })

  it('connection-refused with target (the cmd-batch-asr family)', () => {
    expect(extractSignature('dial tcp: connect: connection refused to cmd-batch-asr')).toBe('ConnRefused:cmd-batch-asr')
  })

  it('isSpecificSignature: only frame-qualified pins above ranking', () => {
    expect(isSpecificSignature('TypeError:handleTranscript')).toBe(true)
    expect(isSpecificSignature('NullPointerException')).toBe(false)
    expect(isSpecificSignature(null)).toBe(false)
  })
})

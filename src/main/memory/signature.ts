// Error-signature normalization — the highest-precision retrieval signal:
// same exception type at the same frame ≈ same incident. Pure, testable.

/** Normalize free text → a stable `ExceptionType:frame` fingerprint, or null. */
export function extractSignature(text: string): string | null {
  const exc = text.match(/\b([A-Z][A-Za-z0-9]*(?:Error|Exception|Panic|Fault))\b/)
  if (exc) {
    const frame =
      text.match(/\bat\s+([\w$.<>]+)\s*\(/) ?? // js/java style: at fn(
      text.match(/([\w-]+\.(?:ts|js|tsx|py|go|rb|java|rs)):\d+/) // file.ext:line
    return frame ? `${exc[1]}:${normalizeFrame(frame[1])}` : exc[1]
  }
  if (/\bOOMKilled\b/i.test(text)) {
    const svc = text.match(/\b(?:deploy(?:ment)?|pod|app|container)[\s/=:]+([\w-]+)/i)
    return svc ? `OOMKilled:${svc[1]}` : 'OOMKilled'
  }
  if (/\bconnection reset by peer\b/i.test(text)) return 'ConnResetByPeer'
  if (/\bcontext deadline exceeded\b/i.test(text)) {
    const path = text.match(/\b(?:path|route|endpoint)[=:\s]+([\w/.-]+)/i)
    return path ? `DeadlineExceeded:${path[1]}` : 'DeadlineExceeded'
  }
  return null
}

function normalizeFrame(frame: string): string {
  // strip line/col noise and generics so minor shifts don't break the match
  return frame.replace(/[<>()]/g, '').replace(/:\d+(?::\d+)?$/, '')
}

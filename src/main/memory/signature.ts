// Error-signature normalization — the highest-precision retrieval signal:
// same exception type at the same frame ≈ same incident. Pure, testable.
// THE single canonicalizer, used identically at ingest and at query time —
// two different extractors meant stored and searched signatures never matched.

/** Normalize free text → a stable `ExceptionType:frame` fingerprint, or null.
 *  Frame-qualified results (containing ':') are specific enough to pin in
 *  ranking; a bare type ('TypeError') is not. */
export function extractSignature(text: string): string | null {
  // Named exception/error/panic/fault type — JS/Java/.NET/Python class names.
  const exc = text.match(/\b([A-Z][A-Za-z0-9_]*(?:Error|Exception|Panic|Fault))\b/)
  if (exc) {
    const js = text.match(/\bat\s+([\w$.<>]+)\s*\(/) // JS/Java: at fn(
    // Python traceback: File "…/x.py", line N, in fn
    const py = text.match(/File\s+"[^"]*?([\w.-]+\.py)",\s*line\s*\d+(?:,\s*in\s+([\w.<>]+))?/)
    const generic = text.match(/([\w-]+\.(?:ts|tsx|js|jsx|py|go|rb|java|rs|kt|cs|php)):\d+/)
    const frame = js ? js[1] : py ? (py[2] ?? py[1]) : generic ? generic[1] : null
    return frame ? `${exc[1]}:${normalizeFrame(frame)}` : exc[1]
  }
  // Go panics / fatal errors — lowercase, no Error-suffixed type name.
  const goPanic = text.match(/\b(?:panic|fatal error):\s*([^\n]{0,80})/i)
  if (goPanic) {
    const detail = goPanic[1].split(/[[({]/)[0].trim().replace(/\s+/g, ' ').slice(0, 48)
    return detail ? `Panic:${detail}` : 'Panic'
  }
  if (/\bOOMKilled\b/i.test(text) || /\bout of memory\b/i.test(text)) {
    const svc = text.match(/\b(?:deploy(?:ment)?|pod|app|container)[\s/=:]+([\w-]+)/i)
    return svc ? `OOMKilled:${svc[1]}` : 'OOMKilled'
  }
  if (/\bconnection reset by peer\b/i.test(text)) return 'ConnResetByPeer'
  if (/\bconnection refused\b/i.test(text)) {
    // prefer the "…refused to <service>" target; fall back to "dial <service>:"
    const svc = text.match(/connection refused\b[^\n]*?\bto\s+([\w-]+)/i) ?? text.match(/\bdial\s+(?!tcp\b|udp\b)([\w-]+)/i)
    return svc ? `ConnRefused:${svc[1]}` : 'ConnRefused'
  }
  if (/\bcontext deadline exceeded\b/i.test(text)) {
    const path = text.match(/\b(?:path|route|endpoint)[=:\s]+([\w/.-]+)/i)
    return path ? `DeadlineExceeded:${path[1]}` : 'DeadlineExceeded'
  }
  return null
}

/** Frame-qualified = specific enough to pin above ranking. */
export function isSpecificSignature(sig: string | null): boolean {
  return !!sig && sig.includes(':')
}

function normalizeFrame(frame: string): string {
  // strip line/col noise and generics so minor shifts don't break the match
  return frame.replace(/[<>()]/g, '').replace(/:\d+(?::\d+)?$/, '')
}

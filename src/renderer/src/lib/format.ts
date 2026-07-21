/** Compact relative time: "4m ago", "2h ago", "3d ago". */
export function timeAgo(ts?: number): string {
  if (!ts) return '—'
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d === 1) return 'yesterday'
  return `${d}d ago`
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** API spend, rendered for a badge. Sub-cent runs still deserve a figure —
 *  "$0.00" reads as free, which it isn't — so anything above zero shows at
 *  least two significant places. */
export function formatUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return usd > 0 ? '<$0.01' : '$0.00'
}

/** 7048495 → "7.0M". Token counts are only ever read for magnitude. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

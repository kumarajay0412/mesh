/** Unmapped deployments degrade investigation quality — surfaced, never silent (Section 2.1). */
export function UnmappedBanner({ names }: { names: string[] }) {
  if (names.length === 0) return null
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-line bg-ink-800 px-4 py-3 text-[12px] text-subtle">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ada-warning)" strokeWidth="1.7" strokeLinecap="round">
        <path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </svg>
      <span>
        {names.length} deployment{names.length > 1 ? 's are' : ' is'} unmapped — investigation quality is degraded for{' '}
        <span className="font-mono text-muted">{names.join(', ')}</span>.
      </span>
    </div>
  )
}

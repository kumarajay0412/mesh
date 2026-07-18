import { Button } from '../ui'

/** The report's two outward actions — both are Section 10-gated writes and always
 *  route through the approval flow; nothing here mutates directly. */
export function ReportActions({
  onPostToLinear,
  onOpenFixSession,
}: {
  onPostToLinear: () => void
  onOpenFixSession: () => void
}) {
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" onClick={onPostToLinear}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        Post to Linear
        <GateHint />
      </Button>
      <Button variant="primary" onClick={onOpenFixSession}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
        </svg>
        Open fix session
        <GateHint dark />
      </Button>
    </div>
  )
}

function GateHint({ dark }: { dark?: boolean }) {
  return (
    <span
      className="ml-1 rounded-sm border px-1 font-mono text-[9px] uppercase tracking-wider"
      style={{ borderColor: dark ? 'rgba(14,14,14,0.4)' : 'var(--ada-line-strong)', opacity: 0.75 }}
    >
      approval
    </span>
  )
}

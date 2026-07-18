export function Toggle({ on, onChange, disabled }: { on: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className="no-drag relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60"
      style={{ background: on ? 'var(--ada-gold-400)' : 'var(--ada-ink-600)' }}
    >
      <span className="absolute h-4 w-4 rounded-full bg-white transition-all" style={{ left: on ? 18 : 2 }} />
    </button>
  )
}

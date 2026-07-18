export function Tabs<T extends string>({
  items,
  value,
  onChange,
  right,
}: {
  items: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  right?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-1 border-b border-line pb-2 text-[13px]">
      {items.map((t) => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={`no-drag rounded-sm px-3 py-1.5 font-medium transition-colors ${
              active ? 'text-txt' : 'text-subtle hover:text-muted'
            }`}
            style={active ? { boxShadow: 'inset 0 -2px 0 var(--ada-gold-400)' } : undefined}
          >
            {t.label}
          </button>
        )
      })}
      <div className="flex-1" />
      {right}
    </div>
  )
}

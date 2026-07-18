import { Card, Eyebrow } from '../ui'

/** What the agent did NOT check, and why that's stated (Section 5 report schema). */
export function UnexploredBranches({ items }: { items: string[] }) {
  if (items.length === 0) return null
  return (
    <Card className="p-4">
      <Eyebrow>Unexplored branches</Eyebrow>
      <ul className="mt-2 flex flex-col gap-1.5">
        {items.map((u, i) => (
          <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-muted">
            <span className="text-subtle">—</span>
            {u}
          </li>
        ))}
      </ul>
    </Card>
  )
}

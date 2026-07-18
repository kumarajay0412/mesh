import { Card, Eyebrow } from '../ui'

/** Description only — the fix itself always goes through the gated fix session (Section 10). */
export function SuggestedFix({ text }: { text: string }) {
  return (
    <Card className="p-4">
      <Eyebrow>Suggested fix · description only</Eyebrow>
      <p className="mt-2 text-[13.5px] leading-relaxed text-txt">{text}</p>
    </Card>
  )
}

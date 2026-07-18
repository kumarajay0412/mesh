import { useState } from 'react'
import { Button } from '../ui'

/** Pinned steering box: send a mid-flight course correction, interrupt, or abandon. */
export function SteeringInput({
  onSteer,
  onInterrupt,
  onAbandon,
  disabled,
}: {
  onSteer: (text: string) => void
  onInterrupt: () => void
  onAbandon: () => void
  disabled?: boolean
}) {
  const [text, setText] = useState('')
  const send = () => {
    const t = text.trim()
    if (!t) return
    onSteer(t)
    setText('')
  }
  return (
    <div className="border-t border-line bg-ink-850 p-3">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder='Steer the agent — e.g. "no, check the ingress logs instead"'
          rows={2}
          className="no-drag min-h-[38px] flex-1 resize-none rounded-sm border border-line bg-[color:var(--ada-field-bg)] px-3 py-2 text-[13px] text-txt placeholder:text-subtle outline-none focus:border-gold-600"
        />
        <div className="flex flex-col gap-1.5">
          <Button variant="primary" onClick={send} disabled={disabled || !text.trim()}>
            Steer
          </Button>
          <div className="flex gap-1.5">
            <Button variant="ghost" onClick={onInterrupt} disabled={disabled} className="flex-1 !px-2 !text-[12px]">
              Interrupt
            </Button>
            <Button variant="ghost" danger onClick={onAbandon} className="flex-1 !px-2 !text-[12px]">
              Abandon
            </Button>
          </div>
        </div>
      </div>
      <div className="mt-1.5 font-mono text-[10px] text-subtle">enter to send · shift+enter for newline · agent is read-only</div>
    </div>
  )
}

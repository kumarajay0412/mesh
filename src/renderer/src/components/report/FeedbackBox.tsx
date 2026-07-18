import { useState } from 'react'
import { Button, Card, Eyebrow, TextArea } from '../ui'

/** Post-report feedback: verdict + correction, sent back INTO the session.
 *  The agent answers in the live timeline and may revise the report. */
export function FeedbackBox({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('')

  const send = (prefix?: string) => {
    const t = [prefix, text.trim()].filter(Boolean).join(' — ')
    if (!t) return
    onSend(t)
    setText('')
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <Eyebrow>Feedback · talk back to the agent</Eyebrow>
        <span className="font-mono text-[10px] text-subtle">resumes the session · may revise the report</span>
      </div>
      <TextArea
        rows={2}
        className="mt-3"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='"You anchored on the deploy — the OOM predates it. Check the batch size in settle-worker instead."'
      />
      <div className="mt-2.5 flex items-center gap-2">
        <Button variant="ghost" onClick={() => send('VERDICT: the report is CORRECT — confirmed in production.')}>
          ✓ Confirm right
        </Button>
        <Button variant="ghost" danger onClick={() => send('VERDICT: the report is WRONG.')}>
          ✗ Mark wrong
        </Button>
        <div className="flex-1" />
        <Button variant="primary" onClick={() => send()} disabled={!text.trim()}>
          Send to agent
        </Button>
      </div>
    </Card>
  )
}

import { useEffect } from 'react'
import { useApprovals } from '../../stores/approvals'
import { Button, Modal } from '../ui'

/**
 * THE trust pattern (Section 10): every mutating action blocks on this modal.
 * Mounted once, globally. Shows one request at a time, oldest first.
 * Deliberate friction — a description of exactly what will happen, the
 * payload preview, and an explicit Approve. Nothing here auto-confirms.
 */
export function ApprovalModal() {
  const { queue, init, respond } = useApprovals()

  useEffect(() => {
    void init()
  }, [init])

  const req = queue[0]
  if (!req) return null

  return (
    <Modal open width={520}>
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md" style={{ background: 'rgba(245,197,24,0.12)', border: '1px solid var(--ada-gold-600)' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--ada-gold-400)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z" />
          </svg>
        </span>
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-widest text-gold-600">approval required</div>
          <div className="truncate font-display text-[17px] font-semibold text-txt">{req.title}</div>
        </div>
        {queue.length > 1 && <span className="ml-auto shrink-0 font-mono text-[11px] text-subtle">+{queue.length - 1} queued</span>}
      </div>

      <div className="px-5 py-4">
        <p className="text-[13px] leading-relaxed text-muted">{req.description}</p>
        <div className="mt-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">what will happen</div>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded-sm border border-line bg-ink-900 p-3 font-mono text-[11.5px] leading-relaxed text-muted">{req.payloadPreview}</pre>
        </div>
        <div className="mt-2.5 flex items-center gap-2 font-mono text-[10px] text-subtle">
          <span>tool: {req.tool}</span>
          {req.investigationId && (
            <>
              <span className="text-ink-500">·</span>
              <span>{req.investigationId}</span>
            </>
          )}
          <div className="flex-1" />
          <span>unanswered = denied</span>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3.5">
        <Button variant="ghost" danger onClick={() => void respond(req.id, false, 'denied by user')}>
          Deny
        </Button>
        <Button variant="primary" onClick={() => void respond(req.id, true)}>
          Approve this action
        </Button>
      </div>
    </Modal>
  )
}

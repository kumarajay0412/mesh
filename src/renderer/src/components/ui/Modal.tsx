import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

export function Modal({
  open,
  onClose,
  children,
  width = 520,
}: {
  open: boolean
  onClose?: () => void
  children: ReactNode
  width?: number
}) {
  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center p-6"
      style={{ background: 'rgba(6,6,6,0.72)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.()
      }}
    >
      <div
        className="max-h-[80vh] w-full overflow-y-auto rounded-lg border border-line-strong bg-ink-850"
        style={{ maxWidth: width, boxShadow: 'var(--ada-shadow-3)' }}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}

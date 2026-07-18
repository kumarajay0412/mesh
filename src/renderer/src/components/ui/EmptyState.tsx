import type { ReactNode } from 'react'

export function EmptyState({ title, note, action }: { title: string; note: string; action?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-line bg-surface px-8 py-14 text-center">
      <div className="max-w-md">
        <div className="mx-auto mb-4 grid h-10 w-10 place-items-center rounded-md border border-line-strong text-gold-400">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="text-[15px] font-medium text-txt">{title}</div>
        <p className="mt-1.5 text-[13px] text-muted">{note}</p>
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  )
}

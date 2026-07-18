import type { ConnectionInfo } from '@shared/types'
import { Button, Dot, Pill } from '../ui'

const TONE = { connected: 'ok', pending: 'warn', error: 'danger', 'needs-connection': 'warn' } as const
const LABEL = { connected: 'Connected', pending: 'Pending', error: 'Error', 'needs-connection': 'Not connected' } as const
const DOT = { connected: 'ok', pending: 'warn', error: 'danger', 'needs-connection': 'warn' } as const

export function ConnectionCard({ conn, onManage }: { conn: ConnectionInfo; onManage: () => void }) {
  return (
    <div
      className="flex items-center gap-4 rounded-md border border-line bg-surface px-4 py-3.5"
      style={{ boxShadow: 'var(--ada-shadow-1)' }}
    >
      <div className="grid h-9 w-9 place-items-center rounded-md border border-line-strong font-display text-[13px] font-semibold text-muted">
        {conn.name[0]}
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-txt">{conn.name}</span>
          {conn.requiredFirst && <Pill tone="gold">required first</Pill>}
        </div>
        <div className="font-mono text-[11px] text-subtle">{conn.detail}</div>
      </div>
      <div className="flex-1" />
      <Pill tone={TONE[conn.status]}>
        <Dot tone={DOT[conn.status]} />
        {LABEL[conn.status]}
      </Pill>
      <Button variant={conn.status === 'connected' ? 'quiet' : 'ghost'} onClick={onManage}>
        {conn.status === 'connected' ? 'Manage' : 'Connect'}
      </Button>
    </div>
  )
}

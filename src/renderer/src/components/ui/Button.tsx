import type { ReactNode } from 'react'

export function Button({
  children,
  variant = 'ghost',
  onClick,
  disabled,
  danger,
  type = 'button',
  className = '',
}: {
  children: ReactNode
  variant?: 'primary' | 'ghost' | 'quiet'
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  type?: 'button' | 'submit'
  className?: string
}) {
  const base =
    'no-drag inline-flex items-center justify-center gap-2 rounded-sm px-3.5 py-1.5 text-[13px] font-medium transition-colors duration-100 cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed'
  const styles: Record<string, string> = {
    primary: danger
      ? 'bg-danger text-white hover:brightness-95'
      : 'bg-accent text-accent-ink hover:brightness-95',
    ghost: danger
      ? 'border border-[color:var(--ada-danger)]/50 text-danger hover:bg-raised'
      : 'border border-line-strong text-txt hover:bg-raised',
    quiet: 'text-muted hover:text-txt hover:bg-raised',
  }
  return (
    <button type={type} className={`${base} ${styles[variant]} ${className}`} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

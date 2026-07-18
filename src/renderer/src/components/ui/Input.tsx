import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

const FIELD =
  'no-drag w-full rounded-sm border border-line bg-[color:var(--ada-field-bg)] px-3 py-2 text-[13px] text-txt placeholder:text-subtle outline-none transition-colors focus:border-gold-600'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props
  return <input {...rest} className={`${FIELD} ${className}`} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props
  return <textarea {...rest} className={`${FIELD} resize-none ${className}`} />
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-muted">{label}</span>
        {hint && <span className="font-mono text-[10px] text-subtle">{hint}</span>}
      </div>
      {children}
    </label>
  )
}

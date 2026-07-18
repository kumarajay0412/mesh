import { useEffect, useState } from 'react'

/** Debounced free-text search over incident memory. */
export function SearchBar({ onSearch, searching }: { onSearch: (q: string) => void; searching: boolean }) {
  const [value, setValue] = useState('')

  useEffect(() => {
    const t = setTimeout(() => {
      if (value.trim()) onSearch(value)
    }, 300)
    return () => clearTimeout(t)
  }, [value, onSearch])

  return (
    <div className="relative">
      <svg
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2"
        width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--ada-gray-600)" strokeWidth="2" strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </svg>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder='Describe a symptom — "pods dying during settlement", "502 from ingress"…'
        className="no-drag w-full rounded-md border border-line bg-[color:var(--ada-field-bg)] py-2.5 pl-9 pr-10 text-[13.5px] text-txt placeholder:text-subtle outline-none transition-colors focus:border-gold-600"
      />
      {searching && (
        <svg className="absolute right-3 top-1/2 -translate-y-1/2" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--ada-gold-400)" strokeWidth="2.4" style={{ animation: 'meshSpin 1.2s linear infinite' }}>
          <path d="M21 12a9 9 0 11-6.2-8.56" strokeLinecap="round" />
        </svg>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { SourceId } from '@shared/types'
import { getApi } from '../../lib/api'
import { Button, Pill } from '../ui'
import { TOKEN_GUIDES } from './token-guides'

/** "Where do I get this token?" answered inline, next to the field that wants
 *  it — collapsed by default so a returning user isn't reading setup docs, but
 *  open on first visit when there's nothing connected yet.
 *
 *  Scopes are the point: a wrong scope is the overwhelmingly common failure,
 *  and it fails at sync time with a provider error rather than at paste time. */
export function TokenGuide({ source, url, defaultOpen }: { source: SourceId; url?: string; defaultOpen?: boolean }) {
  const g = TOKEN_GUIDES[source]
  const [open, setOpen] = useState(Boolean(defaultOpen))
  const [copied, setCopied] = useState<string | null>(null)
  const target = url ?? g.url

  if (!g) return null

  return (
    <div className="rounded-md border border-line bg-ink-900">
      <button
        onClick={() => setOpen((o) => !o)}
        className="no-drag flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line font-mono text-[10px] text-gold-400">?</span>
        <span className="flex-1 text-[12.5px] font-medium text-txt">How to generate this token</span>
        <span className="font-mono text-[10px] text-subtle">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
          <div className="font-mono text-[11px] leading-relaxed text-subtle">{g.where}</div>

          <ol className="flex flex-col gap-1.5 pl-4 text-[12.5px] leading-relaxed text-muted">
            {g.steps.map((s, i) => (
              <li key={i} className="list-decimal">
                {s}
              </li>
            ))}
          </ol>

          {g.scopes && g.scopes.length > 0 && (
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">required scopes</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {g.scopes.map((s) => (
                  <button
                    key={s}
                    title="click to copy"
                    onClick={() => {
                      void navigator.clipboard?.writeText(s)
                      setCopied(s)
                      setTimeout(() => setCopied((c) => (c === s ? null : c)), 1200)
                    }}
                    className="no-drag rounded-sm border border-line bg-ink-850 px-2 py-0.5 font-mono text-[11px] text-muted hover:border-line-strong hover:text-txt"
                  >
                    {copied === s ? 'copied' : s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {g.looksLike && (
            <div className="text-[12px] text-subtle">
              The token should look like <span className="font-mono text-muted">{g.looksLike}</span>
            </div>
          )}

          {g.caveat && <p className="text-[12px] leading-relaxed text-subtle">{g.caveat}</p>}

          {target ? (
            <Button
              variant="ghost"
              onClick={() => void getApi().then((a) => a.openExternal(target))}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
              </svg>
              {g.urlLabel ?? 'Open'}
            </Button>
          ) : (
            <Pill tone="neutral">enter your URL above to open the right page</Pill>
          )}
        </div>
      )}
    </div>
  )
}

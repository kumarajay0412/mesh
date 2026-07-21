import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getApi } from '../../lib/api'
import { useTerminal } from '../../stores/terminal'
import { Button } from '../ui'

/** A real terminal, docked on the right. Opened by user action only — the
 *  agent has no route to it (see src/main/terminal/pty.ts). Interactive
 *  logins (`gcloud auth login`, `claude auth login`) need a genuine TTY, which
 *  is why this exists rather than streamed command output. */

/** Pull a design token off :root so the terminal tracks the app's theme —
 *  hardcoding dark would break the light theme outright. */
function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function buildTheme(): ITheme {
  const bg = token('--ada-ink-900', '#0e0e0e')
  const fg = token('--ada-text', '#dcdcda')
  const accent = token('--ada-gold-400', '#f5c518')
  const teal = token('--ada-accent-teal', '#4ec9b0')
  const muted = token('--ada-text-muted', '#b4b4b4')
  return {
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: 'rgba(245,197,24,0.22)',
    // Keep the ANSI set close to the product palette so command output
    // (git, kubectl, gcloud) doesn't clash with the rest of the app.
    black: bg,
    brightBlack: muted,
    red: '#e06c62',
    brightRed: '#f08078',
    green: teal,
    brightGreen: teal,
    yellow: accent,
    brightYellow: accent,
    blue: '#6fa8dc',
    brightBlue: '#8ab8e6',
    magenta: '#c58fd6',
    brightMagenta: '#d5a5e2',
    cyan: teal,
    brightCyan: teal,
    white: fg,
    brightWhite: '#ffffff',
  }
}

const WIDTH_KEY = 'mesh.terminal.width'
const MIN_W = 380
const MAX_W = 1100

export function TerminalDrawer() {
  const { open, sessionId, title, command, error, close } = useTerminal()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [exited, setExited] = useState(false)
  // Drag-to-resize, persisted — a fixed 46vw is far too much black on a wide
  // display and far too little on a laptop.
  const [width, setWidth] = useState(() => {
    const saved = Number(localStorage.getItem(WIDTH_KEY))
    return saved >= MIN_W && saved <= MAX_W ? saved : 560
  })
  const [dragging, setDragging] = useState(false)
  const widthRef = useRef(width)
  widthRef.current = width

  /** Bind the drag listeners synchronously on mousedown. Registering them from
   *  an effect keyed on `dragging` would miss a gesture that completes before
   *  React re-renders — a fast flick resizes nothing. */
  const startDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - ev.clientX))
      widthRef.current = next
      setWidth(next)
    }
    const onUp = () => {
      setDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      // Persist from a ref, not inside a state updater — updaters are invoked
      // twice under StrictMode and must stay side-effect free.
      localStorage.setItem(WIDTH_KEY, String(widthRef.current))
    }
    // Don't let the drag select text or flip the cursor mid-gesture.
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  // Create the xterm instance once the drawer is mounted.
  useEffect(() => {
    if (!open || !hostRef.current || termRef.current) return
    const term = new Terminal({
      // A literal stack, not var(--ada-font-mono): xterm measures cell size to
      // lay out the grid, and the measurement path can't resolve CSS custom
      // properties — a var() here risks a grid that doesn't match the glyphs.
      // Keep in sync with --ada-font-mono in styles/tokens.css.
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35, // xterm defaults to 1.0, which reads as cramped
      letterSpacing: 0.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      convertEol: true,
      scrollback: 5000,
      drawBoldTextInBrightColors: false,
      theme: buildTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    // Follow app theme switches instead of freezing at whatever was active.
    const obs = new MutationObserver(() => {
      term.options.theme = buildTheme()
    })
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ada-theme'] })

    return () => {
      obs.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [open])

  const doFit = useCallback((id: string) => {
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    try {
      fit.fit()
    } catch {
      return // container mid-transition; the next resize will settle it
    }
    void getApi().then((api) => api.ptyResize(id, term.cols, term.rows))
  }, [])

  // Bind the live session: replay scrollback, stream data, forward keystrokes.
  useEffect(() => {
    const term = termRef.current
    if (!open || !term || !sessionId) return
    let disposed = false
    let offData: (() => void) | undefined
    let offExit: (() => void) | undefined
    setExited(false)

    void (async () => {
      const api = await getApi()
      const back = await api.ptyScrollback(sessionId)
      if (disposed) return
      if (back) term.write(back)
      offData = api.onPtyData(({ id, chunk }) => {
        if (id === sessionId) term.write(chunk)
      })
      offExit = api.onPtyExit(({ id }) => {
        if (id === sessionId) setExited(true)
      })
      term.focus()
    })()

    const keys = term.onData((d) => {
      void getApi().then((api) => api.ptyWrite(sessionId, d))
    })

    const onWinResize = () => doFit(sessionId)
    doFit(sessionId)
    window.addEventListener('resize', onWinResize)
    // The drawer itself can change size independently of the window.
    const ro = new ResizeObserver(() => doFit(sessionId))
    if (hostRef.current) ro.observe(hostRef.current)

    return () => {
      disposed = true
      offData?.()
      offExit?.()
      keys.dispose()
      ro.disconnect()
      window.removeEventListener('resize', onWinResize)
    }
  }, [open, sessionId, doFit])

  if (!open) return null

  return (
    <aside
      className="fixed right-0 top-0 z-40 flex h-full flex-col border-l border-line-strong bg-ink-850"
      style={{ width, boxShadow: '-24px 0 48px -24px rgba(0,0,0,0.7)' }}
    >
      {/* drag handle — sits on the left edge, widens on hover so it's findable */}
      <div
        onMouseDown={startDrag}
        className={`absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize transition-colors ${
          dragging ? 'bg-gold-400/40' : 'hover:bg-gold-400/20'
        }`}
        title="Drag to resize"
      />

      {/* chrome */}
      <header className="flex items-center gap-2.5 px-3.5 py-3">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-sm border border-line bg-ink-900 font-mono text-[10px] leading-none text-gold-400">
          ›_
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[13px] font-semibold leading-tight text-txt">{title}</div>
          <div className="truncate font-mono text-[10px] leading-tight text-subtle">
            {command ?? 'interactive shell'}
          </div>
        </div>
        <span
          className={`mr-1 h-1.5 w-1.5 shrink-0 rounded-full ${exited ? 'bg-[color:var(--ada-text-subtle)]' : 'bg-[color:var(--ada-success)]'}`}
          title={exited ? 'session ended' : 'running'}
        />
        <Button variant="quiet" onClick={() => void close()}>
          Close
        </Button>
      </header>

      {/* the terminal surface — inset and bordered so it reads as its own
          plane rather than a black void bleeding into the drawer chrome */}
      <div className="min-h-0 flex-1 px-3 pb-3">
        {error ? (
          <div className="rounded-md border border-[color:var(--ada-danger)]/40 bg-ink-900 px-3 py-2.5 text-[12.5px] leading-relaxed text-muted">
            {error}
          </div>
        ) : (
          <div
            className="mesh-term relative h-full overflow-hidden rounded-md border border-line bg-ink-900"
            // While resizing, the pointer sweeps across the terminal — without
            // this it starts a text selection instead of just resizing.
            style={dragging ? { pointerEvents: 'none' } : undefined}
          >
            <div ref={hostRef} className="h-full w-full" />
            {exited && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 border-t border-line bg-ink-850/95 px-3 py-1.5 font-mono text-[10px] text-subtle">
                session ended · ⌘J to open a new one
              </div>
            )}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line px-3.5 py-2 font-mono text-[10px] text-subtle">
        <span>{exited ? 'exited' : 'your shell'}</span>
        <span className="opacity-40">·</span>
        <span className="truncate">not read or stored by Mesh</span>
      </footer>
    </aside>
  )
}

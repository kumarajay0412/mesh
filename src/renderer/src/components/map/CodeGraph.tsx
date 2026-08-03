import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeGraphRepo, CodeGraphViewData } from '@shared/types'
import { getApi } from '../../lib/api'
import { timeAgo } from '../../lib/format'
import { Button, EmptyState, Input, Pill } from '../ui'

/** The Code graph tab — graphify's per-repo knowledge graph, rendered natively.
 *
 *  The main process serves a TRIMMED subgraph (top-N by degree, or a BFS
 *  neighborhood around the search); this component only lays out and draws.
 *  Layout is a deterministic community ring — communities on a circle, members
 *  ringed around their hub — so the same view always looks the same, with no
 *  force-sim jitter and no graph library.
 *
 *  Community colors are the dataviz reference categorical theme, validated on
 *  both Mesh surfaces (8 slots; further communities fold to gray "other").
 *  Identity is never color-alone: membership is also POSITION (the cluster)
 *  and the legend carries text labels. */

const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']
const OTHER = 'var(--ada-gray-500)'

const W = 1200
const H = 800

interface Laid {
  id: string
  x: number
  y: number
  r: number
  color: string
  label: string
  degree: number
  communityName: string
  file?: string
}

function useTheme(): 'dark' | 'light' {
  const [t, setT] = useState<'dark' | 'light'>(() => (document.documentElement.getAttribute('data-ada-theme') === 'light' ? 'light' : 'dark'))
  useEffect(() => {
    const obs = new MutationObserver(() => setT(document.documentElement.getAttribute('data-ada-theme') === 'light' ? 'light' : 'dark'))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ada-theme'] })
    return () => obs.disconnect()
  }, [])
  return t
}

/** Deterministic community-ring layout. Communities ordered by size (slot
 *  order = color order, fixed — a filter never repaints survivors), placed on
 *  a circle around the canvas center; members ring their community hub. */
/** Readable fallback name for a numeric community: the dominant source
 *  directory among its members. graphify's --code-only pass numbers
 *  communities but does not name them (naming is the semantic pass), and
 *  "community 7" tells the reader nothing — "capture/" does. */
function dirName(members: { file?: string }[]): string | null {
  const counts = new Map<string, number>()
  for (const m of members) {
    if (!m.file) continue
    const seg = m.file.replace(/^\.\//, '').split('/')
    const dir = seg.length < 2 ? '.' : seg[0] === 'src' && seg.length > 2 ? `src/${seg[1]}` : seg[0]
    counts.set(dir, (counts.get(dir) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const [dir, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return n >= members.length / 2 ? `${dir}/` : null // only when it truly dominates
}

function layout(view: CodeGraphViewData, palette: string[]): { placed: Map<string, Laid>; legend: { name: string; color: string; count: number }[] } {
  const byCommunity = new Map<string, typeof view.nodes>()
  const numbered = new Map<number, typeof view.nodes>()
  for (const n of view.nodes) {
    if (n.communityName === undefined && n.community !== undefined) {
      ;(numbered.get(n.community) ?? numbered.set(n.community, []).get(n.community)!).push(n)
      continue
    }
    const key = n.communityName ?? 'ungrouped'
    ;(byCommunity.get(key) ?? byCommunity.set(key, []).get(key)!).push(n)
  }
  for (const [num, members] of numbered) {
    const key = dirName(members) ?? `community ${num}`
    for (const m of members) (byCommunity.get(key) ?? byCommunity.set(key, []).get(key)!).push(m)
  }
  const groups = [...byCommunity.entries()].sort((a, b) => b[1].length - a[1].length)
  const cx = W / 2
  const cy = H / 2
  const R = Math.min(W, H) / 2 - 150
  const maxDeg = Math.max(1, ...view.nodes.map((n) => n.degree))

  const placed = new Map<string, Laid>()
  const legend: { name: string; color: string; count: number }[] = []
  groups.forEach(([name, members], gi) => {
    const color = gi < palette.length ? palette[gi] : OTHER
    legend.push({ name, color, count: members.length })
    const angle = (gi / groups.length) * 2 * Math.PI - Math.PI / 2
    const gx = groups.length === 1 ? cx : cx + R * Math.cos(angle)
    const gy = groups.length === 1 ? cy : cy + R * Math.sin(angle)
    // hub first (highest degree), rest in rings of growing capacity
    const sorted = [...members].sort((a, b) => b.degree - a.degree)
    sorted.forEach((n, i) => {
      let x = gx
      let y = gy
      if (i > 0) {
        // ring k holds 6k nodes: i ∈ [1+3(k-1)k … ] — walk rings until placed
        let k = 1
        let start = 1
        while (i >= start + 6 * k) {
          start += 6 * k
          k++
        }
        const slot = i - start
        const a = (slot / (6 * k)) * 2 * Math.PI + gi // gi offsets rings so clusters don't align
        x = gx + 34 * k * Math.cos(a)
        y = gy + 34 * k * Math.sin(a)
      }
      placed.set(n.id, {
        id: n.id,
        x,
        y,
        r: 5 + 11 * Math.sqrt(n.degree / maxDeg),
        color,
        label: n.label,
        degree: n.degree,
        communityName: name,
        file: n.file,
      })
    })
  })
  return { placed, legend }
}

export function CodeGraph() {
  const [repos, setRepos] = useState<CodeGraphRepo[] | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [view, setViewData] = useState<CodeGraphViewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [focus, setFocus] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cam, setCam] = useState({ x: 0, y: 0, zoom: 1 })
  const dragging = useRef<{ x: number; y: number } | null>(null)
  const theme = useTheme()
  const palette = theme === 'light' ? LIGHT : DARK

  useEffect(() => {
    void getApi()
      .then((a) => a.listCodeGraphs())
      .then((r) => {
        setRepos(r)
        if (r.length > 0) setRepo((cur) => cur ?? r[0].repo)
      })
      .catch(() => setRepos([]))
  }, [])

  const load = useCallback(async (r: string, f?: string) => {
    setBusy(true)
    setSelected(null)
    const api = await getApi()
    const res = await api.viewCodeGraph(r, f || undefined)
    setBusy(false)
    if ('error' in res) {
      setError(res.error)
      setViewData(null)
    } else {
      setError(null)
      setViewData(res)
      setCam({ x: 0, y: 0, zoom: 1 })
    }
  }, [])

  useEffect(() => {
    if (repo) void load(repo)
  }, [repo, load])

  const { placed, legend } = useMemo(
    () => (view ? layout(view, palette) : { placed: new Map<string, Laid>(), legend: [] }),
    [view, palette],
  )

  const sel = selected ? placed.get(selected) : null
  const selEdges = useMemo(
    () => (view && selected ? view.edges.filter((e) => e.source === selected || e.target === selected) : []),
    [view, selected],
  )
  const neighbor = useMemo(() => {
    const s = new Set<string>()
    for (const e of selEdges) {
      s.add(e.source)
      s.add(e.target)
    }
    return s
  }, [selEdges])

  if (repos !== null && repos.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          title="No code graphs yet"
          note="Install graphify (uv tool install graphifyy) and run a repos sync — every service-mapped repo gets a queryable graph, built locally by AST parsing. This tab then shows it."
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* controls — one row above the chart */}
        <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
          <select
            className="no-drag rounded-sm border border-line bg-ink-900 px-2 py-1.5 font-mono text-[12px] text-txt"
            value={repo ?? ''}
            onChange={(e) => setRepo(e.target.value)}
          >
            {(repos ?? []).map((r) => (
              <option key={r.repo} value={r.repo}>
                {r.repo}
              </option>
            ))}
          </select>
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (repo) void load(repo, focus)
            }}
          >
            <Input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder='focus a symbol — "settle", "RateLimiter"…' className="min-w-0 flex-1" />
            <Button variant="ghost" type="submit" disabled={busy || !repo}>
              {busy ? 'Loading…' : focus ? 'Focus' : 'Top nodes'}
            </Button>
          </form>
          {view && (
            <span className="shrink-0 whitespace-nowrap font-mono text-[11px] text-subtle">
              {view.nodes.length} / {view.totals.nodes.toLocaleString('en-US')} nodes · {view.totals.communities} communities
              {view.builtAtCommit ? ` · @${view.builtAtCommit.slice(0, 7)}` : ''}
              {(() => {
                const built = repos?.find((r) => r.repo === view.repo)?.builtAt
                return built ? ` · built ${timeAgo(built)}` : ''
              })()}
            </span>
          )}
        </div>

        {/* legend — text labels carry identity, color reinforces */}
        {legend.length > 1 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-1.5">
            {legend.slice(0, DARK.length).map((c) => (
              <span key={c.name} className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
                {c.name} <span className="text-subtle">({c.count})</span>
              </span>
            ))}
            {legend.length > DARK.length && (
              <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-subtle" title={legend.slice(DARK.length).map((c) => `${c.name} (${c.count})`).join(' · ')}>
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: OTHER }} />
                +{legend.length - DARK.length} more ({legend.slice(DARK.length).reduce((s, c) => s + c.count, 0)})
              </span>
            )}
            <span className="flex items-center gap-1.5 font-mono text-[10.5px] text-subtle">
              <svg width="18" height="6">
                <line x1="0" y1="3" x2="18" y2="3" stroke="currentColor" strokeDasharray="3 3" />
              </svg>
              inferred edge
            </span>
          </div>
        )}

        {error && <div className="border-b border-line px-5 py-2 font-mono text-[11.5px] text-danger">{error}</div>}

        <div
          className="min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
          onWheel={(e) => setCam((v) => ({ ...v, zoom: Math.min(3, Math.max(0.35, v.zoom * (e.deltaY > 0 ? 0.92 : 1.08))) }))}
          onMouseDown={(e) => (dragging.current = { x: e.clientX, y: e.clientY })}
          onMouseUp={() => (dragging.current = null)}
          onMouseLeave={() => (dragging.current = null)}
          onMouseMove={(e) => {
            if (!dragging.current) return
            const dx = (e.clientX - dragging.current.x) / cam.zoom
            const dy = (e.clientY - dragging.current.y) / cam.zoom
            dragging.current = { x: e.clientX, y: e.clientY }
            setCam((v) => ({ ...v, x: v.x - dx, y: v.y - dy }))
          }}
        >
          <svg width="100%" height="100%" viewBox={`${cam.x} ${cam.y} ${W / cam.zoom} ${H / cam.zoom}`}>
            {/* edges under nodes; dim to context when a node is selected */}
            {view?.edges.map((e, i) => {
              const a = placed.get(e.source)
              const b = placed.get(e.target)
              if (!a || !b) return null
              const hot = selected && (e.source === selected || e.target === selected)
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={hot ? 'var(--ada-gold-400)' : 'var(--ada-text-subtle)'}
                  strokeWidth={hot ? 1.8 : 0.7}
                  strokeDasharray={e.confidence === 'INFERRED' ? '3 3' : undefined}
                  opacity={selected ? (hot ? 0.95 : 0.06) : 0.3}
                />
              )
            })}
            {/* nodes — 2px surface ring separates overlapping marks */}
            {[...placed.values()].map((n) => {
              const isFocus = view?.focusIds.includes(n.id)
              const active = selected === n.id
              const dimmed = selected && !active && !neighbor.has(n.id)
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  opacity={dimmed ? 0.25 : 1}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setSelected((s) => (s === n.id ? null : n.id))
                  }}
                >
                  <circle r={n.r + 2} fill="var(--ada-ink-900)" />
                  <circle r={n.r} fill={n.color} stroke={active || isFocus ? 'var(--ada-gold-400)' : 'var(--ada-ink-900)'} strokeWidth={active ? 3 : isFocus ? 2.5 : 1} />
                  <title>{`${n.label} · ${n.communityName} · degree ${n.degree}${n.file ? ` · ${n.file}` : ''}`}</title>
                </g>
              )
            })}
            {/* labels last — always above circles */}
            {[...placed.values()]
              .filter((n) => n.degree > 6 || selected === n.id || view?.focusIds.includes(n.id))
              .map((n) => (
                <text
                  key={`t-${n.id}`}
                  x={n.x}
                  y={n.y - n.r - 6}
                  textAnchor="middle"
                  fontSize="10.5"
                  fontFamily="ui-monospace, monospace"
                  fill="var(--ada-text)"
                  stroke="var(--ada-ink-900)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  pointerEvents="none"
                  opacity={selected && selected !== n.id && !neighbor.has(n.id) ? 0.25 : 1}
                >
                  {n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label}
                </text>
              ))}
          </svg>
        </div>
      </div>

      {/* detail panel */}
      {sel && view && (
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-ink-850">
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-txt">{sel.label}</span>
              <button className="no-drag font-mono text-[11px] text-subtle hover:text-muted" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              <Pill tone="neutral">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: sel.color }} /> {sel.communityName}
              </Pill>
              <Pill tone="neutral">degree {sel.degree}</Pill>
            </div>
            {sel.file && <div className="mt-1.5 truncate font-mono text-[10.5px] text-subtle">{sel.file}</div>}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">edges ({selEdges.length})</div>
              <div className="mt-1.5 flex flex-col gap-1">
                {selEdges.slice(0, 40).map((e, i) => {
                  const out = e.source === sel.id
                  const other = placed.get(out ? e.target : e.source)
                  return (
                    <div key={i} className="flex items-baseline gap-1.5 font-mono text-[11px] leading-relaxed text-muted">
                      <span className="text-subtle">{out ? '→' : '←'}</span>
                      <button className="no-drag min-w-0 truncate text-left hover:text-txt" onClick={() => other && setSelected(other.id)}>
                        {other?.label ?? (out ? e.target : e.source)}
                      </button>
                      {e.relation && <span className="text-subtle">{e.relation}</span>}
                      {e.confidence === 'INFERRED' && <span className="text-[9px] uppercase text-subtle">inf</span>}
                    </div>
                  )
                })}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">ask the graph</div>
              <div
                className="mt-1.5 select-all rounded-sm border border-line bg-ink-900 px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-muted"
                title="the same query the agent runs during investigations"
              >
                graphify explain "{sel.label}" --graph {view.repo}/graphify-out/graph.json
              </div>
            </div>
          </div>
        </aside>
      )}
    </div>
  )
}

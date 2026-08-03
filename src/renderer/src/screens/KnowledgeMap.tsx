import { useEffect, useMemo, useRef, useState } from 'react'
import type { MapEdge, MapNode, MapNodeKind } from '@shared/types'
import { getApi } from '../lib/api'
import { Button, Modal, Pill, TextArea } from '../components/ui'
import { ContextPanel } from '../components/map/ContextPanel'
import { CodeGraph } from '../components/map/CodeGraph'

// Layered layout: data flows left → right, the way the org actually flows.
const COLUMNS: MapNodeKind[][] = [['frontend'], ['edge'], ['backend'], ['ml'], ['external', 'datastore'], ['infra']]
const COL_W = 240
const ROW_H = 92
const NODE_W = 186
const NODE_H = 56

const KIND_COLOR: Record<MapNodeKind, string> = {
  frontend: 'var(--ada-gold-400)',
  edge: 'var(--ada-accent-sky)',
  backend: 'var(--ada-accent-teal)',
  ml: 'var(--ada-accent-plum)',
  external: 'var(--ada-gray-500)',
  datastore: 'var(--ada-warning)',
  infra: 'var(--ada-gray-600)',
}

const EDGE_COLOR: Record<MapEdge['kind'], string> = {
  ws: 'var(--ada-gold-500)',
  graphql: 'var(--ada-accent-teal)',
  http: 'var(--ada-gray-500)',
  queue: 'var(--ada-accent-plum)',
  db: 'var(--ada-warning)',
  deploys: 'var(--ada-gray-700)',
  observes: 'var(--ada-gray-700)',
  other: 'var(--ada-gray-600)',
}

interface Placed extends MapNode {
  x: number
  y: number
}

export function KnowledgeMap() {
  const [nodes, setNodes] = useState<MapNode[]>([])
  const [edges, setEdges] = useState<MapEdge[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [showInfra, setShowInfra] = useState(false)
  const [notes, setNotes] = useState('')
  const [view, setView] = useState({ x: -40, y: -30, zoom: 1 })
  const dragging = useRef<{ x: number; y: number } | null>(null)

  // Universal seeding: paste YOUR architecture description, an LLM extracts
  // nodes + edges. Mesh ships with an empty map — no org baked in.
  const [seedOpen, setSeedOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [seedText, setSeedText] = useState('')
  const [seedBusy, setSeedBusy] = useState(false)
  const [seedError, setSeedError] = useState<string | null>(null)

  const runSeed = async () => {
    setSeedBusy(true)
    setSeedError(null)
    const api = await getApi()
    const res = await api.seedMapFromText(seedText)
    setSeedBusy(false)
    if (!res.ok) {
      setSeedError(res.message)
      return
    }
    setSeedOpen(false)
    setSeedText('')
    await load()
  }

  const load = async () => {
    const api = await getApi()
    const m = await api.getMap()
    setNodes(m.nodes)
    setEdges(m.edges)
  }

  useEffect(() => {
    void load()
  }, [])

  const placed = useMemo<Map<string, Placed>>(() => {
    const out = new Map<string, Placed>()
    COLUMNS.forEach((kinds, ci) => {
      const col = nodes.filter((n) => kinds.includes(n.kind))
      col.forEach((n, ri) => {
        out.set(n.id, { ...n, x: ci * COL_W + 20, y: ri * ROW_H + 20 + (ci % 2) * 24 })
      })
    })
    return out
  }, [nodes])

  const visibleEdges = edges.filter((e) => (showInfra ? true : e.kind !== 'deploys' && e.kind !== 'observes'))
  const proposed = edges.filter((e) => e.status === 'proposed')
  const sel = selected ? placed.get(selected) : null
  const selEdges = selected ? edges.filter((e) => e.from === selected || e.to === selected) : []

  const decide = async (id: number, accept: boolean) => {
    const api = await getApi()
    await api.decideMapEdge(id, accept)
    await load()
  }

  const saveNotes = async () => {
    if (!sel) return
    const api = await getApi()
    await api.saveMapNode({ ...sel, notes })
    await load()
  }

  const width = COLUMNS.length * COL_W + 60
  const height = Math.max(...[...placed.values()].map((p) => p.y + NODE_H), 400) + 40

  const [tab, setTab] = useState<'system' | 'code'>('system')

  if (tab === 'code') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <MapHeader tab={tab} onTab={setTab} subtitle="Per-repo code knowledge graphs · built by graphify, queried by the agent" />
        <CodeGraph />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">System topology · rides in every agent prompt</div>
            <h1 className="font-display text-[19px] font-semibold tracking-tight text-txt">Knowledge map</h1>
          </div>
          <TabSwitch tab={tab} onTab={setTab} />
          <div className="flex-1" />
          <Button variant="quiet" onClick={() => setContextOpen(true)}>
            What Mesh knows
          </Button>
          <Button variant="quiet" onClick={() => setSeedOpen(true)}>
            Seed from description
          </Button>
          <label className="flex items-center gap-2 font-mono text-[11px] text-subtle">
            <input type="checkbox" checked={showInfra} onChange={(e) => setShowInfra(e.target.checked)} className="no-drag accent-[#f5c518]" />
            deploy/observe edges
          </label>
          <span className="font-mono text-[11px] text-subtle">scroll = zoom · drag = pan · click a node</span>
        </div>

        {proposed.length > 0 && (
          <div className="border-b border-gold-600/40 bg-[rgba(245,197,24,0.05)] px-5 py-2.5">
            <div className="font-mono text-[10px] uppercase tracking-widest text-gold-600">
              {proposed.length} proposed map update{proposed.length > 1 ? 's' : ''} · discovered by investigations
            </div>
            <div className="mt-1.5 flex flex-col gap-1.5">
              {proposed.map((e) => (
                <div key={e.id} className="flex items-center gap-2.5">
                  <span className="font-mono text-[12px] text-txt">
                    {e.from} → {e.to}
                  </span>
                  {e.label && <span className="font-mono text-[11px] text-subtle">· {e.label}</span>}
                  <div className="flex-1" />
                  <Button variant="quiet" className="!px-2 !py-0.5 !text-[11px]" onClick={() => void decide(e.id, false)}>
                    Dismiss
                  </Button>
                  <Button variant="primary" className="!px-2.5 !py-0.5 !text-[11px]" onClick={() => void decide(e.id, true)}>
                    Accept into map
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {nodes.length === 0 && (
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-[440px] rounded-md border border-line bg-ink-900 p-6 text-center">
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">empty map</div>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
                Mesh ships knowing nothing about your org. Paste a plain-language description of your system — services, who
                calls whom — and the map extracts itself. Investigations propose additions from then on.
              </p>
              <Button variant="primary" className="mt-4" onClick={() => setSeedOpen(true)}>
                Seed from description
              </Button>
            </div>
          </div>
        )}

        <div
          className={`min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing ${nodes.length === 0 ? 'hidden' : ''}`}
          onWheel={(e) => setView((v) => ({ ...v, zoom: Math.min(2.2, Math.max(0.4, v.zoom * (e.deltaY > 0 ? 0.92 : 1.08))) }))}
          onMouseDown={(e) => (dragging.current = { x: e.clientX, y: e.clientY })}
          onMouseUp={() => (dragging.current = null)}
          onMouseLeave={() => (dragging.current = null)}
          onMouseMove={(e) => {
            if (!dragging.current) return
            const dx = (e.clientX - dragging.current.x) / view.zoom
            const dy = (e.clientY - dragging.current.y) / view.zoom
            dragging.current = { x: e.clientX, y: e.clientY }
            setView((v) => ({ ...v, x: v.x - dx, y: v.y - dy }))
          }}
        >
          <svg width="100%" height="100%" viewBox={`${view.x} ${view.y} ${width / view.zoom} ${height / view.zoom}`}>
            {/* edges */}
            {visibleEdges.map((e) => {
              const a = placed.get(e.from)
              const b = placed.get(e.to)
              if (!a || !b) return null
              const x1 = a.x + NODE_W
              const y1 = a.y + NODE_H / 2
              const x2 = b.x
              const y2 = b.y + NODE_H / 2
              const back = x2 < x1 // reverse-direction edge (e.g. toward frontend column)
              const midX = (x1 + x2) / 2
              const d = back
                ? `M ${a.x} ${y1} C ${a.x - 60} ${y1}, ${b.x + NODE_W + 60} ${y2}, ${b.x + NODE_W} ${y2}`
                : `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`
              const hot = selected && (e.from === selected || e.to === selected)
              const isProposed = e.status === 'proposed'
              return (
                <g key={e.id} opacity={selected ? (hot ? 1 : 0.15) : 0.85}>
                  <path
                    d={d}
                    fill="none"
                    stroke={isProposed ? 'var(--ada-gold-400)' : EDGE_COLOR[e.kind]}
                    strokeWidth={hot ? 2.2 : isProposed ? 1.8 : 1.3}
                    strokeDasharray={isProposed ? '6 4' : e.kind === 'deploys' || e.kind === 'observes' ? '4 4' : undefined}
                  />
                  {e.label && (
                    <text x={back ? (a.x + b.x + NODE_W) / 2 : midX} y={(y1 + y2) / 2 - 5} textAnchor="middle" fontSize="8.5" fontFamily="ui-monospace, monospace" fill="var(--ada-text-subtle)">
                      {e.label}
                    </text>
                  )}
                </g>
              )
            })}
            {/* nodes */}
            {[...placed.values()].map((n) => {
              const active = selected === n.id
              return (
                <g
                  key={n.id}
                  transform={`translate(${n.x},${n.y})`}
                  className="cursor-pointer"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    setSelected(n.id)
                    setNotes(n.notes ?? '')
                  }}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx="10"
                    fill="var(--ada-surface)"
                    stroke={active ? 'var(--ada-gold-400)' : KIND_COLOR[n.kind]}
                    strokeWidth={active ? 2.2 : 1.2}
                    opacity={selected && !active && !selEdges.some((e) => e.from === n.id || e.to === n.id) ? 0.35 : 1}
                  />
                  <text x="12" y="24" fontSize="12" fontWeight="600" fill="var(--ada-text)" fontFamily="var(--ada-font-body)">
                    {n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label}
                  </text>
                  <text x="12" y="42" fontSize="9" fontFamily="ui-monospace, monospace" fill={KIND_COLOR[n.kind]}>
                    {n.kind}
                    {n.grafana ? `  ·  grafana:${n.grafana}` : ''}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      </div>

      {/* detail panel */}
      {sel && (
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-line bg-ink-850">
          <div className="border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[14px] font-semibold text-txt">{sel.label}</span>
              <div className="flex-1" />
              <button className="no-drag font-mono text-[11px] text-subtle hover:text-muted" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <div className="mt-1.5 flex gap-1.5">
              <Pill tone="gold">{sel.kind}</Pill>
              {sel.grafana && <Pill tone="info">grafana: {sel.grafana}</Pill>}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            {sel.repo && (
              <div className="font-mono text-[11px] text-subtle">
                repo <span className="text-muted">{sel.repo}</span>
              </div>
            )}
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">connections</div>
              <div className="mt-1.5 flex flex-col gap-1">
                {selEdges.map((e) => (
                  <div key={e.id} className="font-mono text-[11px] leading-relaxed text-muted">
                    {e.from === sel.id ? '→ ' + e.to : '← ' + e.from}
                    {e.label && <span className="text-subtle"> · {e.label}</span>}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">notes · travels to the agent</div>
              <TextArea rows={5} className="mt-1.5" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="single replica — known bottleneck; check HPA in the Helm charts…" />
              <Button variant="primary" className="mt-2 w-full" onClick={() => void saveNotes()}>
                Save notes
              </Button>
            </div>
          </div>
        </aside>
      )}

      {contextOpen && <ContextPanel onClose={() => setContextOpen(false)} />}

      {seedOpen && (
        <Modal open onClose={() => setSeedOpen(false)} width={560}>
          <div className="border-b border-line px-5 py-4">
            <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">Knowledge map</div>
            <div className="mt-0.5 font-display text-[18px] font-semibold text-txt">Seed from description</div>
          </div>
          <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-[12.5px] leading-relaxed text-muted">
              Describe your system in plain language — service names, what they do, who calls whom over what (HTTP, WebSocket,
              queues, databases). Paste an architecture doc if you have one. Everything extracted lands as ordinary map rows
              you can edit or delete.
            </p>
            <TextArea
              rows={10}
              value={seedText}
              onChange={(e) => setSeedText(e.target.value)}
              placeholder={
                'Our frontend web-app talks to api-gateway over HTTP. The gateway calls orders-service and billing-service. ' +
                'Orders publishes to a Kafka queue consumed by fulfillment-worker. Everything reads Postgres. ' +
                'Deploys live in the infra-charts repo…'
              }
            />
            {seedError && (
              <div className="rounded-sm border border-[color:var(--ada-danger)]/40 bg-[rgba(242,102,74,0.06)] px-3 py-2 text-[12px] text-danger">
                {seedError}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-line px-5 py-3.5">
            <span className="font-mono text-[10px] text-subtle">one Haiku call via your own Claude login · editable afterwards</span>
            <div className="flex gap-2">
              <Button variant="quiet" onClick={() => setSeedOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void runSeed()} disabled={seedBusy || !seedText.trim()}>
                {seedBusy ? 'Extracting…' : 'Extract map'}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}


/** The two map surfaces share one sidebar entry; this is the switch. */
function TabSwitch({ tab, onTab }: { tab: 'system' | 'code'; onTab: (t: 'system' | 'code') => void }) {
  return (
    <div className="ml-4 flex items-center gap-1">
      {(
        [
          ['system', 'System map'],
          ['code', 'Code graph'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          onClick={() => onTab(id)}
          className={`no-drag rounded-sm px-2.5 py-1 text-[12px] font-medium transition-colors ${tab === id ? 'text-txt' : 'text-subtle hover:text-muted'}`}
          style={tab === id ? { boxShadow: 'inset 0 -2px 0 var(--ada-gold-400)' } : undefined}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function MapHeader({ tab, onTab, subtitle }: { tab: 'system' | 'code'; onTab: (t: 'system' | 'code') => void; subtitle: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-5 py-3">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-widest text-subtle">{subtitle}</div>
        <h1 className="font-display text-[19px] font-semibold tracking-tight text-txt">Knowledge map</h1>
      </div>
      <TabSwitch tab={tab} onTab={onTab} />
      <div className="flex-1" />
      <span className="font-mono text-[11px] text-subtle">scroll = zoom · drag = pan · click a node</span>
    </div>
  )
}

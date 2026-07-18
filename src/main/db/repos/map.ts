import type { Database } from 'better-sqlite3'
import type { MapEdge, MapNode } from '../../../shared/types'

export function mapRepo(db: Database) {
  return {
    nodes(): MapNode[] {
      return (db.prepare('SELECT * FROM map_nodes ORDER BY id').all() as Record<string, string | null>[]).map((r) => ({
        id: r.id as string,
        label: r.label as string,
        kind: r.kind as MapNode['kind'],
        repo: r.repo ?? undefined,
        grafana: r.grafana ?? undefined,
        notes: r.notes ?? undefined,
      }))
    },

    edges(): MapEdge[] {
      return (db.prepare('SELECT * FROM map_edges ORDER BY id').all() as Record<string, unknown>[]).map((r) => ({
        id: r.id as number,
        from: r.from_id as string,
        to: r.to_id as string,
        label: (r.label as string | null) ?? undefined,
        kind: r.kind as MapEdge['kind'],
        status: r.status as MapEdge['status'],
      }))
    },

    upsertNode(n: MapNode): void {
      db.prepare(
        `INSERT INTO map_nodes (id, label, kind, repo, grafana, notes) VALUES (@id, @label, @kind, @repo, @grafana, @notes)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, kind=excluded.kind,
           repo=coalesce(excluded.repo, map_nodes.repo),
           grafana=coalesce(excluded.grafana, map_nodes.grafana),
           notes=coalesce(excluded.notes, map_nodes.notes)`,
      ).run({ id: n.id, label: n.label, kind: n.kind, repo: n.repo ?? null, grafana: n.grafana ?? null, notes: n.notes ?? null })
    },

    addEdge(from: string, to: string, label: string | undefined, kind: MapEdge['kind'], status: MapEdge['status'] = 'accepted'): void {
      db.prepare(
        `INSERT INTO map_edges (from_id, to_id, label, kind, status) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id, label) DO NOTHING`,
      ).run(from, to, label ?? null, kind, status)
    },

    isEmpty(): boolean {
      return (db.prepare('SELECT count(*) c FROM map_nodes').get() as { c: number }).c === 0
    },

    hasNode(id: string): boolean {
      return !!db.prepare('SELECT 1 FROM map_nodes WHERE id = ?').get(id)
    },

    /** Gate a proposed edge: accept promotes it into the live map; reject deletes. */
    decideEdge(id: number, accept: boolean): void {
      if (accept) db.prepare(`UPDATE map_edges SET status = 'accepted' WHERE id = ?`).run(id)
      else db.prepare('DELETE FROM map_edges WHERE id = ?').run(id)
    },

    /** Compact FLOWS text for the agent's prompt — accepted edges only. */
    promptText(maxLines = 40): string {
      const nodes = new Map(this.nodes().map((n) => [n.id, n]))
      const lines = this.edges()
        .filter((e) => e.status === 'accepted' && e.kind !== 'observes' && e.kind !== 'deploys')
        .slice(0, maxLines)
        .map((e) => `  ${e.from} ─${e.label ? `${e.label}` : e.kind}→ ${e.to}`)
      const infra = this.nodes()
        .filter((n) => n.grafana)
        .map((n) => `  ${n.id}: logs/metrics in Grafana "${n.grafana}"`)
      return ['SYSTEM MAP (how the org connects — trust it, verify only when contradicted):', ...lines, 'OBSERVABILITY:', ...infra.slice(0, 20)].join(
        '\n',
      ) + (nodes.size ? '' : '')
    },
  }
}

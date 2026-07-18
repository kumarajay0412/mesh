// Report → Linear-flavored markdown for the posted comment.
import type { Investigation, Report } from '../../shared/types'

export const MESH_SIGNATURE = '🕵️ *Investigated by **Mesh** — internal tool*'

export function formatReportComment(inv: Investigation, report: Report): string {
  const lines: string[] = []

  lines.push(`## Root-cause investigation · ${inv.id}`)
  lines.push('')
  lines.push(`**Hypothesis (${report.confidence}):** ${report.hypothesis}`)

  // The structured story — numbered points, measured spikes, per-service
  // breakdown, red herrings, honest unknowns. This is the part non-authors read.
  const d = report.rootCauseDetail
  if (d?.points?.length) {
    lines.push('', '### What happened')
    for (const [i, p] of d.points.entries()) lines.push(`${i + 1}. ${p}`)
  }
  if (d?.metrics?.length) {
    for (const m of d.metrics) {
      const hot = m.highlightX != null ? m.points.find((p) => p.x === m.highlightX) : undefined
      const rest = m.points.filter((p) => p.x !== m.highlightX).map((p) => p.y)
      const baseline = rest.length ? Math.round(rest.reduce((a, b) => a + b, 0) / rest.length) : null
      lines.push(
        '',
        `**${m.label}:** ${m.points.map((p) => `${p.x}: ${p.y}`).join(' · ')}` +
          (hot && baseline != null ? ` — **${m.highlightX} spiked to ${hot.y} vs ~${baseline} baseline**` : '') +
          (m.note ? `\n_${m.note}_` : ''),
      )
    }
  }
  if (d?.services?.length) {
    lines.push('', '### Service by service')
    for (const s of d.services) {
      lines.push(`- **${s.name}** — _${s.verdict}_`)
      for (const p of s.points) lines.push(`  - ${p}`)
    }
  }
  if (d?.redHerrings?.length) {
    lines.push('', '**Red herrings (looked causal, are not):**')
    for (const r of d.redHerrings) lines.push(`- ${r}`)
  }
  if (d?.unknowns?.length) {
    lines.push('', '**Honest unknowns:**')
    for (const u of d.unknowns) lines.push(`- ${u}`)
  }

  if (report.culprit) {
    lines.push('')
    lines.push(`**Culprit:** \`${report.culprit.repo}\` @ \`${report.culprit.sha.slice(0, 7)}\` — \`${report.culprit.path}\``)
  }

  if (report.suspects.length > 0) {
    lines.push('', '**Suspect commits (ranked):**')
    for (const [i, s] of report.suspects.entries()) {
      lines.push(`${i + 1}. \`${s.sha.slice(0, 7)}\` ${s.title} — *${s.confidence}* (${s.signals.join('; ')})`)
    }
  }

  if (report.evidence.length > 0) {
    lines.push('', '**Evidence:**')
    for (const e of report.evidence.slice(0, 8)) {
      lines.push(`- **[${e.type}]** ${e.claim}\n  \`${e.source}\``)
    }
  }

  if (report.suggestedFix) {
    lines.push('', `**Suggested fix:** ${report.suggestedFix}`)
  }

  if (report.unexplored.length > 0) {
    lines.push('', '**Unexplored:** ' + report.unexplored.join(' · '))
  }

  lines.push('', '---', MESH_SIGNATURE)
  return lines.join('\n')
}

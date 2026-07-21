// A downloadable, self-contained incident report.
//
// Everything is inlined — CSS, SVG charts, no scripts, no fonts, no network.
// That matters for two reasons: the file has to open years later off a shared
// drive with no Mesh install, and an incident report that phones out to a CDN
// is not something you can attach to a customer-facing postmortem.
//
// Charts are server-rendered SVG rather than a JS charting library, so the
// file also prints and PDF-exports faithfully.
import type { Investigation, Report, RootCauseMetric } from '../../shared/types'

/* --------------------------------------------------------------- palette -- */
// Both themes were checked with the dataviz validator against their own
// surface (contrast >= 3:1). The brand gold fails contrast on the light paper
// surface (1.48:1), which is why light mode uses a darker amber instead of
// simply reusing the dark-mode colour.
const THEME = {
  dark: { bg: '#0e0e0e', panel: '#141414', line: '#242424', txt: '#dcdcda', muted: '#b4b4b4', subtle: '#6f6f6f', series: '#1fa89a', onset: '#f5c518' },
  light: { bg: '#f7f4ee', panel: '#ffffff', line: '#e7e2d5', txt: '#1f1e1c', muted: '#57534e', subtle: '#78716c', series: '#12756a', onset: '#9a6600' },
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** Minimal inline markdown — the model writes `code` and **bold** into points. */
function md(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
}

/* ---------------------------------------------------------------- charts -- */

/** A single-series time chart with the onset point marked.
 *
 *  One series, so there is no legend — the caption names it (a legend box for
 *  one line is noise). The onset is a reserved status colour AND a direct
 *  label, never colour alone, so it survives greyscale printing and CVD. */
function lineChart(m: RootCauseMetric): string {
  const pts = m.points ?? []
  if (pts.length < 2) return ''

  const W = 720
  const H = 220
  const PAD = { t: 16, r: 16, b: 30, l: 52 }
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b

  const ys = pts.map((p) => p.y)
  const lo = Math.min(...ys, 0)
  const hi = Math.max(...ys)
  const span = hi - lo || 1
  const x = (i: number) => PAD.l + (i / (pts.length - 1)) * iw
  const y = (v: number) => PAD.t + ih - ((v - lo) / span) * ih

  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')
  const onsetIdx = m.highlightX ? pts.findIndex((p) => String(p.x) === String(m.highlightX)) : -1

  // Recessive gridlines: three horizontal rules, no vertical clutter.
  const grid = [0, 0.5, 1]
    .map((f) => {
      const gy = (PAD.t + ih - f * ih).toFixed(1)
      const val = lo + f * span
      return `<line class="grid" x1="${PAD.l}" y1="${gy}" x2="${W - PAD.r}" y2="${gy}"/><text class="ax" x="${PAD.l - 8}" y="${gy}" text-anchor="end" dominant-baseline="middle">${esc(fmtNum(val))}</text>`
    })
    .join('')

  // Label first, last, and the onset — never a number on every point.
  const keep = new Set([0, pts.length - 1, onsetIdx].filter((i) => i >= 0))
  const xLabels = pts
    .map((p, i) => (keep.has(i) ? `<text class="ax" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(p.x)}</text>` : ''))
    .join('')

  let onset = ''
  if (onsetIdx >= 0) {
    const ox = x(onsetIdx)
    const oy = y(pts[onsetIdx].y)
    // The onset is very often the series maximum, which puts it hard against
    // the top of the plot — flip the label under the marker when there isn't
    // room above it, and keep it off the left/right walls.
    const above = oy - PAD.t > 22
    const ly = above ? oy - 14 : oy + 20
    const anchor = ox < PAD.l + 44 ? 'start' : ox > W - PAD.r - 44 ? 'end' : 'middle'
    const lx = anchor === 'start' ? ox - 6 : anchor === 'end' ? ox + 6 : ox
    onset =
      `<line class="onset-rule" x1="${ox.toFixed(1)}" y1="${PAD.t}" x2="${ox.toFixed(1)}" y2="${PAD.t + ih}"/>` +
      // 2px surface ring so the marker reads against the line it sits on
      `<circle class="onset-ring" cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="7"/>` +
      `<circle class="onset" cx="${ox.toFixed(1)}" cy="${oy.toFixed(1)}" r="5"/>` +
      `<text class="onset-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">onset ${esc(m.highlightX)}</text>`
  }

  return `
<figure class="chart">
  <figcaption>${esc(m.label)}${m.unit ? ` <span class="unit">(${esc(m.unit)})</span>` : ''}</figcaption>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(m.label)}">
    ${grid}
    <path class="series" d="${path}"/>
    ${onset}
    ${xLabels}
  </svg>
  ${m.note ? `<p class="note">${md(m.note)}</p>` : ''}
  ${dataTable(m)}
</figure>`
}

/** Every chart ships a table view — the accessibility fallback, and the thing
 *  people actually copy numbers out of. */
function dataTable(m: RootCauseMetric): string {
  const rows = (m.points ?? [])
    .map((p) => `<tr><th scope="row">${esc(p.x)}</th><td>${esc(fmtNum(p.y))}</td></tr>`)
    .join('')
  return `<details class="tbl"><summary>Data</summary><table><thead><tr><th scope="col">Bucket</th><th scope="col">${esc(m.unit ?? 'Value')}</th></tr></thead><tbody>${rows}</tbody></table></details>`
}

function fmtNum(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return String(Math.round(v * 100) / 100)
}

/* ----------------------------------------------------------------- pieces -- */

function section(title: string, body: string): string {
  return body.trim() ? `<section><h2>${esc(title)}</h2>${body}</section>` : ''
}

const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${md(i)}</li>`).join('')}</ul>` : '')

function costBlock(inv: Investigation): string {
  const c = inv.cost
  if (!c) return ''
  const usd = c.usd != null ? `${c.partial ? '≥ ' : ''}$${c.usd.toFixed(2)}` : '—'
  const cell = (l: string, v: string) => `<div class="stat"><span class="k">${esc(l)}</span><span class="v">${esc(v)}</span></div>`
  return `<div class="stats">
    ${cell('API cost', usd)}
    ${cell('Turns', String(c.turns))}
    ${cell('Input', fmtNum(c.inputTokens))}
    ${cell('Cache read', fmtNum(c.cacheReadTokens))}
    ${cell('Output', fmtNum(c.outputTokens))}
  </div>${c.partial ? `<p class="note">Some sessions ran before cost accounting; the dollar figure is a floor.</p>` : ''}`
}

/* ------------------------------------------------------------------ page -- */

export function renderReportHtml(inv: Investigation, report: Report, generatedAt: number): string {
  const d = report.rootCauseDetail
  const when = new Date(generatedAt).toISOString().replace('T', ' ').slice(0, 16) + 'Z'

  const evidence = report.evidence
    .map(
      (e) => `<li>
      <div class="claim">${md(e.claim)}</div>
      <div class="src">${e.href ? `<a href="${esc(e.href)}">${esc(e.source)}</a>` : esc(e.source)} <span class="kind">${esc(e.type)}</span></div>
      ${e.snippet ? `<pre>${esc(e.snippet)}</pre>` : ''}
    </li>`,
    )
    .join('')

  const timeline = report.timeline
    .slice()
    .sort((a, b) => a.ts - b.ts)
    .map(
      (t) =>
        `<li class="tl-${esc(t.kind)}"><span class="ts">${new Date(t.ts).toISOString().slice(11, 19)}Z</span><span class="kind">${esc(t.kind)}</span>${md(t.label)}</li>`,
    )
    .join('')

  const suspects = report.suspects
    .map(
      (s) => `<li>
      <code>${esc(s.sha.slice(0, 12))}</code> <strong>${esc(s.title)}</strong>
      <div class="src">${esc(s.repo)}${s.path ? ` · ${esc(s.path)}` : ''}${s.author ? ` · ${esc(s.author)}` : ''} <span class="kind">${esc(s.confidence)}</span></div>
      ${s.signals?.length ? `<div class="sig">${s.signals.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
    </li>`,
    )
    .join('')

  const services = (d?.services ?? [])
    .map(
      (s) => `<li><strong>${esc(s.name)}</strong> <span class="kind">${esc(s.verdict)}</span>${list(s.points ?? [])}</li>`,
    )
    .join('')

  const charts = (d?.metrics ?? []).map(lineChart).join('')

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(inv.id)} — ${esc(inv.title)}</title>
<style>
${css()}
</style>
<main>
  <header>
    <div class="eyebrow">Mesh incident report · generated ${esc(when)}</div>
    <h1>${esc(inv.title)}</h1>
    <div class="meta">
      <span><code>${esc(inv.id)}</code></span>
      ${inv.service ? `<span>${esc(inv.service)}</span>` : ''}
      ${inv.ticketRef ? `<span>${esc(inv.ticketRef)}</span>` : ''}
      <span class="conf conf-${esc(report.confidence)}">${esc(report.confidence)}</span>
    </div>
  </header>

  <section class="lead">
    <h2>Root cause</h2>
    <p class="hypothesis">${md(report.hypothesis)}</p>
    ${report.culprit ? `<p class="culprit"><strong>Culprit</strong> <code>${esc(report.culprit.repo)}@${esc(report.culprit.sha.slice(0, 12))}</code> ${esc(report.culprit.path)}</p>` : ''}
    ${list(d?.points ?? [])}
  </section>

  ${charts ? `<section><h2>Metrics</h2>${charts}</section>` : ''}
  ${section('Services', services ? `<ul class="svc">${services}</ul>` : '')}
  ${section('Evidence', evidence ? `<ol class="ev">${evidence}</ol>` : '')}
  ${section('Timeline', timeline ? `<ol class="tl">${timeline}</ol>` : '')}
  ${section('Suspect commits', suspects ? `<ol class="sus">${suspects}</ol>` : '')}
  ${section('Suggested fix', report.suggestedFix ? `<p>${md(report.suggestedFix)}</p>` : '')}
  ${section('Red herrings', list(d?.redHerrings ?? []))}
  ${section('Open questions', list(d?.unknowns ?? []))}
  ${section('Not explored', list(report.unexplored ?? []))}
  ${section('Run cost', costBlock(inv))}

  <footer>
    Produced by Mesh from evidence gathered during the investigation. Every claim above links to
    the query, log, or commit it came from — check them before acting.
  </footer>
</main>`
}

function css(): string {
  const v = (t: typeof THEME.dark) => `
  --bg:${t.bg}; --panel:${t.panel}; --line:${t.line};
  --txt:${t.txt}; --muted:${t.muted}; --subtle:${t.subtle};
  --series:${t.series}; --onset:${t.onset};`
  return `
:root{${v(THEME.light)}}
@media (prefers-color-scheme: dark){:root{${v(THEME.dark)}}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);
  font:15px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;}
main{max-width:820px;margin:0 auto;padding:40px 24px 72px}
code,pre{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
code{font-size:.88em;background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:.05em .35em}
pre{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 12px;
  overflow-x:auto;font-size:12px;line-height:1.5;margin:.5em 0 0}
h1{font-size:26px;line-height:1.25;margin:.2em 0 .3em;font-weight:650}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--subtle);
  margin:2.4em 0 .7em;font-weight:600}
.eyebrow{font-family:ui-monospace,monospace;font-size:11px;color:var(--subtle);
  text-transform:uppercase;letter-spacing:.09em}
.meta{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:12.5px;color:var(--muted)}
.conf{border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
.conf-confirmed{color:var(--series);border-color:var(--series)}
.conf-probable{color:var(--onset);border-color:var(--onset)}
header{border-bottom:1px solid var(--line);padding-bottom:18px}
.lead .hypothesis{font-size:17px;line-height:1.55}
.culprit{color:var(--muted);font-size:14px}
ul,ol{padding-left:1.15em;margin:.5em 0}
li{margin:.42em 0}
section>ul>li::marker,section>ol>li::marker{color:var(--subtle)}
.src{color:var(--subtle);font-size:12px;font-family:ui-monospace,monospace;margin-top:2px}
.kind{border:1px solid var(--line);border-radius:3px;padding:0 5px;font-size:10.5px;
  text-transform:uppercase;letter-spacing:.05em;color:var(--subtle);margin-left:4px}
.sig{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.sig span{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.ev li,.sus li,.svc li{margin:1.05em 0}
.tl{list-style:none;padding-left:0}
.tl li{display:flex;gap:9px;align-items:baseline;border-left:2px solid var(--line);padding:.3em 0 .3em 12px}
.tl .ts{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--subtle);min-width:66px}
.tl-deploy{border-left-color:var(--onset)}
.tl-anomaly,.tl-symptom{border-left-color:var(--series)}
/* charts */
.chart{margin:0 0 26px}
.chart figcaption{font-size:13px;color:var(--muted);margin-bottom:6px}
.chart .unit{color:var(--subtle)}
.chart svg{width:100%;height:auto;display:block;background:var(--panel);
  border:1px solid var(--line);border-radius:8px}
.grid{stroke:var(--line);stroke-width:1}
.ax{fill:var(--subtle);font-size:10.5px;font-family:ui-monospace,monospace}
.series{fill:none;stroke:var(--series);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.onset-rule{stroke:var(--onset);stroke-width:1;stroke-dasharray:3 3;opacity:.65}
.onset-ring{fill:var(--panel)}
.onset{fill:var(--onset)}
.onset-label{fill:var(--onset);font-size:10.5px;font-family:ui-monospace,monospace}
.note{color:var(--subtle);font-size:12px;margin:.5em 0 0}
.tbl{margin-top:8px}
.tbl summary{cursor:pointer;color:var(--subtle);font-size:12px}
.tbl table{border-collapse:collapse;margin-top:7px;font-size:12.5px}
.tbl th,.tbl td{border:1px solid var(--line);padding:3px 10px;text-align:left;font-weight:400}
.tbl thead th{color:var(--subtle);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
/* stats */
.stats{display:flex;flex-wrap:wrap;gap:8px}
.stat{border:1px solid var(--line);border-radius:6px;padding:8px 14px;background:var(--panel);min-width:104px}
.stat .k{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--subtle)}
.stat .v{display:block;font-size:17px;font-family:ui-monospace,monospace;margin-top:2px}
footer{margin-top:3em;padding-top:16px;border-top:1px solid var(--line);
  color:var(--subtle);font-size:12px;line-height:1.55}
a{color:inherit}
@media print{
  :root{${v(THEME.light)}}
  main{max-width:none;padding:0}
  .tbl[open] summary{display:none}
  section{break-inside:avoid}
}`
}

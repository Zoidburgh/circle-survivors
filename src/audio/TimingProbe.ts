// ── Timing Probe (dev-only) ──────────────────────────────────────────────────
// Measures how far each gameplay/SFX event lands from the MASTER BEAT GRID, in ms.
// The grid is getAbsoluteBeats() = (audioTime − beatZeroTime)/BEAT_SEC, so integer
// crossings are the real downbeats (audio clock). probe(label) snapshots an event's
// offset from its nearest beat; the overlay shows per-label last/avg/min/max so you
// can SEE whether the tether/staccato/ring lands on the beat (and by how much).
//
// Zero cost in normal play: probe() no-ops until the overlay is opened.

import { getAbsoluteBeats } from './PatternClock.ts'
import { getActiveFeelName } from './BeatLoop.ts'
import { BEAT_SEC } from '../utils/constants.ts'

let enabled = false
// CSV time-series logging (toggled from the overlay) — console.logs each probed sample as
// `elapsedMs,feel,label,offsetMs` so a run across feel switches can be captured and charted.
let logging = false
let logStart = 0
// Grid the offset is measured against: 1 = whole beat, 2 = half-beat, 4 = quarter.
// Default 2 because staccato/tether events commonly land on half-beats — measuring
// against whole beats makes those read as ±500ms noise.
let gridDivision = 2
interface Stat { last: number; sum: number; n: number; min: number; max: number }
const stats = new Map<string, Stat>()
const order: string[] = []

/** Snapshot an event's offset from the nearest grid line (ms; + = late, − = early). */
export function probe(label: string): void {
  if (!enabled) return
  const b = getAbsoluteBeats()
  if (b <= 0) return
  const g = b * gridDivision
  const off = (g - Math.round(g)) / gridDivision   // beats from nearest 1/division grid line
  const ms = off * BEAT_SEC * 1000
  let s = stats.get(label)
  if (!s) { s = { last: 0, sum: 0, n: 0, min: Infinity, max: -Infinity }; stats.set(label, s); order.push(label) }
  s.last = ms; s.sum += ms; s.n++
  if (ms < s.min) s.min = ms
  if (ms > s.max) s.max = ms
}

/** Record a PRE-COMPUTED offset (ms) into the same stats/overlay machinery. Used for measurements
 *  that aren't relative to the gameplay grid — e.g. the player pulse vs the live MUSIC beat, which
 *  is what reveals feel-switch drift. + = late, − = early, by the caller's convention. */
export function probeValue(label: string, ms: number | null): void {
  if (!enabled || ms == null) return
  let s = stats.get(label)
  if (!s) { s = { last: 0, sum: 0, n: 0, min: Infinity, max: -Infinity }; stats.set(label, s); order.push(label) }
  s.last = ms; s.sum += ms; s.n++
  if (ms < s.min) s.min = ms
  if (ms > s.max) s.max = ms
  if (logging) console.log(`${(performance.now() - logStart).toFixed(0)},${getActiveFeelName()},${label},${ms.toFixed(1)}`)
}

function resetStats(): void { stats.clear(); order.length = 0 }

/** Plain-text snapshot of the current stats — for copy-to-clipboard. */
function reportText(): string {
  const lines = order.map(label => {
    const s = stats.get(label)!
    const avg = s.sum / s.n
    return `${label}: avg ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}ms  (last ${s.last.toFixed(0)}, min ${s.min.toFixed(0)}, max ${s.max.toFixed(0)}, n=${s.n})`
  })
  return `TIMING PROBE (ms from 1/${gridDivision}-beat grid, + late / - early) — feel: ${getActiveFeelName()}\n` + lines.join('\n')
}

// ── overlay ──
let panel: HTMLDivElement | null = null
let body: HTMLDivElement | null = null
let visible = false
let refreshHandle = 0

function fmt(ms: number): string { return (ms >= 0 ? '+' : '') + ms.toFixed(0) }
function color(ms: number): string {
  const a = Math.abs(ms)
  return a < 15 ? '#7CFFB0' : a < 40 ? '#FFD86E' : '#FF8080'   // green / yellow / red
}

function refresh(): void {
  if (!body) return
  const rows = order.map(label => {
    const s = stats.get(label)!
    const avg = s.sum / s.n
    return `<tr>
      <td style="padding:2px 8px 2px 0;color:#cde;">${label}</td>
      <td style="padding:2px 8px;text-align:right;color:${color(s.last)};">${fmt(s.last)}</td>
      <td style="padding:2px 8px;text-align:right;color:${color(avg)};font-weight:bold;">${fmt(avg)}</td>
      <td style="padding:2px 8px;text-align:right;color:#888;">${fmt(s.min)}/${fmt(s.max)}</td>
      <td style="padding:2px 0 2px 8px;text-align:right;color:#666;">${s.n}</td>
    </tr>`
  }).join('')
  body.innerHTML =
    `<div style="color:#FF9CFC;font-weight:bold;margin-bottom:4px;">TIMING PROBE — ms from 1/${gridDivision}-beat grid (+late / −early) · feel: <span style="color:#7DFFB0;">${getActiveFeelName()}</span></div>` +
    `<table style="border-collapse:collapse;font:11px monospace;"><tr style="color:#888;">
       <td style="padding-right:8px;">event</td><td style="padding:0 8px;text-align:right;">last</td>
       <td style="padding:0 8px;text-align:right;">avg</td><td style="padding:0 8px;text-align:right;">min/max</td>
       <td style="padding-left:8px;text-align:right;">n</td></tr>${rows}</table>` +
    `<div style="color:#666;margin-top:6px;">'player' = on-beat pulse vs gameplay grid (reference). 'vs music' = pulse vs the live music beat — watch it JUMP when you switch FEEL. press 'J' to close.</div>`
}

function build(): void {
  panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;right:10px;bottom:10px;min-width:360px;background:rgba(13,10,26,0.97);' +
    'border:1px solid rgba(255,156,252,0.4);border-radius:8px;padding:12px;z-index:9999;' +
    'font:11px monospace;color:#cdd;display:none;'
  body = document.createElement('div')
  panel.appendChild(body)
  const reset = document.createElement('button')
  reset.textContent = 'reset'
  reset.style.cssText = 'margin-top:8px;padding:3px 10px;background:#1c1830;color:#cde;border:1px solid #FF9CFC;border-radius:4px;font:11px monospace;cursor:pointer;'
  reset.addEventListener('click', () => { resetStats(); refresh() })
  panel.appendChild(reset)

  const grid = document.createElement('button')
  const gridLabel = () => `grid: 1/${gridDivision}`
  grid.textContent = gridLabel()
  grid.style.cssText = 'margin:8px 0 0 6px;padding:3px 10px;background:#1c1830;color:#cde;border:1px solid #4fc3f7;border-radius:4px;font:11px monospace;cursor:pointer;'
  grid.addEventListener('click', () => {
    gridDivision = gridDivision === 1 ? 2 : gridDivision === 2 ? 4 : 1   // cycle whole → half → quarter
    grid.textContent = gridLabel()
    resetStats(); refresh()
  })
  panel.appendChild(grid)

  const copy = document.createElement('button')
  copy.textContent = 'copy'
  copy.style.cssText = 'margin:8px 0 0 6px;padding:3px 10px;background:#1c1830;color:#cde;border:1px solid #7CFFB0;border-radius:4px;font:11px monospace;cursor:pointer;'
  copy.addEventListener('click', () => {
    const text = reportText()
    navigator.clipboard?.writeText(text).then(() => { copy.textContent = 'copied!'; setTimeout(() => { copy.textContent = 'copy' }, 1200) })
      .catch(() => { console.log(text); copy.textContent = 'see console'; setTimeout(() => { copy.textContent = 'copy' }, 1200) })
  })
  panel.appendChild(copy)

  const log = document.createElement('button')
  const logLabel = () => logging ? 'log: ON' : 'log: off'
  log.textContent = logLabel()
  log.style.cssText = 'margin:8px 0 0 6px;padding:3px 10px;background:#1c1830;color:#cde;border:1px solid #FFD86E;border-radius:4px;font:11px monospace;cursor:pointer;'
  log.addEventListener('click', () => {
    logging = !logging
    if (logging) { logStart = performance.now(); console.log('# elapsedMs,feel,label,offsetMs') }
    log.textContent = logLabel()
  })
  panel.appendChild(log)
  document.body.appendChild(panel)
}

export function initTimingProbe(): void { if (!panel) build() }

export function toggleTimingProbe(): void {
  if (!panel) build()
  visible = !visible
  enabled = visible
  panel!.style.display = visible ? 'block' : 'none'
  if (visible) {
    resetStats(); refresh()
    refreshHandle = window.setInterval(refresh, 150)
  } else {
    window.clearInterval(refreshHandle)
  }
}

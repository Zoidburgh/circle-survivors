// Music menu — a DOM panel anchored under the top-left ♫ HUD button. Two sections: KIT (the palette /
// voice set) and TRACK (the rhythm preset). They're independent axes, so you pick a kit AND a track
// and hear the combination — e.g. Organic + Groove. Opened/closed by the canvas ♫ button (main.ts).

import {
  switchBeat, getBeatNames, getBeatIndex,
  switchPalette, getPaletteNames, getPaletteIndex,
} from './AudioEngine.ts'

let panel: HTMLDivElement | null = null
let open = false

function build(): void {
  panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;left:14px;top:50px;min-width:160px;max-height:82vh;overflow-y:auto;' +
    'background:rgba(13,10,26,0.97);border:1px solid rgba(79,195,247,0.45);border-radius:8px;' +
    'padding:6px;z-index:9999;display:none;font:12px monospace;box-shadow:0 4px 16px rgba(0,0,0,0.5);'
  document.body.appendChild(panel)
}

function makeHeader(text: string): HTMLDivElement {
  const h = document.createElement('div')
  h.textContent = text
  h.style.cssText = 'color:#FF9CFC;font-weight:bold;padding:6px 10px 4px;'
  return h
}

function makeRow(name: string, active: boolean, onClick: () => void): HTMLDivElement {
  const row = document.createElement('div')
  row.textContent = name
  const bg = active ? 'rgba(125,255,176,0.14)' : 'transparent'
  row.style.cssText =
    `padding:6px 10px;border-radius:5px;cursor:pointer;` +
    `color:${active ? '#7DFFB0' : '#cde'};background:${bg};`
  row.addEventListener('mouseenter', () => { row.style.background = active ? bg : 'rgba(79,195,247,0.18)' })
  row.addEventListener('mouseleave', () => { row.style.background = bg })
  row.addEventListener('click', ev => { ev.stopPropagation(); onClick() })
  return row
}

function rebuild(): void {
  if (!panel) return
  panel.innerHTML = ''
  // KIT — swap the voice palette live; keep the menu open so you can then pick a track.
  panel.appendChild(makeHeader('♫ KIT'))
  getPaletteNames().forEach((name, i) => {
    panel!.appendChild(makeRow(name, i === getPaletteIndex(), () => { switchPalette(i); rebuild() }))
  })
  // TRACK — the rhythm preset; picking one closes the menu.
  panel.appendChild(makeHeader('♫ TRACK'))
  getBeatNames().forEach((name, i) => {
    panel!.appendChild(makeRow(name, i === getBeatIndex(), () => { switchBeat(i); rebuild(); close() }))
  })
}

export function initMusicMenu(): void { if (!panel) build() }

export function toggleMusicMenu(): void {
  if (!panel) build()
  open = !open
  if (open) rebuild()
  panel!.style.display = open ? 'block' : 'none'
}

function close(): void { open = false; if (panel) panel.style.display = 'none' }
export function closeMusicMenu(): void { close() }
export function isMusicMenuOpen(): boolean { return open }

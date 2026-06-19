// Music track dropdown — a DOM list anchored under the top-left ♫ HUD button. Lists every beat
// preset (current one highlighted); click one to switch the background track. Opened/closed by
// the canvas ♫ button (see main.ts). DOM so it's a real, scrollable, see-everything dropdown.

import { switchBeat, getBeatNames, getBeatIndex } from './AudioEngine.ts'

let panel: HTMLDivElement | null = null
let open = false

function build(): void {
  panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;left:14px;top:50px;min-width:150px;background:rgba(13,10,26,0.97);' +
    'border:1px solid rgba(79,195,247,0.45);border-radius:8px;padding:6px;z-index:9999;' +
    'display:none;font:12px monospace;box-shadow:0 4px 16px rgba(0,0,0,0.5);'
  document.body.appendChild(panel)
}

function rebuild(): void {
  if (!panel) return
  panel.innerHTML = '<div style="color:#FF9CFC;font-weight:bold;padding:2px 10px 6px;">♫ TRACK</div>'
  const cur = getBeatIndex()
  getBeatNames().forEach((name, i) => {
    const row = document.createElement('div')
    row.textContent = name
    const active = i === cur
    row.style.cssText =
      `padding:6px 10px;border-radius:5px;cursor:pointer;` +
      `color:${active ? '#7DFFB0' : '#cde'};background:${active ? 'rgba(125,255,176,0.14)' : 'transparent'};`
    row.addEventListener('mouseenter', () => { if (i !== getBeatIndex()) row.style.background = 'rgba(79,195,247,0.18)' })
    row.addEventListener('mouseleave', () => { if (i !== getBeatIndex()) row.style.background = 'transparent' })
    row.addEventListener('click', ev => {
      ev.stopPropagation()
      switchBeat(i)
      rebuild()      // refresh the highlight
      close()
    })
    panel!.appendChild(row)
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

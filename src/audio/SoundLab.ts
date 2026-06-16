// ── Sound Lab (dev-only) ─────────────────────────────────────────────────────
// A bench for the musical-SFX layer: audition any timbre/register/degree, hear a
// scale run + chord, stress-test the voice manager, and A/B scale-lock + quantize
// live. Self-contained DOM overlay toggled with the 'L' debug key. No prod path.

import { playAttackNote, setScaleLock, isScaleLock, setQuantize, isQuantize, timbreNames, type Register } from './MusicalSFX.ts'
import { ensureAudioContext, getCurrentMusic, getAudioTime } from './AudioEngine.ts'

let panel: HTMLDivElement | null = null
let statusEl: HTMLDivElement | null = null
let visible = false

const REGISTERS: Register[] = ['bass', 'mid', 'high']

function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = label
  b.style.cssText = 'margin:2px;padding:4px 8px;background:#1c1830;color:#cde;border:1px solid #4fc3f7;border-radius:4px;font:11px monospace;cursor:pointer;'
  b.addEventListener('click', () => { ensureAudioContext(); onClick(); refresh() })
  return b
}

function refresh(): void {
  if (!statusEl) return
  const m = getCurrentMusic()
  const key = m ? `${m.root} ${m.mode} · ${m.bpm}bpm` : '(no music yet)'
  statusEl.innerHTML =
    `<b style="color:#FF9CFC;">SOUND LAB</b> &nbsp; key: <b>${key}</b><br>` +
    `scaleLock: <b style="color:${isScaleLock() ? '#7CFFB0' : '#FF8080'}">${isScaleLock() ? 'ON (musical)' : 'OFF (legacy)'}</b>` +
    ` &nbsp; quantize: <b style="color:${isQuantize() ? '#7CFFB0' : '#888'}">${isQuantize() ? 'ON' : 'off'}</b>`
}

function row(label: string): HTMLDivElement {
  const d = document.createElement('div')
  d.style.cssText = 'margin-top:6px;'
  const l = document.createElement('span')
  l.textContent = label
  l.style.cssText = 'color:#888;font:10px monospace;display:block;margin-bottom:2px;'
  d.appendChild(l)
  return d
}

function build(): void {
  panel = document.createElement('div')
  panel.style.cssText =
    'position:fixed;left:10px;bottom:10px;width:520px;background:rgba(13,10,26,0.97);' +
    'border:1px solid rgba(79,195,247,0.4);border-radius:8px;padding:12px;z-index:9999;' +
    'font:11px monospace;color:#cdd;display:none;'

  statusEl = document.createElement('div')
  statusEl.style.cssText = 'margin-bottom:8px;line-height:1.6;'
  panel.appendChild(statusEl)

  // Policy toggles
  const toggles = row('policy (A/B)')
  toggles.appendChild(btn('toggle scaleLock', () => setScaleLock(!isScaleLock())))
  toggles.appendChild(btn('toggle quantize', () => setQuantize(!isQuantize())))
  panel.appendChild(toggles)

  // Degree buttons per register
  for (const reg of REGISTERS) {
    const r = row(`${reg} register — degrees`)
    for (let d = 0; d < 5; d++) {
      r.appendChild(btn(`${d}`, () => playAttackNote({ register: reg, degree: d })))
    }
    panel.appendChild(r)
  }

  // Phrases
  const phrases = row('phrases')
  phrases.appendChild(btn('scale run ↑', () => {
    const t0 = getAudioTime()
    for (let d = 0; d < 8; d++) playAttackNote({ register: 'mid', degree: d, when: t0 + d * 0.12 })
  }))
  phrases.appendChild(btn('chord (0·2·4)', () => {
    for (const d of [0, 2, 4]) playAttackNote({ register: 'mid', degree: d })
  }))
  phrases.appendChild(btn('stress ×30', () => {
    const t0 = getAudioTime()
    const names = timbreNames()
    for (let i = 0; i < 30; i++) {
      playAttackNote({
        timbre: names[i % names.length]!,
        register: REGISTERS[i % 3]!,
        degree: i % 7,
        when: t0 + i * 0.02,
      })
    }
  }))
  panel.appendChild(phrases)

  // Timbres (each plays at mid, degree 0 — hear its texture)
  const tim = row('timbres (mid · degree 0)')
  for (const name of timbreNames()) {
    tim.appendChild(btn(name, () => playAttackNote({ timbre: name, degree: 0 })))
  }
  panel.appendChild(tim)

  const hint = document.createElement('div')
  hint.style.cssText = 'margin-top:8px;color:#666;font:10px monospace;'
  hint.textContent = "press 'K' to close · spawn real enemies in the designer to hear it in play"
  panel.appendChild(hint)

  document.body.appendChild(panel)
}

export function initSoundLab(): void {
  if (panel) return
  build()
}

export function toggleSoundLab(): void {
  if (!panel) build()
  visible = !visible
  panel!.style.display = visible ? 'block' : 'none'
  if (visible) refresh()
}

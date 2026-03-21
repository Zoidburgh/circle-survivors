import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import type { EnemyType } from '../entities/EnemyTypes.ts'
import type { SongPattern } from '../audio/SongPatterns.ts'
import { setPattern, getPattern, getLoopPosition, getLoopLength } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies } from '../core/GameState.ts'
import { createEnemy } from '../entities/Enemy.ts'
import { playEnemyBeatTick } from '../audio/AudioEngine.ts'
import { ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { BEAT_SEC } from '../utils/constants.ts'

export const SOUND_POOL = [
  'pop', 'click', 'snap', 'bell', 'buzz', 'bass', 'chord', 'pluck',
  'thump', 'chirp', 'zap', 'bloop', 'clap', 'rim', 'tom', 'whistle',
] as const

export type SoundName = typeof SOUND_POOL[number]

export interface DesignedEnemy extends EnemyType {
  sound: SoundName
  beats: number[]
}

const designedEnemies: DesignedEnemy[] = []
let panel: HTMLDivElement | null = null
let visible = false

// Live preview enemy shown on the game canvas
export interface PreviewEnemy {
  radius: number
  ringRadius: number
  color: string
  name: string
  moveSpeed: number
  beats: number[]
  sound: string
  attackTimer: number
  expandTime: number
}
let previewEnemy: PreviewEnemy | null = null

export function getPreviewEnemy(): PreviewEnemy | null {
  return visible ? previewEnemy : null
}

// Track which beats have fired this loop to avoid double-firing
function getIntervalFromBeats(beats: number[], loopLen: number): number {
  if (beats.length < 2) return loopLen
  const sorted = [...beats].sort((a, b) => a - b)
  let minGap = loopLen - sorted[sorted.length - 1]! + sorted[0]!
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!
    if (gap < minGap) minGap = gap
  }
  return minGap
}

let previewFiredBeats = new Set<number>()
let previewLastLoop = -1

export function updatePreviewEnemy(dt: number): void {
  if (!visible || !previewEnemy) return

  const loopPos = getLoopPosition()
  const loopLen = getLoopLength()

  // Detect loop wrap — reset fired set
  const loopIndex = Math.floor(loopPos)
  if (loopPos < 0.1 && previewLastLoop > loopLen - 1) {
    previewFiredBeats.clear()
  }
  previewLastLoop = loopPos

  // Check if any of preview's beats just hit — start ring animation
  if (previewEnemy.attackTimer < 0) {
    for (const beat of previewEnemy.beats) {
      if (previewFiredBeats.has(beat)) continue
      const d = Math.abs(loopPos - beat)
      const dist = Math.min(d, loopLen - d)
      if (dist < 0.08) {
        previewFiredBeats.add(beat)
        // Scale expand time to fit beat interval
        const interval = getIntervalFromBeats(previewEnemy.beats, loopLen)
        previewEnemy.expandTime = Math.min(ATTACK_EXPAND_TIME, interval * BEAT_SEC * 0.8)
        previewEnemy.attackTimer = 0
        break
      }
    }
  }

  // Advance attack animation, play sound at peak (same as real enemies)
  if (previewEnemy.attackTimer >= 0) {
    const prev = previewEnemy.attackTimer
    previewEnemy.attackTimer += dt
    if (previewEnemy.attackTimer >= previewEnemy.expandTime && prev < previewEnemy.expandTime) {
      playEnemyBeatTick(previewEnemy.name, previewEnemy.sound)
    }
    if (previewEnemy.attackTimer > previewEnemy.expandTime + 0.05) {
      previewEnemy.attackTimer = -1
    }
  }
}

export function getDesignedEnemies(): DesignedEnemy[] {
  return designedEnemies
}

export function toggleDesigner(): void {
  visible = !visible
  if (panel) panel.style.display = visible ? 'block' : 'none'
}

const inputCSS = `
  width: 100%; background: #0d0a1a; color: #fff; border: 1px solid #333;
  padding: 6px; font: 13px monospace; border-radius: 3px; box-sizing: border-box;
`
const labelCSS = `font-size: 11px; color: #888; margin-bottom: 2px; display: block;`

export function initDesigner(): void {
  panel = document.createElement('div')
  panel.id = 'enemy-designer'
  panel.style.cssText = `
    position: fixed; top: 10px; right: 10px; width: 360px;
    background: rgba(13,10,26,0.97); border: 1px solid rgba(79,195,247,0.3);
    border-radius: 8px; padding: 16px; color: #ccc; font: 12px monospace;
    z-index: 100; display: none; max-height: 90vh; overflow-y: auto;
  `

  panel.innerHTML = `
    <div style="color: #4FC3F7; font-size: 16px; margin-bottom: 12px; font-weight: bold;">
      Enemy Designer
      <span style="font-size:11px;color:#666;font-weight:normal;"> (Tab to toggle)</span>
      <span id="ed-close" style="float:right;cursor:pointer;color:#666;font-size:18px;">✕</span>
    </div>
    <div id="ed-list"></div>
    <button id="ed-add" style="
      width: 100%; padding: 10px; margin-top: 8px; cursor: pointer;
      background: rgba(79,195,247,0.15); border: 1px solid rgba(79,195,247,0.3);
      color: #4FC3F7; font: 13px monospace; border-radius: 4px;
    ">+ Add Enemy Type</button>
  `

  document.body.appendChild(panel)

  // Stop game input when typing in designer
  panel.addEventListener('keydown', e => { e.stopPropagation() })
  panel.addEventListener('keyup', e => { e.stopPropagation() })

  panel.querySelector('#ed-close')!.addEventListener('click', toggleDesigner)
  panel.querySelector('#ed-add')!.addEventListener('click', () => addEnemyForm())

  window.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault()
      toggleDesigner()
    }
  })
}

let enemyCounter = 0

function addEnemyForm(existing?: DesignedEnemy): void {
  const id = enemyCounter++
  const list = panel!.querySelector('#ed-list')!

  const colors = ['#EF5350', '#FF9800', '#FFEB3B', '#66BB6A', '#AB47BC', '#4FC3F7', '#FF5722', '#E91E63']
  const defaultColor = existing?.color ?? colors[id % colors.length]!
  const defaultName = existing?.name ?? `Enemy${id + 1}`

  const div = document.createElement('div')
  div.style.cssText = `
    border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
    margin-bottom: 8px; position: relative; overflow: hidden;
  `

  // Collapsed header — click to expand
  const header = document.createElement('div')
  header.style.cssText = `
    padding: 8px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;
  `
  header.innerHTML = `
    <div id="ed-swatch-${id}" style="width:16px;height:16px;border-radius:50%;background:${defaultColor};flex-shrink:0;"></div>
    <span id="ed-header-name-${id}" style="flex:1;color:#fff;font:12px monospace;">${defaultName}</span>
    <span id="ed-header-rhythm-${id}" style="color:#666;font:10px monospace;">offbeat</span>
    <span id="ed-header-sound-${id}" style="color:#666;font:10px monospace;">pop</span>
  `
  div.appendChild(header)

  // Expandable body
  const body = document.createElement('div')
  body.id = `ed-body-${id}`
  body.style.cssText = `padding: 0 12px 12px 12px; display: ${existing ? 'none' : 'block'};`

  let expanded = !existing
  header.addEventListener('click', () => {
    expanded = !expanded
    body.style.display = expanded ? 'block' : 'none'
  })

  body.innerHTML = `
    <div style="display: flex; gap: 8px; margin-bottom: 10px; align-items: center;">
      <div style="flex:1;">
        <span style="${labelCSS}">Name</span>
        <input id="ed-name-${id}" value="${defaultName}" style="${inputCSS}">
        <div style="display:flex;gap:6px;margin-top:6px;align-items:center;">
          <div>
            <span style="${labelCSS}">Color</span>
            <input id="ed-color-${id}" type="color" value="${defaultColor}" style="width:40px;height:30px;border:none;cursor:pointer;background:none;">
          </div>
          <div style="flex:1;">
            <span style="${labelCSS}">Sound</span>
            <select id="ed-sound-${id}" style="${inputCSS}">
              ${SOUND_POOL.map(s => `<option value="${s}" ${s === (existing?.sound ?? 'pop') ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </div>
          <button id="ed-audition-${id}" style="margin-top:14px;padding:6px 10px;cursor:pointer;background:rgba(255,255,255,0.1);border:1px solid #444;color:#fff;font:12px monospace;border-radius:3px;">♪</button>
        </div>
      </div>
      <button id="ed-del-${id}" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#666;cursor:pointer;font-size:16px;">✕</button>
    </div>

    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin-bottom: 8px;">
      <div><span style="${labelCSS}">HP</span><input id="ed-hp-${id}" type="text" value="${existing?.hp ?? 2}" style="${inputCSS}"></div>
      <div><span style="${labelCSS}">Speed</span><input id="ed-speed-${id}" type="text" value="${existing?.moveSpeed ?? 50}" style="${inputCSS}"></div>
      <div><span style="${labelCSS}">Body Size</span><input id="ed-radius-${id}" type="text" value="${existing?.radius ?? 40}" style="${inputCSS}"></div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 8px;">
      <div><span style="${labelCSS}">Ring Range</span><input id="ed-ring-${id}" type="text" value="${existing?.ringRadius ?? 120}" style="${inputCSS}"></div>
      <div><span style="${labelCSS}">Spawn Key</span><input id="ed-key-${id}" type="text" value="${existing?.key ?? (id + 1).toString()}" maxlength="1" style="${inputCSS}"></div>
    </div>

    <div style="margin-bottom: 8px;">
      <span style="${labelCSS}">Rhythm Pattern</span>
      <select id="ed-rhythm-${id}" style="${inputCSS}">
        <option value="offbeat">Offbeat — between every player beat</option>
        <option value="onbeat">On Beat — same as player</option>
        <option value="half">Half Time — every other beat</option>
        <option value="double">Double Time — twice per beat</option>
        <option value="backbeat">Backbeat — beats 2 and 4</option>
        <option value="synco1">Syncopated A — and-of-1, 2, and-of-3, 4</option>
        <option value="synco2">Syncopated B — 1, and-of-2, and-of-3, 4</option>
        <option value="triplet">Triplet Feel — 3 per beat</option>
        <option value="sparse">Sparse — beats 1 and 5</option>
        <option value="gallop">Gallop — 1, 1.5, 3, 3.5, 5, 5.5, 7, 7.5</option>
        <option value="custom">Custom...</option>
      </select>
      <input id="ed-beats-${id}" type="text" value="${existing?.beats?.join(', ') ?? '0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5'}" style="${inputCSS} display:none;margin-top:4px;" placeholder="0.5, 1.5, 2.5...">
    </div>

    <div style="display:flex;gap:6px;">
      <button id="ed-save-${id}" style="flex:1;padding:8px;cursor:pointer;background:rgba(100,255,120,0.15);border:1px solid rgba(100,255,120,0.3);color:#64FF78;font:12px monospace;border-radius:4px;">Save</button>
      <button id="ed-spawn-${id}" style="flex:1;padding:8px;cursor:pointer;background:rgba(79,195,247,0.15);border:1px solid rgba(79,195,247,0.3);color:#4FC3F7;font:12px monospace;border-radius:4px;">Spawn</button>
    </div>
  `

  div.appendChild(body)
  list.appendChild(div)

  // Rhythm presets
  const RHYTHM_PRESETS: Record<string, number[]> = {
    offbeat:  [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
    onbeat:   [0, 1, 2, 3, 4, 5, 6, 7],
    half:     [0, 2, 4, 6],
    double:   [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5],
    backbeat: [1, 3, 5, 7],
    synco1:   [0.5, 2, 4.5, 6],
    synco2:   [0, 2.5, 4.5, 6],
    triplet:  [0, 0.67, 1.33, 2, 2.67, 3.33, 4, 4.67, 5.33, 6, 6.67, 7.33],
    sparse:   [0, 4],
    gallop:   [0, 0.5, 2, 2.5, 4, 4.5, 6, 6.5],
  }

  const rhythmSelect = div.querySelector(`#ed-rhythm-${id}`) as HTMLSelectElement
  const beatsInput = div.querySelector(`#ed-beats-${id}`) as HTMLInputElement

  // Set initial dropdown from existing beats
  if (existing?.beats) {
    const beatsStr = existing.beats.join(', ')
    let matched = false
    for (const [key, preset] of Object.entries(RHYTHM_PRESETS)) {
      if (preset.join(', ') === beatsStr) {
        rhythmSelect.value = key
        matched = true
        break
      }
    }
    if (!matched) {
      rhythmSelect.value = 'custom'
      beatsInput.style.display = 'block'
    }
  }

  rhythmSelect.addEventListener('change', () => {
    if (rhythmSelect.value === 'custom') {
      beatsInput.style.display = 'block'
    } else {
      beatsInput.style.display = 'none'
      const preset = RHYTHM_PRESETS[rhythmSelect.value]
      if (preset) beatsInput.value = preset.join(', ')
    }
    updatePreview()
  })

  function updatePreview(): void {
    const form = readForm()
    if (!previewEnemy) {
      previewEnemy = { radius: form.radius, ringRadius: form.ringRadius, color: form.color, name: form.name, moveSpeed: form.moveSpeed, beats: form.beats, sound: form.sound, attackTimer: -1, expandTime: ATTACK_EXPAND_TIME }
    } else {
      previewEnemy.radius = form.radius
      previewEnemy.ringRadius = form.ringRadius
      previewEnemy.color = form.color
      previewEnemy.name = form.name
      previewEnemy.moveSpeed = form.moveSpeed
      previewEnemy.beats = form.beats
      previewEnemy.sound = form.sound
    }
  }

  // Update preview on any input change
  const inputs = div.querySelectorAll('input, select')
  inputs.forEach(input => {
    input.addEventListener('input', updatePreview)
    input.addEventListener('change', updatePreview)
  })
  updatePreview()

  // Delete
  div.querySelector(`#ed-del-${id}`)!.addEventListener('click', () => {
    div.remove()
    const idx = designedEnemies.findIndex(e => e.name === readForm().name)
    if (idx >= 0) designedEnemies.splice(idx, 1)
    const typeIdx = ENEMY_TYPES.findIndex(t => t.name === readForm().name)
    if (typeIdx >= 0) ENEMY_TYPES.splice(typeIdx, 1)
    rebuildPattern()
  })

  function readForm(): DesignedEnemy {
    const name = (div.querySelector(`#ed-name-${id}`) as HTMLInputElement).value
    const color = (div.querySelector(`#ed-color-${id}`) as HTMLInputElement).value
    const sound = (div.querySelector(`#ed-sound-${id}`) as HTMLSelectElement).value as SoundName
    const hp = parseInt((div.querySelector(`#ed-hp-${id}`) as HTMLInputElement).value) || 2
    const speed = parseInt((div.querySelector(`#ed-speed-${id}`) as HTMLInputElement).value) || 50
    const radius = parseInt((div.querySelector(`#ed-radius-${id}`) as HTMLInputElement).value) || 40
    const ring = parseInt((div.querySelector(`#ed-ring-${id}`) as HTMLInputElement).value) || 120
    const key = (div.querySelector(`#ed-key-${id}`) as HTMLInputElement).value || (id + 1).toString()
    const beatsStr = (div.querySelector(`#ed-beats-${id}`) as HTMLInputElement).value
    const beats = beatsStr.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n))
    return { name, color, hp, moveSpeed: speed, radius, ringRadius: ring, key, role: sound, sound, beats }
  }

  // Audition — play the sound once
  div.querySelector(`#ed-audition-${id}`)!.addEventListener('click', () => {
    const form = readForm()
    playEnemyBeatTick(form.name, form.sound)
  })

  // Save — collapse and update header
  div.querySelector(`#ed-save-${id}`)!.addEventListener('click', () => {
    const designed = readForm()
    const idx = designedEnemies.findIndex(e => e.name === designed.name)
    if (idx >= 0) designedEnemies[idx] = designed
    else designedEnemies.push(designed)
    const typeIdx = ENEMY_TYPES.findIndex(t => t.name === designed.name)
    if (typeIdx >= 0) ENEMY_TYPES[typeIdx] = designed
    else ENEMY_TYPES.push(designed)
    rebuildPattern()
    updatePreview()
    // Update header
    const swatch = div.querySelector(`#ed-swatch-${id}`) as HTMLDivElement
    const headerName = div.querySelector(`#ed-header-name-${id}`) as HTMLSpanElement
    const headerRhythm = div.querySelector(`#ed-header-rhythm-${id}`) as HTMLSpanElement
    const headerSound = div.querySelector(`#ed-header-sound-${id}`) as HTMLSpanElement
    swatch.style.background = designed.color
    headerName.textContent = `${designed.name} [${designed.key}]`
    headerRhythm.textContent = rhythmSelect.value
    headerSound.textContent = designed.sound
    // Collapse
    expanded = false
    body.style.display = 'none'
    div.style.borderColor = 'rgba(100,255,120,0.5)'
    setTimeout(() => div.style.borderColor = 'rgba(255,255,255,0.1)', 400)
  })

  // Spawn
  div.querySelector(`#ed-spawn-${id}`)!.addEventListener('click', () => {
    const designed = readForm()
    if (!ENEMY_TYPES.find(t => t.name === designed.name)) ENEMY_TYPES.push(designed)
    const player = getPlayer()
    const enemies = getEnemies()
    const angle = Math.random() * Math.PI * 2
    const dist = 300 + Math.random() * 150
    enemies.push(createEnemy(
      player.x + Math.cos(angle) * dist,
      player.y + Math.sin(angle) * dist,
      designed
    ))
  })
}

function rebuildPattern(): void {
  const patterns: Record<string, number[]> = {
    'Player': [0, 1, 2, 3, 4, 5, 6, 7],
  }
  for (const de of designedEnemies) {
    patterns[de.name] = de.beats
  }
  setPattern({ name: 'Custom', loopBeats: 8, patterns })
}

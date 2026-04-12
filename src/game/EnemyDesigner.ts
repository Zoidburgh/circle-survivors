import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import defaultEnemies from '../../data/enemies.json'
import type { EnemyType } from '../entities/EnemyTypes.ts'
import type { SongPattern } from '../audio/SongPatterns.ts'
import { setPattern, getPattern, getLoopPosition, getLoopLength } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies } from '../core/GameState.ts'
import { createEnemy } from '../entities/Enemy.ts'
import { getSpawnPos } from './Arena.ts'
import { playEnemyBeatTick } from '../audio/AudioEngine.ts'
import { clearKeys } from './InputManager.ts'
import { UPGRADE_POOL } from './UpgradeDefinitions.ts'
import { addUpgrade, removeUpgrade, getActiveUpgrades, applyModifiers } from './UpgradeManager.ts'
import { ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { BEAT_SEC } from '../utils/constants.ts'

export const SOUND_POOL = [
  'pop', 'click', 'snap', 'bell', 'buzz', 'bass', 'chord', 'pluck',
  'thump', 'chirp', 'zap', 'bloop', 'clap', 'rim', 'tom', 'whistle',
  'purr', 'ping', 'growl', 'chime', 'knock', 'sweep', 'drop', 'pulse',
] as const

export type SoundName = typeof SOUND_POOL[number]

import type { RingConfig } from '../entities/EnemyTypes.ts'

export interface DesignedEnemy extends EnemyType {
  sound: SoundName       // default sound (first ring)
  beats: number[]        // default beats (first ring)
  rings: RingConfig[]    // all rings
}

const designedEnemies: DesignedEnemy[] = []
let panel: HTMLDivElement | null = null
let visible = false

// ── Persistence ──
// ── Curated color palette ──
// HSL-based, avoids player cyan (180-200) and orb teal (150-170)
function hsl(h: number, s: number, l: number): string {
  // Convert HSL to hex
  const c = (1 - Math.abs(2 * l / 100 - 1)) * s / 100
  const x = c * (1 - Math.abs((h / 60) % 2 - 1))
  const m = l / 100 - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c }
  else { r = c; b = x }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

const ENEMY_PALETTE: string[] = [
  // ── Neon / Electric ──
  '#FF0055', '#FF2D6A', '#FF4081', '#FF6090', '#FF80AB',  // hot pink
  '#FF3300', '#FF5722', '#FF6E40', '#FF8A65', '#FFAB91',  // neon red-orange
  '#FF6D00', '#FF9100', '#FFB300', '#FFC107', '#FFD54F',  // amber/gold
  '#EEFF41', '#C6FF00', '#AEEA00', '#9AE600', '#76FF03',  // acid green
  '#00E676', '#00C853', '#2E7D32', '#1B5E20', '#4CAF50',  // matrix green

  // ── Cyber Blues/Purples ──
  '#304FFE', '#3D5AFE', '#536DFE', '#448AFF', '#82B1FF',  // electric blue
  '#651FFF', '#7C4DFF', '#AA00FF', '#B388FF', '#CE93D8',  // neon purple
  '#D500F9', '#E040FB', '#EA80FC', '#F06292', '#EC407A',  // magenta/fuchsia
  '#6200EA', '#7B1FA2', '#9C27B0', '#AB47BC', '#BA68C8',  // deep violet

  // ── Warm Cyber ──
  '#FF1744', '#D50000', '#C62828', '#B71C1C', '#E53935',  // blood red
  '#FF9800', '#F57C00', '#E65100', '#BF360C', '#DD2C00',  // rust/fire
  '#FFD740', '#FFC400', '#FFAB00', '#FF8F00', '#F9A825',  // cyber gold
  '#FFEE58', '#FDD835', '#F5BF03', '#E6A800', '#D4A017',  // plasma yellow

  // ── Cool Cyber ──
  '#00B0FF', '#0091EA', '#01579B', '#0288D1', '#039BE5',  // steel blue
  '#1DE9B6', '#00BFA5', '#009688', '#00897B', '#00695C',  // cyber teal
  '#18FFFF', '#00E5FF', '#00B8D4', '#0097A7', '#00838F',  // ice cyan

  // ── Neutrals / Chrome ──
  '#ECEFF1', '#CFD8DC', '#B0BEC5', '#90A4AE', '#78909C',  // chrome
  '#546E7A', '#455A64', '#37474F', '#263238', '#1A1A2E',  // dark steel
]

const SAVE_KEY = 'circle-survivors-enemies'
const SAVE_VERSION = 1

interface SaveData {
  version: number
  enemies: DesignedEnemy[]
}

function saveToStorage(): void {
  const data: SaveData = { version: SAVE_VERSION, enemies: designedEnemies }
  localStorage.setItem(SAVE_KEY, JSON.stringify(data))
}

function loadFromStorage(): DesignedEnemy[] {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) {
      // First time — use bundled default enemies
      const def = (defaultEnemies as SaveData).enemies ?? []
      if (def.length > 0) {
        localStorage.setItem(SAVE_KEY, JSON.stringify(defaultEnemies))
        return def
      }
      return []
    }
    const data = JSON.parse(raw) as SaveData
    if (data.version !== SAVE_VERSION) return [] // future: migrate
    return data.enemies ?? []
  } catch {
    return []
  }
}

function resolveNameConflict(name: string): string {
  const existing = designedEnemies.map(e => e.name)
  if (!existing.includes(name)) return name
  let i = 2
  while (existing.includes(`${name}_${i}`)) i++
  return `${name}_${i}`
}

function exportEnemies(): void {
  const data: SaveData = { version: SAVE_VERSION, enemies: designedEnemies }
  const json = JSON.stringify(data, null, 2)
  // Save to project folder via dev server
  fetch('/api/save-enemies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  }).catch(() => {
    // Fallback: download if dev server unavailable (production)
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'circle-survivors-enemies.json'
    a.click()
    URL.revokeObjectURL(url)
  })
}

function importEnemies(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string) as SaveData
        if (!data.enemies?.length) return
        for (const enemy of data.enemies) {
          enemy.name = resolveNameConflict(enemy.name)
          designedEnemies.push(enemy)
          const typeIdx = ENEMY_TYPES.findIndex(t => t.name === enemy.name)
          if (typeIdx >= 0) ENEMY_TYPES[typeIdx] = enemy
          else ENEMY_TYPES.push(enemy)
          addEnemyForm(enemy)
        }
        rebuildPattern()
        saveToStorage()
      } catch {
        // invalid file, ignore
      }
    }
    reader.readAsText(file)
  })
  input.click()
}

// Live preview enemy shown on the game canvas
export interface PreviewRing {
  ringRadius: number
  beats: number[]
  sound: string
  attackTimer: number
  expandTime: number
  patternName: string
  edgeMode: boolean
  edgePoints: number
  edgeActive: number
}

export interface PreviewEnemy {
  radius: number
  color: string
  name: string
  moveSpeed: number
  previewRings: PreviewRing[]
  immovable: boolean
  consume: boolean
  magnet: boolean
  magnetRange: number
  volatile: boolean
  volatileRange: number
  revenge: boolean
  revengeRings: number
  revengeRadius: number
  totemSpawn: string
}
let previewEnemy: PreviewEnemy | null = null

let enemySectionExpanded = true

export function getPreviewEnemy(): PreviewEnemy | null {
  return visible && enemySectionExpanded ? previewEnemy : null
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

let previewFiredBeats = new Set<string>()
let previewLastLoop = -1

export function updatePreviewEnemy(dt: number): void {
  if (!visible || !previewEnemy) return

  const loopPos = getLoopPosition()
  const loopLen = getLoopLength()

  // Detect loop wrap — reset fired set
  if (loopPos < 0.1 && previewLastLoop > loopLen - 1) {
    previewFiredBeats.clear()
  }
  previewLastLoop = loopPos

  // Update each preview ring independently
  for (const pr of previewEnemy.previewRings) {
    if (pr.attackTimer < 0) {
      for (const beat of pr.beats) {
        const key = `${pr.patternName}:${beat}`
        if (previewFiredBeats.has(key)) continue
        const d = Math.abs(loopPos - beat)
        const dist = Math.min(d, loopLen - d)
        if (dist < 0.08) {
          previewFiredBeats.add(key)
          const interval = getIntervalFromBeats(pr.beats, loopLen)
          pr.expandTime = Math.min(ATTACK_EXPAND_TIME, interval * BEAT_SEC * 0.8)
          pr.attackTimer = 0
          break
        }
      }
    }

    if (pr.attackTimer >= 0) {
      const prev = pr.attackTimer
      pr.attackTimer += dt
      if (pr.attackTimer >= pr.expandTime && prev < pr.expandTime) {
        playEnemyBeatTick(pr.patternName, pr.sound)
      }
      if (pr.attackTimer > pr.expandTime + 0.05) {
        pr.attackTimer = -1
      }
    }
  }
}

export function getDesignedEnemies(): DesignedEnemy[] {
  return designedEnemies
}

export function toggleDesigner(): void {
  visible = !visible
  if (panel) panel.style.display = visible ? 'block' : 'none'
  previewEnemy = null
  clearKeys()
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
    position: fixed; top: 10px; right: 10px; width: 440px;
    background: rgba(13,10,26,0.97); border: 1px solid rgba(79,195,247,0.3);
    border-radius: 8px; padding: 16px; color: #ccc; font: 12px monospace;
    z-index: 100; display: none; max-height: 90vh; overflow-y: auto;
  `

  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <span style="color:#4FC3F7;font-size:16px;font-weight:bold;">Workshop</span>
      <span id="ed-close" style="cursor:pointer;color:#666;font-size:18px;">✕</span>
    </div>

    <!-- Enemy Designer Section -->
    <div id="ed-enemy-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:8px;">
      <span style="color:#FF9800;font-size:13px;font-weight:bold;">Enemy Designer</span>
      <span id="ed-enemy-toggle" style="color:#666;font-size:12px;">▼</span>
    </div>
    <div id="ed-enemy-body">
      <div id="ed-list"></div>
      <button id="ed-add" style="width:100%;padding:8px;margin-top:6px;cursor:pointer;background:rgba(79,195,247,0.15);border:1px solid rgba(79,195,247,0.3);color:#4FC3F7;font:12px monospace;border-radius:4px;">+ Add Enemy Type</button>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <button id="ed-export" style="flex:1;padding:5px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#888;font:10px monospace;border-radius:3px;">Export</button>
        <button id="ed-import" style="flex:1;padding:5px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#888;font:10px monospace;border-radius:3px;">Import</button>
      </div>
    </div>

    <!-- Upgrades Section -->
    <div id="ed-upgrade-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);margin-top:12px;margin-bottom:8px;">
      <span style="color:#64FF78;font-size:13px;font-weight:bold;">Upgrades (Test)</span>
      <span id="ed-upgrade-toggle" style="color:#666;font-size:12px;">▼</span>
    </div>
    <div id="ed-upgrade-body">
      <div id="ed-upgrade-pool"></div>
      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);padding-top:6px;">
        <span style="color:#888;font-size:11px;">Active:</span>
        <div id="ed-upgrade-active" style="margin-top:4px;"></div>
        <button id="ed-upgrade-clear" style="width:100%;padding:5px;margin-top:6px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:10px monospace;border-radius:3px;">Clear All Upgrades</button>
      </div>
    </div>
  `

  document.body.appendChild(panel)

  panel.addEventListener('keydown', e => { e.stopPropagation() })
  panel.addEventListener('keyup', e => { e.stopPropagation() })

  panel.querySelector('#ed-close')!.addEventListener('click', toggleDesigner)
  panel.querySelector('#ed-add')!.addEventListener('click', () => addEnemyForm())
  panel.querySelector('#ed-export')!.addEventListener('click', () => exportEnemies())
  panel.querySelector('#ed-import')!.addEventListener('click', importEnemies)

  // Collapsible enemy section
  const enemyBody = panel.querySelector('#ed-enemy-body') as HTMLDivElement
  const enemyToggle = panel.querySelector('#ed-enemy-toggle') as HTMLSpanElement
  panel.querySelector('#ed-enemy-header')!.addEventListener('click', () => {
    enemySectionExpanded = !enemySectionExpanded
    enemyBody.style.display = enemySectionExpanded ? 'block' : 'none'
    enemyToggle.textContent = enemySectionExpanded ? '▼' : '▶'
  })

  // Collapsible upgrade section
  let upgradeSectionExpanded = true
  const upgradeBody = panel.querySelector('#ed-upgrade-body') as HTMLDivElement
  const upgradeToggle = panel.querySelector('#ed-upgrade-toggle') as HTMLSpanElement
  panel.querySelector('#ed-upgrade-header')!.addEventListener('click', () => {
    upgradeSectionExpanded = !upgradeSectionExpanded
    upgradeBody.style.display = upgradeSectionExpanded ? 'block' : 'none'
    upgradeToggle.textContent = upgradeSectionExpanded ? '▼' : '▶'
  })

  // Build upgrade test UI
  buildUpgradeTestUI()

  window.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault()
      toggleDesigner()
    }
  })

  // Restore saved enemies
  const saved = loadFromStorage()
  for (const enemy of saved) {
    designedEnemies.push(enemy)
    const typeIdx = ENEMY_TYPES.findIndex(t => t.name === enemy.name)
    if (typeIdx >= 0) ENEMY_TYPES[typeIdx] = enemy
    else ENEMY_TYPES.push(enemy)
    addEnemyForm(enemy)
  }
  if (saved.length > 0) rebuildPattern()
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
    if (expanded) {
      updatePreview()
    } else {
      previewEnemy = null
    }
  })

  body.innerHTML = `
    <button id="ed-del-${id}" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#666;cursor:pointer;font-size:16px;">✕</button>
    <div style="display:flex;gap:8px;margin-bottom:8px;">
      <div style="flex:1;"><span style="${labelCSS}">Name</span><input id="ed-name-${id}" value="${defaultName}" style="${inputCSS}"></div>
      <div><span style="${labelCSS}">Color</span><input id="ed-color-${id}" type="color" value="${defaultColor}" style="width:40px;height:32px;border:none;cursor:pointer;background:none;display:block;"></div>
    </div>
    <div id="ed-palette-${id}" style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:8px;"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin-bottom:8px;">
      <div><span style="${labelCSS}">HP</span><input id="ed-hp-${id}" type="text" value="${existing?.hp ?? 2}" style="${inputCSS}"></div>
      <div><span style="${labelCSS}">Speed</span><input id="ed-speed-${id}" type="text" value="${existing?.moveSpeed ?? 50}" style="${inputCSS}"></div>
      <div><span style="${labelCSS}">Size</span><input id="ed-radius-${id}" type="text" value="${existing?.radius ?? 40}" style="${inputCSS}"></div>
      <div><span style="${labelCSS}">Key</span><input id="ed-key-${id}" type="text" value="${existing?.key ?? (id + 1).toString()}" maxlength="1" style="${inputCSS}"></div>
    </div>
    <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center;">
      <div style="flex:1;">
        <span style="${labelCSS}">Movement</span>
        <select id="ed-move-${id}" style="${inputCSS}">
          <option value="pursue" ${(existing?.movePattern ?? 'pursue') === 'pursue' ? 'selected' : ''}>Pursue — chase to sweet spot</option>
          <option value="orbit" ${existing?.movePattern === 'orbit' ? 'selected' : ''}>Orbit — circle the player</option>
          <option value="zigzag" ${existing?.movePattern === 'zigzag' ? 'selected' : ''}>Zigzag — weave toward player</option>
          <option value="lunge" ${existing?.movePattern === 'lunge' ? 'selected' : ''}>Lunge — sits still, dashes on beat</option>
          <option value="bounce" ${existing?.movePattern === 'bounce' ? 'selected' : ''}>Bounce — ricochets off walls and bodies</option>
          <option value="stationary" ${existing?.movePattern === 'stationary' ? 'selected' : ''}>Stationary — turret</option>
          <option value="immovable" ${existing?.movePattern === 'immovable' ? 'selected' : ''}>Immovable — wall, can't be pushed</option>
        </select>
      </div>
      <!-- Tags section -->
      <div style="margin-top:12px;padding:8px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:4px;">
        <span style="color:#4FC3F7;font-size:11px;font-weight:bold;display:block;margin-bottom:6px;">Tags</span>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;">
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-blocks-${id}" type="checkbox" ${existing?.blocksRings ? 'checked' : ''}>
            <span style="color:#aaa;font:11px monospace;">Shield</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-consume-${id}" type="checkbox" ${existing?.consume ? 'checked' : ''}>
            <span style="color:#FF8080;font:11px monospace;">Consume</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-magnet-${id}" type="checkbox" ${existing?.magnet ? 'checked' : ''}>
            <span style="color:#50B4FF;font:11px monospace;">Magnet</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-blink-${id}" type="checkbox" ${existing?.blink ? 'checked' : ''}>
            <span style="color:#CE93D8;font:11px monospace;">Blink</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-volatile-${id}" type="checkbox" ${existing?.volatile ? 'checked' : ''}>
            <span style="color:#FF6D00;font:11px monospace;">Volatile</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-revenge-${id}" type="checkbox" ${existing?.revenge ? 'checked' : ''}>
            <span style="color:#FF5252;font:11px monospace;">Revenge</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-summon-${id}" type="checkbox" ${existing?.summon ? 'checked' : ''}>
            <span style="color:#FFD740;font:11px monospace;">Summon</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-totem-check-${id}" type="checkbox" ${existing?.totemSpawn ? 'checked' : ''}>
            <span style="color:#66BB6A;font:11px monospace;">Totem</span>
          </label>
        </div>
        <div id="ed-magnet-range-wrap-${id}" style="margin-top:6px;display:${existing?.magnet ? 'block' : 'none'};">
          <span style="color:#50B4FF;font:10px monospace;">Range: <span id="ed-magnet-range-val-${id}">${existing?.magnetRange ?? 200}</span></span>
          <input id="ed-magnet-range-${id}" type="range" min="80" max="500" step="10" value="${existing?.magnetRange ?? 200}" style="width:100%;">
        </div>
        <div id="ed-blink-beats-wrap-${id}" style="margin-top:4px;display:${existing?.blink ? 'block' : 'none'};">
          <span style="color:#CE93D8;font:10px monospace;">Every <span id="ed-blink-beats-val-${id}">${existing?.blinkBeats ?? 4}</span> beats</span>
          <input id="ed-blink-beats-${id}" type="range" min="2" max="16" step="1" value="${existing?.blinkBeats ?? 4}" style="width:100%;">
        </div>
        <div id="ed-volatile-range-wrap-${id}" style="margin-top:4px;display:${existing?.volatile ? 'block' : 'none'};">
          <span style="color:#FF6D00;font:10px monospace;">Blast: <span id="ed-volatile-range-val-${id}">${existing?.volatileRange ?? 150}</span></span>
          <input id="ed-volatile-range-${id}" type="range" min="80" max="400" step="10" value="${existing?.volatileRange ?? 150}" style="width:100%;">
        </div>
        <div id="ed-revenge-wrap-${id}" style="margin-top:4px;display:${existing?.revenge ? 'block' : 'none'};">
          <div style="display:flex;gap:6px;">
            <div style="flex:1;"><span style="color:#FF5252;font:9px monospace;">Rings: <span id="ed-revenge-rings-val-${id}">${existing?.revengeRings ?? 4}</span></span><input id="ed-revenge-rings-${id}" type="range" min="1" max="8" step="1" value="${existing?.revengeRings ?? 4}" style="width:100%;"></div>
            <div style="flex:1;"><span style="color:#FF5252;font:9px monospace;">Range: <span id="ed-revenge-radius-val-${id}">${existing?.revengeRadius ?? 120}</span></span><input id="ed-revenge-radius-${id}" type="range" min="60" max="300" step="10" value="${existing?.revengeRadius ?? 120}" style="width:100%;"></div>
          </div>
        </div>
        <div id="ed-summon-wrap-${id}" style="margin-top:4px;display:${existing?.summon ? 'block' : 'none'};">
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="color:#FFD740;font:10px monospace;">Nodes: <span id="ed-summon-nodes-val-${id}">${existing?.summonNodes ?? 3}</span></span>
            <input id="ed-summon-nodes-${id}" type="range" min="3" max="7" step="1" value="${existing?.summonNodes ?? 3}" style="flex:1;">
          </div>
          <div id="ed-summon-phases-${id}" style="margin-top:4px;">
            ${(existing?.summonPhases ?? [{ spawns: [] }]).map((phase: any, pi: number) =>
              `<div style="display:flex;gap:4px;align-items:center;margin-top:2px;">
                <span style="color:#FFD740;font:9px monospace;">P${pi + 1}:</span>
                <input class="ed-summon-phase" data-phase="${pi}" type="text" value="${(phase.spawns ?? []).map((s: any) => s.enemyName + ':' + s.count).join(', ')}" placeholder="enemy:count, enemy:count" style="flex:1;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
              </div>`
            ).join('')}
          </div>
          <button id="ed-summon-add-phase-${id}" style="margin-top:4px;padding:3px 8px;cursor:pointer;background:rgba(255,215,64,0.1);border:1px solid rgba(255,215,64,0.3);color:#FFD740;font:9px monospace;border-radius:3px;">+ Phase</button>
        </div>
        <div id="ed-totem-wrap-${id}" style="margin-top:4px;display:${existing?.totemSpawn ? 'block' : 'none'};">
          <span style="color:#66BB6A;font:10px monospace;">Spawn:</span>
          <input id="ed-totem-${id}" type="text" value="${existing?.totemSpawn ?? ''}" placeholder="enemy name" style="width:100%;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
        </div>
      </div>
      <!-- Behavior section -->
      <div style="margin-top:8px;display:flex;gap:8px;">
        <div style="flex:1;">
          <span style="${labelCSS}">Drop</span>
          <select id="ed-drop-${id}" style="width:100%;padding:4px 6px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:11px monospace;border-radius:3px;">
            <option value="xp" ${(existing?.dropType ?? 'xp') === 'xp' ? 'selected' : ''}>XP</option>
            <option value="hp" ${existing?.dropType === 'hp' ? 'selected' : ''}>HP</option>
            <option value="none" ${existing?.dropType === 'none' ? 'selected' : ''}>None</option>
          </select>
        </div>
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <span style="color:#4FC3F7;font-size:12px;font-weight:bold;">Rings</span>
      <button id="ed-addring-${id}" style="padding:3px 10px;cursor:pointer;background:rgba(79,195,247,0.15);border:1px solid rgba(79,195,247,0.3);color:#4FC3F7;font:11px monospace;border-radius:3px;">+ Ring</button>
    </div>
    <div id="ed-rings-${id}"></div>
    <div style="display:flex;gap:6px;margin-top:8px;">
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

  const ringsContainer = body.querySelector(`#ed-rings-${id}`) as HTMLDivElement
  let ringCounter = 0

  function addRingForm(rc?: RingConfig): void {
    const ri = ringCounter++
    const ringDiv = document.createElement('div')
    ringDiv.style.cssText = 'border:1px solid rgba(255,255,255,0.08);border-radius:4px;padding:6px;margin-bottom:4px;'
    const defaultBeats = rc?.beats?.join(', ') ?? '0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5'
    const defaultSound = rc?.sound ?? 'rim'
    const defaultRadius = rc?.ringRadius ?? 120

    ringDiv.innerHTML = `
      <div style="display:flex;gap:4px;margin-bottom:4px;align-items:center;">
        <span style="color:#666;font:10px monospace;flex-shrink:0;">Ring ${ri + 1}</span>
        <select class="ed-rsound" style="${inputCSS} flex:1;">
          ${SOUND_POOL.map(s => `<option value="${s}" ${s === defaultSound ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <input class="ed-rradius" type="text" value="${defaultRadius}" placeholder="Range" style="${inputCSS} width:60px;">
        <button class="ed-raudition" style="padding:4px 8px;cursor:pointer;background:rgba(255,255,255,0.1);border:1px solid #444;color:#fff;font:11px monospace;border-radius:3px;">♪</button>
        <button class="ed-rdel" style="background:none;border:none;color:#666;cursor:pointer;font-size:14px;">✕</button>
      </div>
      <select class="ed-rrhythm" style="${inputCSS} margin-bottom:3px;">
        <option value="offbeat">Offbeat</option>
        <option value="onbeat">On Beat</option>
        <option value="half">Half Time</option>
        <option value="double">Double Time</option>
        <option value="backbeat">Backbeat</option>
        <option value="synco1">Syncopated A</option>
        <option value="synco2">Syncopated B</option>
        <option value="triplet">Triplet</option>
        <option value="sparse">Sparse</option>
        <option value="gallop">Gallop</option>
        <option value="custom">Custom...</option>
      </select>
      <input class="ed-rbeats" type="text" value="${defaultBeats}" style="${inputCSS} display:none;" placeholder="0.5, 1.5...">
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;margin-top:4px;">
        <input class="ed-redge" type="checkbox" ${rc?.edgeMode ? 'checked' : ''}>
        <span style="color:#FFB74D;font:10px monospace;">Edge Fire</span>
      </label>
      <div class="ed-redge-opts" style="display:${rc?.edgeMode ? 'flex' : 'none'};gap:6px;margin-top:3px;">
        <div style="flex:1;"><span style="color:#999;font:9px monospace;">Points</span><input class="ed-redge-pts" type="number" min="2" max="6" value="${rc?.edgePoints ?? 3}" style="${inputCSS}"></div>
        <div style="flex:1;"><span style="color:#999;font:9px monospace;">Active</span><input class="ed-redge-act" type="number" min="1" max="6" value="${rc?.edgeActive ?? 1}" style="${inputCSS}"></div>
        <div style="flex:1;"><span style="color:#999;font:9px monospace;">Switch</span><input class="ed-redge-sw" type="number" min="1" max="8" value="${rc?.edgeSwitchBeats ?? 1}" style="${inputCSS}"></div>
      </div>
    `
    ringsContainer.appendChild(ringDiv)

    const rhythmSel = ringDiv.querySelector('.ed-rrhythm') as HTMLSelectElement
    const beatsInp = ringDiv.querySelector('.ed-rbeats') as HTMLInputElement

    // Match preset from existing beats
    if (rc?.beats) {
      const bs = rc.beats.join(', ')
      let matched = false
      for (const [key, preset] of Object.entries(RHYTHM_PRESETS)) {
        if (preset.join(', ') === bs) { rhythmSel.value = key; matched = true; break }
      }
      if (!matched) { rhythmSel.value = 'custom'; beatsInp.style.display = 'block' }
    }

    rhythmSel.addEventListener('change', () => {
      if (rhythmSel.value === 'custom') {
        beatsInp.style.display = 'block'
      } else {
        beatsInp.style.display = 'none'
        beatsInp.value = (RHYTHM_PRESETS[rhythmSel.value] ?? []).join(', ')
      }
      updatePreview()
    })

    const edgeCheck = ringDiv.querySelector('.ed-redge') as HTMLInputElement
    const edgeOpts = ringDiv.querySelector('.ed-redge-opts') as HTMLDivElement
    edgeCheck.addEventListener('change', () => {
      edgeOpts.style.display = edgeCheck.checked ? 'flex' : 'none'
    })

    ringDiv.querySelector('.ed-rdel')!.addEventListener('click', () => {
      ringDiv.remove()
      updatePreview()
    })

    ringDiv.querySelector('.ed-raudition')!.addEventListener('click', () => {
      const sound = (ringDiv.querySelector('.ed-rsound') as HTMLSelectElement).value
      playEnemyBeatTick('audition', sound)
    })

    // Wire inputs to preview
    ringDiv.querySelectorAll('input, select').forEach(inp => {
      inp.addEventListener('input', updatePreview)
      inp.addEventListener('change', updatePreview)
    })
  }

  function readRingForms(): RingConfig[] {
    const ringDivs = ringsContainer.querySelectorAll(':scope > div')
    const result: RingConfig[] = []
    ringDivs.forEach(rd => {
      const sound = (rd.querySelector('.ed-rsound') as HTMLSelectElement).value
      const ringRadius = parseInt((rd.querySelector('.ed-rradius') as HTMLInputElement).value) || 120
      const beatsStr = (rd.querySelector('.ed-rbeats') as HTMLInputElement).value
      const beats = beatsStr.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n))
      const edgeMode = (rd.querySelector('.ed-redge') as HTMLInputElement)?.checked ?? false
      const edgePoints = parseInt((rd.querySelector('.ed-redge-pts') as HTMLInputElement)?.value) || 3
      const edgeActive = parseInt((rd.querySelector('.ed-redge-act') as HTMLInputElement)?.value) || 1
      const edgeSwitchBeats = parseInt((rd.querySelector('.ed-redge-sw') as HTMLInputElement)?.value) || 1
      result.push({ ringRadius, sound, beats, edgeMode, edgePoints, edgeActive, edgeSwitchBeats })
    })
    return result
  }

  // Add ring button
  body.querySelector(`#ed-addring-${id}`)!.addEventListener('click', () => addRingForm())

  // Color palette swatches
  const paletteDiv = body.querySelector(`#ed-palette-${id}`) as HTMLDivElement
  const colorInput = body.querySelector(`#ed-color-${id}`) as HTMLInputElement
  for (const c of ENEMY_PALETTE) {
    const swatch = document.createElement('div')
    swatch.style.cssText = `width:14px;height:14px;border-radius:2px;cursor:pointer;background:${c};border:1px solid rgba(255,255,255,0.1);`
    swatch.addEventListener('click', () => {
      colorInput.value = c
      updatePreview()
    })
    paletteDiv.appendChild(swatch)
  }

  // Initialize rings from existing data
  const initRings = existing?.rings ?? [{ ringRadius: 140, sound: 'rim', beats: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5] }]
  for (const rc of initRings) addRingForm(rc)

  // Magnet checkbox toggles range slider visibility
  const magnetCheckbox = body.querySelector(`#ed-magnet-${id}`) as HTMLInputElement
  const magnetRangeWrap = body.querySelector(`#ed-magnet-range-wrap-${id}`) as HTMLDivElement
  const magnetRangeInput = body.querySelector(`#ed-magnet-range-${id}`) as HTMLInputElement
  const magnetRangeVal = body.querySelector(`#ed-magnet-range-val-${id}`) as HTMLSpanElement
  magnetCheckbox.addEventListener('change', () => {
    magnetRangeWrap.style.display = magnetCheckbox.checked ? 'block' : 'none'
  })
  magnetRangeInput.addEventListener('input', () => {
    magnetRangeVal.textContent = magnetRangeInput.value
  })

  // Blink checkbox toggles beats slider
  const blinkCheckbox = body.querySelector(`#ed-blink-${id}`) as HTMLInputElement
  const blinkBeatsWrap = body.querySelector(`#ed-blink-beats-wrap-${id}`) as HTMLDivElement
  const blinkBeatsInput = body.querySelector(`#ed-blink-beats-${id}`) as HTMLInputElement
  const blinkBeatsVal = body.querySelector(`#ed-blink-beats-val-${id}`) as HTMLSpanElement
  blinkCheckbox.addEventListener('change', () => {
    blinkBeatsWrap.style.display = blinkCheckbox.checked ? 'block' : 'none'
  })
  blinkBeatsInput.addEventListener('input', () => {
    blinkBeatsVal.textContent = blinkBeatsInput.value
  })

  // Volatile checkbox toggles range slider
  const volatileCheckbox = body.querySelector(`#ed-volatile-${id}`) as HTMLInputElement
  const volatileRangeWrap = body.querySelector(`#ed-volatile-range-wrap-${id}`) as HTMLDivElement
  const volatileRangeInput = body.querySelector(`#ed-volatile-range-${id}`) as HTMLInputElement
  const volatileRangeVal = body.querySelector(`#ed-volatile-range-val-${id}`) as HTMLSpanElement
  volatileCheckbox.addEventListener('change', () => {
    volatileRangeWrap.style.display = volatileCheckbox.checked ? 'block' : 'none'
  })
  volatileRangeInput.addEventListener('input', () => {
    volatileRangeVal.textContent = volatileRangeInput.value
  })

  // Revenge checkbox toggles sliders
  const revengeCheckbox = body.querySelector(`#ed-revenge-${id}`) as HTMLInputElement
  const revengeWrap = body.querySelector(`#ed-revenge-wrap-${id}`) as HTMLDivElement
  const revengeRingsInput = body.querySelector(`#ed-revenge-rings-${id}`) as HTMLInputElement
  const revengeRingsVal = body.querySelector(`#ed-revenge-rings-val-${id}`) as HTMLSpanElement
  const revengeRadiusInput = body.querySelector(`#ed-revenge-radius-${id}`) as HTMLInputElement
  const revengeRadiusVal = body.querySelector(`#ed-revenge-radius-val-${id}`) as HTMLSpanElement
  revengeCheckbox.addEventListener('change', () => {
    revengeWrap.style.display = revengeCheckbox.checked ? 'block' : 'none'
  })
  revengeRingsInput.addEventListener('input', () => { revengeRingsVal.textContent = revengeRingsInput.value })
  revengeRadiusInput.addEventListener('input', () => { revengeRadiusVal.textContent = revengeRadiusInput.value })

  // Summon tag wiring
  const summonCheckbox = body.querySelector(`#ed-summon-${id}`) as HTMLInputElement
  const summonWrap = body.querySelector(`#ed-summon-wrap-${id}`) as HTMLDivElement
  const summonNodesInput = body.querySelector(`#ed-summon-nodes-${id}`) as HTMLInputElement
  const summonNodesVal = body.querySelector(`#ed-summon-nodes-val-${id}`) as HTMLSpanElement
  const summonPhasesDiv = body.querySelector(`#ed-summon-phases-${id}`) as HTMLDivElement
  const summonAddPhase = body.querySelector(`#ed-summon-add-phase-${id}`) as HTMLButtonElement
  summonCheckbox.addEventListener('change', () => {
    summonWrap.style.display = summonCheckbox.checked ? 'block' : 'none'
  })
  summonNodesInput.addEventListener('input', () => { summonNodesVal.textContent = summonNodesInput.value })
  summonAddPhase.addEventListener('click', () => {
    const phaseCount = summonPhasesDiv.querySelectorAll('.ed-summon-phase').length
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;gap:4px;align-items:center;margin-top:2px;'
    row.innerHTML = `<span style="color:#FFD740;font:9px monospace;">P${phaseCount + 1}:</span><input class="ed-summon-phase" data-phase="${phaseCount}" type="text" value="" placeholder="enemy:count, enemy:count" style="flex:1;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">`
    summonPhasesDiv.appendChild(row)
  })

  // Totem tag wiring
  const totemCheckbox = body.querySelector(`#ed-totem-check-${id}`) as HTMLInputElement
  const totemWrap = body.querySelector(`#ed-totem-wrap-${id}`) as HTMLDivElement
  totemCheckbox.addEventListener('change', () => {
    totemWrap.style.display = totemCheckbox.checked ? 'block' : 'none'
  })

  function updatePreview(): void {
    const form = readForm()
    const newRings: PreviewRing[] = form.rings.map((rc, i) => {
      const pName = form.rings.length > 1 ? `_preview_${form.name}_r${i}` : `_preview_${form.name}`
      // Preserve existing attack timer if ring count matches
      const existing = previewEnemy?.previewRings[i]
      return {
        ringRadius: rc.ringRadius,
        beats: rc.beats,
        sound: rc.sound,
        attackTimer: existing?.attackTimer ?? -1,
        expandTime: existing?.expandTime ?? ATTACK_EXPAND_TIME,
        patternName: pName,
        edgeMode: rc.edgeMode ?? false,
        edgePoints: rc.edgePoints ?? 3,
        edgeActive: rc.edgeActive ?? 1,
      }
    })
    previewEnemy = {
      radius: form.radius,
      color: form.color,
      name: form.name,
      moveSpeed: form.moveSpeed,
      previewRings: newRings,
      immovable: form.movePattern === 'immovable',
      consume: form.consume ?? false,
      magnet: form.magnet ?? false,
      magnetRange: form.magnetRange ?? 200,
      volatile: form.volatile ?? false,
      volatileRange: form.volatileRange ?? 150,
      revenge: form.revenge ?? false,
      revengeRings: form.revengeRings ?? 4,
      revengeRadius: form.revengeRadius ?? 120,
      totemSpawn: form.totemSpawn ?? '',
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
    saveToStorage()
  })

  function readForm(): DesignedEnemy {
    const name = (div.querySelector(`#ed-name-${id}`) as HTMLInputElement).value
    const color = (div.querySelector(`#ed-color-${id}`) as HTMLInputElement).value
    const hp = parseInt((div.querySelector(`#ed-hp-${id}`) as HTMLInputElement).value) || 2
    const speed = parseInt((div.querySelector(`#ed-speed-${id}`) as HTMLInputElement).value) || 50
    const radius = parseInt((div.querySelector(`#ed-radius-${id}`) as HTMLInputElement).value) || 40
    const key = (div.querySelector(`#ed-key-${id}`) as HTMLInputElement).value || (id + 1).toString()
    const blocksRings = (div.querySelector(`#ed-blocks-${id}`) as HTMLInputElement).checked
    const consume = (div.querySelector(`#ed-consume-${id}`) as HTMLInputElement).checked
    const magnet = (div.querySelector(`#ed-magnet-${id}`) as HTMLInputElement).checked
    const magnetRange = parseInt((div.querySelector(`#ed-magnet-range-${id}`) as HTMLInputElement).value) || 200
    const blink = (div.querySelector(`#ed-blink-${id}`) as HTMLInputElement).checked
    const blinkBeats = parseInt((div.querySelector(`#ed-blink-beats-${id}`) as HTMLInputElement).value) || 4
    const volatile_ = (div.querySelector(`#ed-volatile-${id}`) as HTMLInputElement).checked
    const volatileRange = parseInt((div.querySelector(`#ed-volatile-range-${id}`) as HTMLInputElement).value) || 150
    const revenge = (div.querySelector(`#ed-revenge-${id}`) as HTMLInputElement).checked
    const revengeRings = parseInt((div.querySelector(`#ed-revenge-rings-${id}`) as HTMLInputElement).value) || 4
    const revengeRadius = parseInt((div.querySelector(`#ed-revenge-radius-${id}`) as HTMLInputElement).value) || 120
    const totemSpawn = (div.querySelector(`#ed-totem-${id}`) as HTMLInputElement).value.trim()
    const summon = (div.querySelector(`#ed-summon-${id}`) as HTMLInputElement).checked
    const summonNodes = parseInt((div.querySelector(`#ed-summon-nodes-${id}`) as HTMLInputElement).value) || 3
    const summonPhaseInputs = div.querySelectorAll(`#ed-summon-phases-${id} .ed-summon-phase`) as NodeListOf<HTMLInputElement>
    const summonPhases: import('../entities/EnemyTypes.ts').SummonPhase[] = []
    summonPhaseInputs.forEach(input => {
      const text = input.value.trim()
      if (!text) return
      const spawns = text.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const [name, count] = s.split(':')
        return { enemyName: name?.trim() ?? '', count: parseInt(count ?? '1') || 1 }
      }).filter(s => s.enemyName)
      if (spawns.length > 0) summonPhases.push({ spawns })
    })
    const dropType = (div.querySelector(`#ed-drop-${id}`) as HTMLSelectElement).value as 'xp' | 'hp' | 'none'
    const movePattern = (div.querySelector(`#ed-move-${id}`) as HTMLSelectElement).value as import('../entities/EnemyTypes.ts').MovePattern
    const rings: RingConfig[] = readRingForms()
    const sound = (rings[0]?.sound ?? 'pop') as SoundName
    const beats = rings[0]?.beats ?? []
    const ringRadius = rings[0]?.ringRadius ?? 120
    return { name, color, hp, moveSpeed: speed, radius, ringRadius, key, role: sound, sound, beats, rings, blocksRings, consume, magnet, magnetRange, blink, blinkBeats, volatile: volatile_, volatileRange, revenge, revengeRings, revengeRadius, movePattern, totemSpawn, dropType, summon, summonNodes, summonPhases }
  }


  // Track which saved entry this form owns
  let savedName: string | null = existing?.name ?? null

  // Save — collapse and update header
  div.querySelector(`#ed-save-${id}`)!.addEventListener('click', () => {
    const designed = readForm()

    // If we previously saved under a different name, remove the old entry
    if (savedName && savedName !== designed.name) {
      const oldIdx = designedEnemies.findIndex(e => e.name === savedName)
      if (oldIdx >= 0) designedEnemies.splice(oldIdx, 1)
      const oldTypeIdx = ENEMY_TYPES.findIndex(t => t.name === savedName)
      if (oldTypeIdx >= 0) ENEMY_TYPES.splice(oldTypeIdx, 1)
    }

    // Check name conflict with OTHER forms (not our own saved entry)
    if (designed.name !== savedName) {
      const conflict = designedEnemies.some(e => e.name === designed.name)
      if (conflict) {
        designed.name = resolveNameConflict(designed.name)
        const nameInput = div.querySelector(`#ed-name-${id}`) as HTMLInputElement
        nameInput.value = designed.name
      }
    }

    // Update or add
    const idx = designedEnemies.findIndex(e => e.name === designed.name)
    if (idx >= 0) {
      designedEnemies[idx] = designed
    } else {
      designedEnemies.push(designed)
    }

    savedName = designed.name
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
    headerRhythm.textContent = `${designed.rings.length} ring${designed.rings.length > 1 ? 's' : ''}`
    headerSound.textContent = designed.rings.map(r => r.sound).join(', ')
    // Collapse
    expanded = false
    body.style.display = 'none'
    previewEnemy = null
    div.style.borderColor = 'rgba(100,255,120,0.5)'
    setTimeout(() => div.style.borderColor = 'rgba(255,255,255,0.1)', 400)
    saveToStorage()
    exportEnemies()  // auto-save to project folder
  })

  // Spawn
  div.querySelector(`#ed-spawn-${id}`)!.addEventListener('click', () => {
    const designed = readForm()
    if (!ENEMY_TYPES.find(t => t.name === designed.name)) ENEMY_TYPES.push(designed)
    const player = getPlayer()
    const pos = getSpawnPos(player.x, player.y)
    getEnemies().push(createEnemy(pos.x, pos.y, designed))
  })
}

function rebuildPattern(): void {
  const pat = getPattern()
  const patterns: Record<string, number[]> = pat ? { ...pat.patterns } : {
    'Player': [0, 1, 2, 3, 4, 5, 6, 7],
  }
  for (const de of designedEnemies) {
    if (de.rings.length <= 1) {
      // Single ring — use enemy name as pattern key
      patterns[de.name] = de.beats
    } else {
      // Multiple rings — each gets its own pattern key
      for (let i = 0; i < de.rings.length; i++) {
        patterns[`${de.name}_r${i}`] = de.rings[i]!.beats
      }
    }
  }
  setPattern({ name: 'Custom', loopBeats: pat?.loopBeats ?? 8, patterns })
}

function buildUpgradeTestUI(): void {
  const poolDiv = panel!.querySelector('#ed-upgrade-pool') as HTMLDivElement
  const activeDiv = panel!.querySelector('#ed-upgrade-active') as HTMLDivElement

  function refreshUpgradeUI(): void {
    poolDiv.innerHTML = ''

    // Split into stat and game tiers
    const statUpgrades = UPGRADE_POOL.filter(d => (d.tier ?? 'stat') === 'stat')
    const gameUpgrades = UPGRADE_POOL.filter(d => d.tier === 'game')
    const active = getActiveUpgrades()

    function addPoolSection(title: string, upgrades: typeof UPGRADE_POOL): void {
      if (upgrades.length === 0) return
      const label = document.createElement('div')
      label.style.cssText = 'color:#888;font-size:10px;margin:6px 0 3px 0;'
      label.textContent = title
      poolDiv.appendChild(label)

      for (const def of upgrades) {
        // Check max stacks
        const currentStacks = active.filter(u => u.name === def.name).length
        const maxed = def.maxStacks !== undefined && currentStacks >= def.maxStacks

        const btn = document.createElement('button')
        btn.style.cssText = `
          display:inline-block;padding:4px 8px;margin:2px;cursor:${maxed ? 'default' : 'pointer'};
          background:rgba(255,255,255,${maxed ? '0.02' : '0.05'});border:1px solid ${maxed ? '#333' : def.color + '40'};
          color:${maxed ? '#444' : def.color};font:11px monospace;border-radius:4px;
          ${maxed ? 'text-decoration:line-through;' : ''}
        `
        btn.textContent = `+ ${def.name}`
        btn.title = maxed ? `MAX (${def.maxStacks})` : def.description
        if (!maxed) {
          btn.addEventListener('click', () => {
            addUpgrade({
              id: def.id + '_' + Date.now(),
              name: def.name,
              description: def.description,
              bonus: def.bonus,
            })
            applyModifiers(getPlayer())
            refreshUpgradeUI()
          })
        }
        poolDiv.appendChild(btn)
      }
    }

    addPoolSection('Stat Boosts', statUpgrades)
    addPoolSection('Game Changers', gameUpgrades)

    // Active — show stacked counts
    activeDiv.innerHTML = ''
    const currentActive = getActiveUpgrades()
    if (currentActive.length === 0) {
      activeDiv.innerHTML = '<span style="color:#555;font-size:10px;">None</span>'
      return
    }

    // Group by name
    const counts = new Map<string, { count: number; desc: string; color: string; ids: string[] }>()
    for (const u of currentActive) {
      const def = UPGRADE_POOL.find(d => u.name === d.name)
      const existing = counts.get(u.name)
      if (existing) {
        existing.count++
        existing.ids.push(u.id)
      } else {
        counts.set(u.name, { count: 1, desc: u.description, color: def?.color ?? '#888', ids: [u.id] })
      }
    }

    for (const [name, info] of counts) {
      const badge = document.createElement('span')
      badge.style.cssText = `
        display:inline-block;padding:3px 8px;margin:2px;cursor:pointer;
        background:${info.color}20;border:1px solid ${info.color}50;
        color:${info.color};font:11px monospace;border-radius:4px;
      `
      badge.textContent = info.count > 1 ? `${name} x${info.count}` : name
      badge.title = `${info.desc} (click to remove one)`
      badge.addEventListener('click', () => {
        const lastId = info.ids.pop()
        if (lastId) {
          removeUpgrade(lastId)
          applyModifiers(getPlayer())
          refreshUpgradeUI()
        }
      })
      activeDiv.appendChild(badge)
    }
  }

  // Clear all button
  panel!.querySelector('#ed-upgrade-clear')!.addEventListener('click', () => {
    const active = getActiveUpgrades()
    while (active.length > 0) {
      removeUpgrade(active[0]!.id)
    }
    applyModifiers(getPlayer())
    refreshUpgradeUI()
  })

  refreshUpgradeUI()
}

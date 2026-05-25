import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import defaultEnemies from '../../data/enemies.json'
import * as ChallengeBuilder from './ChallengeBuilder.ts'
import type { Challenge } from './ChallengeBuilder.ts'
import type { EnemyType, ShrinePhase } from '../entities/EnemyTypes.ts'

// Shrine phase string format: "xp:3, hp:1, enemy:Name:2, shop"
function phaseToString(phase: ShrinePhase): string {
  const parts: string[] = []
  if (phase.xpOrbs) parts.push(`xp:${phase.xpOrbs}`)
  if (phase.hpOrbs) parts.push(`hp:${phase.hpOrbs}`)
  if (phase.spawnEnemy) parts.push(`enemy:${phase.spawnEnemy}${phase.spawnCount && phase.spawnCount > 1 ? ':' + phase.spawnCount : ''}`)
  if (phase.isShop) parts.push('shop')
  return parts.join(', ') || 'xp:3'
}

function parsePhaseString(str: string): ShrinePhase {
  const phase: ShrinePhase = {}
  const parts = str.split(',').map(s => s.trim()).filter(Boolean)
  for (const part of parts) {
    if (part === 'shop') { phase.isShop = true; continue }
    const [key, ...rest] = part.split(':')
    const k = key!.toLowerCase().trim()
    if (k === 'xp') phase.xpOrbs = parseInt(rest[0] ?? '1') || 1
    else if (k === 'hp') phase.hpOrbs = parseInt(rest[0] ?? '1') || 1
    else if (k === 'enemy') {
      phase.spawnEnemy = rest[0] ?? ''
      if (rest[1]) phase.spawnCount = parseInt(rest[1]) || 1
    }
  }
  return phase
}
import type { SongPattern } from '../audio/SongPatterns.ts'
import { setPattern, getPattern, getLoopPosition, getLoopLength } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies, getPhase } from '../core/GameState.ts'
import { findClearSpawnPos } from '../game/Arena.ts'
import * as Renderer from '../render/Renderer.ts'
import { clearDesignerEphemerals } from '../core/GameManager.ts'
import { createEnemy } from '../entities/Enemy.ts'
import { getSpawnPos, getPerimeterSpawnPos } from './Arena.ts'
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
    const stored = data.enemies ?? []
    // Merge missing bundled enemies (don't overwrite user edits — add-if-missing only)
    const bundled = (defaultEnemies as SaveData).enemies ?? []
    let added = false
    for (const be of bundled) {
      if (!stored.find(e => e.name === be.name)) {
        stored.push(be)
        added = true
      }
    }
    if (added) localStorage.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, enemies: stored }))
    return stored
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
  const data = {
    version: SAVE_VERSION,
    enemies: designedEnemies,
    challenges: ChallengeBuilder.getChallenges(),
    wallPrefabs: ChallengeBuilder.getWallPrefabs(),
  }
  const json = JSON.stringify(data, null, 2)
  // Save to project folder via dev server
  fetch('/api/save-enemies', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: json,
  }).catch(() => {})
  // Always download as file too
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'beatback-data.json'
  a.click()
  URL.revokeObjectURL(url)
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
        const data = JSON.parse(reader.result as string) as SaveData & { challenges?: Challenge[] }
        // Import enemies
        if (data.enemies?.length) {
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
        }
        // Import challenges
        if (data.challenges?.length) {
          ChallengeBuilder.importChallenges(JSON.stringify(data.challenges))
        }
        // Import wall prefab library (added in 2026; absent in older exports)
        const incoming = (data as any).wallPrefabs
        if (Array.isArray(incoming) && incoming.length > 0) {
          ChallengeBuilder.importWallPrefabs(incoming)
        }
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
  dodge: boolean
  dodgeCharges: number
  dodgeChargeTime: number
  dodgeDistance: number
  dodgeSpeed: number
  shield: boolean
  shieldRechargeTime: number
  totemSpawn: string
  isShrine: boolean
  shrineSpawnEnemy: string
  shrineXpCount: number
  shrineHpCount: number
  shrinePhases: import('../entities/EnemyTypes.ts').ShrinePhase[]
}
let previewEnemy: PreviewEnemy | null = null

let enemySectionExpanded = false
let startChallengeCallback: ((ch: Challenge) => void) | null = null
let testPlayCallback: (() => void) | null = null
export let challengeCanvasClick: ((x: number, y: number) => boolean) | null = null
export let challengeCanvasMouseMove: ((x: number, y: number, shift?: boolean) => void) | null = null
export let challengeCanvasMouseDown: ((x: number, y: number, shift?: boolean) => boolean) | null = null
export let challengeCanvasMouseUp: (() => void) | null = null
export function onStartChallenge(cb: (ch: Challenge) => void): void { startChallengeCallback = cb }
export function onTestPlay(cb: () => void): void { testPlayCallback = cb }

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

function spawnTestEnemy(typeName: string): void {
  const type = ENEMY_TYPES.find(t => t.name === typeName)
  if (!type) return
  const player = getPlayer()
  // Spawn in a ring 500-700px from the player — comfortable middle distance, not right on
  // top, not all the way at the perimeter. Clamped to arena so spawns near a wall slide
  // to a valid in-arena position.
  const angle = Math.random() * Math.PI * 2
  const dist = 500 + Math.random() * 200
  const sx = player.x + Math.cos(angle) * dist
  const sy = player.y + Math.sin(angle) * dist
  const radius = (type as any).radius ?? 40
  const pos = findClearSpawnPos(sx, sy, radius, getEnemies(), player)
  const e = createEnemy(pos.x, pos.y, type)
  e.designerEphemeral = true
  getEnemies().push(e)
}

function clearTestEnemies(): void {
  const enemies = getEnemies()
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (enemies[i]!.designerEphemeral) enemies.splice(i, 1)
  }
}

function rebuildSpawnStrip(container: HTMLDivElement): void {
  container.innerHTML = ''
  for (const t of ENEMY_TYPES) {
    const btn = document.createElement('button')
    btn.textContent = t.name
    btn.style.cssText = `padding:3px 7px;cursor:pointer;background:${t.color}22;border:1px solid ${t.color}66;color:${t.color};font:9px monospace;border-radius:2px;`
    btn.addEventListener('click', () => spawnTestEnemy(t.name))
    container.appendChild(btn)
  }
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

    <!-- Spawn-Test strip (designer scene only) -->
    <div style="margin-bottom:10px;padding:6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:4px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
        <span style="color:#888;font:10px monospace;">Spawn-Test (designer only)</span>
        <button id="ed-st-clear" style="padding:2px 8px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:9px monospace;border-radius:2px;">Clear</button>
      </div>
      <div id="ed-st-strip" style="display:flex;flex-wrap:wrap;gap:3px;"></div>
    </div>

    <!-- Enemy Designer Section -->
    <div id="ed-enemy-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);margin-bottom:8px;">
      <span style="color:#FF9800;font-size:13px;font-weight:bold;">Enemy Designer</span>
      <span id="ed-enemy-toggle" style="color:#666;font-size:12px;">▶</span>
    </div>
    <div id="ed-enemy-body" style="display:none;">
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
      <span id="ed-upgrade-toggle" style="color:#666;font-size:12px;">▶</span>
    </div>
    <div id="ed-upgrade-body" style="display:none;">
      <div id="ed-upgrade-pool"></div>
      <div style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);padding-top:6px;">
        <span style="color:#888;font-size:11px;">Active:</span>
        <div id="ed-upgrade-active" style="margin-top:4px;"></div>
        <button id="ed-upgrade-clear" style="width:100%;padding:5px;margin-top:6px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:10px monospace;border-radius:3px;">Clear All Upgrades</button>
      </div>
    </div>

    <!-- Challenge Builder Section -->
    <div id="ed-challenge-header" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.1);margin-top:12px;margin-bottom:8px;">
      <span style="color:#FFD740;font-size:13px;font-weight:bold;">Challenge Builder</span>
      <span id="ed-challenge-toggle" style="color:#666;font-size:12px;">▶</span>
    </div>
    <div id="ed-challenge-body" style="display:none;">
      <div style="display:flex;gap:6px;margin-bottom:6px;">
        <input id="ed-ch-name" type="text" value="new_challenge" placeholder="Challenge name" style="flex:1;padding:4px 6px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:11px monospace;border-radius:3px;">
        <select id="ed-ch-arena" style="padding:4px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:11px monospace;border-radius:3px;">
          <option value="rect">Rect</option>
          <option value="circle" selected>Circle</option>
          <option value="hex">Hex</option>
          <option value="pill">Pill</option>
          <option value="cross">Cross</option>
        </select>
      </div>
      <div style="margin-bottom:6px;">
        <span style="color:#aaa;font:10px monospace;">Pick a type → click arena to place. Click an existing ghost to select; drag to move; Delete to remove.</span>
      </div>
      <div id="ed-ch-types" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;"></div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:5px;background:rgba(128,216,255,0.05);border:1px solid rgba(128,216,255,0.15);border-radius:3px;">
        <button id="ed-ch-tool-wall" style="padding:4px 10px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#80D8FF;font:10px monospace;border-radius:3px;">Wall</button>
        <button id="ed-ch-tool-pillar" style="padding:4px 10px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#80D8FF;font:10px monospace;border-radius:3px;">Pillar</button>
        <span style="color:#aaa;font:10px monospace;">Thick</span>
        <input id="ed-ch-wall-thick" type="range" min="6" max="240" value="16" step="2" style="flex:1;">
        <span id="ed-ch-wall-thick-val" style="color:#80D8FF;font:10px monospace;min-width:18px;text-align:right;">16</span>
        <button id="ed-ch-walls-clear" style="padding:4px 8px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:10px monospace;border-radius:3px;">Clear Walls</button>
      </div>
      <div id="ed-ch-tool-hint" style="font:10px monospace;color:#666;margin-bottom:6px;">Wall: click & drag. Pillar: single click. Right-click any wall or enemy to delete it (red highlight = will delete). Endpoint snap on (~15px). Esc cancels a drag.</div>
      <div id="ed-wall-props" style="display:none;margin-bottom:6px;padding:6px;background:rgba(255,215,64,0.05);border:1px solid rgba(255,215,64,0.20);border-radius:3px;">
        <div style="color:#FFD740;font:10px monospace;margin-bottom:4px;font-weight:bold;">Wall Properties (selected)</div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
          <span style="color:#aaa;font:10px monospace;">Thickness</span>
          <input id="ed-wall-prop-thick" type="range" min="6" max="240" step="2" value="16" style="flex:1;min-width:120px;">
          <span id="ed-wall-prop-thick-val" style="color:#80D8FF;font:10px monospace;min-width:24px;text-align:right;">16</span>
          <label style="display:flex;align-items:center;gap:3px;cursor:pointer;margin-left:6px;">
            <input id="ed-wall-prop-noclip" type="checkbox">
            <span style="color:#FF5252;font:10px monospace;" title="When on, this wall won't auto-connect to neighbors and won't be a snap target. Use for isolated obstacles.">No-clip</span>
          </label>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
          <span style="color:#aaa;font:10px monospace;">Motion</span>
          <select id="ed-wall-motion-type" style="padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <option value="none">None (static)</option>
            <option value="rotate">Rotate</option>
            <option value="pendulum">Pendulum</option>
            <option value="tick">Tick (clock)</option>
          </select>
          <div id="ed-wall-motion-rotate-params" style="display:none;gap:6px;align-items:center;flex-wrap:wrap;">
            <span style="color:#aaa;font:10px monospace;">Beats/cycle</span>
            <input id="ed-wall-motion-beats" type="number" min="0.25" max="32" step="0.25" value="4" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <span style="color:#aaa;font:10px monospace;">Direction</span>
            <select id="ed-wall-motion-dir" style="padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
              <option value="1">CW ↻</option>
              <option value="-1">CCW ↺</option>
            </select>
            <span style="color:#aaa;font:10px monospace;">Phase</span>
            <input id="ed-wall-motion-phase" type="number" min="0" max="32" step="0.25" value="0" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <span id="ed-wall-motion-sweep-label" style="color:#aaa;font:10px monospace;display:none;">Sweep</span>
            <input id="ed-wall-motion-sweep" type="number" min="10" max="360" step="5" value="90" style="width:55px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;display:none;">
            <span id="ed-wall-motion-sweep-unit" style="color:#aaa;font:10px monospace;display:none;">°</span>
            <span id="ed-wall-motion-deg-label" style="color:#aaa;font:10px monospace;display:none;">°/tick</span>
            <input id="ed-wall-motion-deg" type="number" min="1" max="180" step="1" value="30" style="width:55px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;display:none;">
            <span id="ed-wall-motion-pause-label" style="color:#aaa;font:10px monospace;display:none;">Pause</span>
            <input id="ed-wall-motion-pause" type="number" min="0" max="1" step="0.05" value="0.6" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;display:none;">
            <span id="ed-wall-motion-rev-label" style="color:#aaa;font:10px monospace;display:none;">Reverse after</span>
            <input id="ed-wall-motion-rev" type="number" min="0" max="32" step="1" value="0" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;display:none;">
            <span id="ed-wall-motion-rev-unit" style="color:#aaa;font:10px monospace;display:none;">ticks</span>
          </div>
        </div>
        <div id="ed-wall-motion-help" style="color:#666;font:9px monospace;">Rotates around the connected piece's bbox center. Test Play to see it animate.</div>
        <div id="ed-wall-pivot-row" style="margin-top:4px;display:none;gap:6px;align-items:center;flex-wrap:wrap;">
          <span style="color:#aaa;font:10px monospace;">Pivot</span>
          <span id="ed-wall-pivot-status" style="color:#FFD740;font:9px monospace;">● Bbox center</span>
          <button id="ed-wall-pivot-set" style="padding:2px 8px;cursor:pointer;background:rgba(255,215,64,0.15);border:1px solid rgba(255,215,64,0.4);color:#FFD740;font:10px monospace;border-radius:3px;">Set Pivot…</button>
          <button id="ed-wall-pivot-reset" style="padding:2px 8px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#aaa;font:10px monospace;border-radius:3px;">Reset</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,215,64,0.15);flex-wrap:wrap;">
          <span style="color:#aaa;font:10px monospace;">Translate</span>
          <select id="ed-wall-trans-type" style="padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <option value="none">None</option>
            <option value="horizontal">Horizontal ↔</option>
            <option value="vertical">Vertical ↕</option>
            <option value="circle">Circle ◯</option>
            <option value="square">Square ▢</option>
          </select>
          <div id="ed-wall-trans-params" style="display:none;gap:6px;align-items:center;flex-wrap:wrap;">
            <span style="color:#aaa;font:10px monospace;">Beats/cycle</span>
            <input id="ed-wall-trans-beats" type="number" min="0.25" max="32" step="0.25" value="4" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <span id="ed-wall-trans-amp-label" style="color:#aaa;font:10px monospace;">Distance</span>
            <input id="ed-wall-trans-amp" type="number" min="10" max="2000" step="10" value="80" style="width:60px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <span style="color:#aaa;font:10px monospace;">px</span>
            <span style="color:#aaa;font:10px monospace;">Dir</span>
            <select id="ed-wall-trans-dir" style="padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
              <option value="1">+</option>
              <option value="-1">−</option>
            </select>
            <span style="color:#aaa;font:10px monospace;">Phase</span>
            <input id="ed-wall-trans-phase" type="number" min="0" max="32" step="0.25" value="0" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <label style="display:flex;align-items:center;gap:3px;cursor:pointer;">
              <input id="ed-wall-trans-ticked" type="checkbox">
              <span style="color:#aaa;font:10px monospace;">Ticked</span>
            </label>
            <span id="ed-wall-trans-pause-label" style="color:#aaa;font:10px monospace;display:none;">Pause</span>
            <input id="ed-wall-trans-pause" type="number" min="0" max="1" step="0.05" value="0.6" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;display:none;">
            <span id="ed-wall-trans-count-label" style="color:#aaa;font:10px monospace;display:none;">Stops</span>
            <input id="ed-wall-trans-count" type="number" min="2" max="32" step="1" value="2" style="width:50px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;display:none;">
          </div>
        </div>
        <div id="ed-wall-trans-help" style="color:#666;font:9px monospace;"></div>
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px;padding-top:6px;border-top:1px dashed rgba(255,215,64,0.15);flex-wrap:wrap;">
          <span style="color:#aaa;font:10px monospace;">Spring</span>
          <select id="ed-wall-spring-type" style="padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <option value="none">None</option>
            <option value="on">Active</option>
          </select>
          <div id="ed-wall-spring-params" style="display:none;gap:6px;align-items:center;flex-wrap:wrap;width:100%;">
            <span style="color:#aaa;font:10px monospace;">Fires every</span>
            <input id="ed-wall-spring-beats" type="number" min="0.25" max="32" step="0.25" value="2" style="width:55px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <span style="color:#aaa;font:10px monospace;">beat(s)</span>
            <span style="color:#aaa;font:10px monospace;margin-left:8px;">Offset</span>
            <input id="ed-wall-spring-phase" type="number" min="0" max="32" step="0.25" value="0" style="width:55px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <span style="color:#aaa;font:10px monospace;">beats</span>
            <span style="color:#aaa;font:10px monospace;margin-left:8px;">Strength</span>
            <input id="ed-wall-spring-strength" type="number" min="50" max="2500" step="50" value="600" style="width:60px;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
            <div style="color:#666;font:9px monospace;width:100%;line-height:1.4;">
              <b>Fires every N beats</b> (e.g. <code>1</code>=every beat, <code>2</code>=every other beat, <code>0.5</code>=every half-beat).<br>
              <b>Offset</b> shifts when the first fire happens. Set <code>1</code> with offset <code>0.5</code> to fire on the <i>off</i>-beat.<br>
              <b>Strength</b> = launch impulse in px/s (200=gentle, 600=strong, 1500=catapult).
            </div>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;padding:5px;background:rgba(180,140,255,0.05);border:1px solid rgba(180,140,255,0.18);border-radius:3px;flex-wrap:wrap;">
        <span style="color:#aaa;font:10px monospace;">Prefab</span>
        <button id="ed-ch-prefab-save" style="padding:4px 8px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#B39DDB;font:10px monospace;border-radius:3px;">Save Selected Group</button>
        <button id="ed-ch-prefab-cancel" style="padding:4px 8px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#888;font:10px monospace;border-radius:3px;display:none;">Cancel placement</button>
        <div id="ed-ch-prefab-list" style="display:flex;flex-wrap:wrap;gap:4px;flex:1;min-width:100%;"></div>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:6px;">
        <button id="ed-ch-clear" style="flex:1;padding:5px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:10px monospace;border-radius:3px;">Clear All</button>
        <button id="ed-ch-del-selected" style="flex:1;padding:5px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:10px monospace;border-radius:3px;">Delete Selected</button>
      </div>
      <div id="ed-ch-placements" style="margin-bottom:6px;font:10px monospace;color:#888;"></div>
      <div style="display:flex;gap:4px;">
        <button id="ed-ch-save" style="flex:1;padding:6px;cursor:pointer;background:rgba(255,215,64,0.15);border:1px solid rgba(255,215,64,0.3);color:#FFD740;font:11px monospace;border-radius:3px;">Save Challenge</button>
        <button id="ed-ch-testplay" style="flex:1;padding:6px;cursor:pointer;background:rgba(79,195,247,0.15);border:1px solid rgba(79,195,247,0.3);color:#4FC3F7;font:11px monospace;border-radius:3px;">▶ Test Play</button>
        <button id="ed-ch-play" style="flex:1;padding:6px;cursor:pointer;background:rgba(100,255,120,0.15);border:1px solid rgba(100,255,120,0.3);color:#64FF78;font:11px monospace;border-radius:3px;">Play</button>
      </div>
      <div id="ed-ch-list" style="margin-top:8px;border-top:1px solid rgba(255,255,255,0.05);padding-top:6px;"></div>
    </div>
  `

  document.body.appendChild(panel)

  panel.addEventListener('keydown', e => { e.stopPropagation() })
  panel.addEventListener('keyup', e => { e.stopPropagation() })

  panel.querySelector('#ed-close')!.addEventListener('click', toggleDesigner)
  panel.querySelector('#ed-add')!.addEventListener('click', () => addEnemyForm())
  panel.querySelector('#ed-export')!.addEventListener('click', () => exportEnemies())
  panel.querySelector('#ed-import')!.addEventListener('click', importEnemies)

  // Spawn-Test strip
  const spawnStrip = panel.querySelector('#ed-st-strip') as HTMLDivElement
  rebuildSpawnStrip(spawnStrip)
  panel.querySelector('#ed-st-clear')!.addEventListener('click', () => clearTestEnemies())

  // Collapsible enemy section
  const enemyBody = panel.querySelector('#ed-enemy-body') as HTMLDivElement
  const enemyToggle = panel.querySelector('#ed-enemy-toggle') as HTMLSpanElement
  panel.querySelector('#ed-enemy-header')!.addEventListener('click', () => {
    enemySectionExpanded = !enemySectionExpanded
    enemyBody.style.display = enemySectionExpanded ? 'block' : 'none'
    enemyToggle.textContent = enemySectionExpanded ? '▼' : '▶'
  })

  // Collapsible upgrade section
  let upgradeSectionExpanded = false
  const upgradeBody = panel.querySelector('#ed-upgrade-body') as HTMLDivElement
  const upgradeToggle = panel.querySelector('#ed-upgrade-toggle') as HTMLSpanElement
  panel.querySelector('#ed-upgrade-header')!.addEventListener('click', () => {
    upgradeSectionExpanded = !upgradeSectionExpanded
    upgradeBody.style.display = upgradeSectionExpanded ? 'block' : 'none'
    upgradeToggle.textContent = upgradeSectionExpanded ? '▼' : '▶'
  })

  // Build upgrade test UI
  buildUpgradeTestUI()

  // Challenge builder
  const chBody = panel.querySelector('#ed-challenge-body') as HTMLDivElement
  const chToggle = panel.querySelector('#ed-challenge-toggle') as HTMLSpanElement
  let chExpanded = false
  panel.querySelector('#ed-challenge-header')!.addEventListener('click', () => {
    chExpanded = !chExpanded
    chBody.style.display = chExpanded ? 'block' : 'none'
    chToggle.textContent = chExpanded ? '▼' : '▶'
  })

  const chTypesDiv = panel.querySelector('#ed-ch-types') as HTMLDivElement
  const chPlacementsDiv = panel.querySelector('#ed-ch-placements') as HTMLDivElement
  const chListDiv = panel.querySelector('#ed-ch-list') as HTMLDivElement
  const chNameInput = panel.querySelector('#ed-ch-name') as HTMLInputElement
  const chArenaSelect = panel.querySelector('#ed-ch-arena') as HTMLSelectElement

  function rebuildChTypeButtons(): void {
    chTypesDiv.innerHTML = ''
    for (const type of ENEMY_TYPES) {
      const btn = document.createElement('button')
      btn.textContent = type.name
      btn.style.cssText = `padding:3px 8px;cursor:pointer;background:${ChallengeBuilder.getPlaceTypeName() === type.name ? 'rgba(255,215,64,0.3)' : 'rgba(255,255,255,0.05)'};border:1px solid ${ChallengeBuilder.getPlaceTypeName() === type.name ? 'rgba(255,215,64,0.5)' : 'rgba(255,255,255,0.15)'};color:${type.color};font:10px monospace;border-radius:3px;`
      btn.addEventListener('click', () => {
        // Toggle: clicking the active type exits place mode
        if (ChallengeBuilder.isPlaceMode() && ChallengeBuilder.getPlaceTypeName() === type.name) {
          ChallengeBuilder.exitPlaceMode()
        } else {
          ChallengeBuilder.setPlaceMode(type.name)
        }
        rebuildChTypeButtons()
        refreshToolButtons()
      })
      chTypesDiv.appendChild(btn)
    }
  }

  function rebuildChPlacements(): void {
    const placements = ChallengeBuilder.getPlacingEnemies()
    if (placements.length === 0) {
      chPlacementsDiv.textContent = 'No enemies placed'
      return
    }
    chPlacementsDiv.innerHTML = placements.map((e, i) =>
      `<span style="color:${i === ChallengeBuilder.getSelectedPlacement() ? '#FFD740' : '#888'}">${e.typeName} (${Math.round(e.x)},${Math.round(e.y)})</span>`
    ).join('<br>')
  }

  function rebuildChList(): void {
    const challenges = ChallengeBuilder.getChallenges()
    if (challenges.length === 0) {
      chListDiv.innerHTML = '<span style="color:#666;font:10px monospace;">No saved challenges</span>'
      return
    }
    chListDiv.innerHTML = challenges.map(c =>
      `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;">
        <span style="color:#FFD740;font:10px monospace;">${c.name} (${c.enemies.length} enemies)</span>
        <div style="display:flex;gap:3px;">
          <button class="ch-play-btn" data-name="${c.name}" style="padding:2px 6px;cursor:pointer;background:rgba(100,255,120,0.1);border:1px solid rgba(100,255,120,0.3);color:#64FF78;font:9px monospace;border-radius:2px;">Play</button>
          <button class="ch-load" data-name="${c.name}" style="padding:2px 6px;cursor:pointer;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.15);color:#aaa;font:9px monospace;border-radius:2px;">Edit</button>
          <button class="ch-del" data-name="${c.name}" style="padding:2px 6px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:9px monospace;border-radius:2px;">X</button>
        </div>
      </div>`
    ).join('')
    chListDiv.querySelectorAll('.ch-play-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = (btn as HTMLElement).dataset.name!
        const ch = ChallengeBuilder.getChallenges().find(c => c.name === name)
        if (ch) {
          ChallengeBuilder.setActiveChallenge(ch)
          startChallengeCallback?.(ch)
        }
      })
    })
    chListDiv.querySelectorAll('.ch-load').forEach(btn => {
      btn.addEventListener('click', () => {
        ChallengeBuilder.loadChallenge((btn as HTMLElement).dataset.name!)
        chNameInput.value = ChallengeBuilder.getChallengeName()
        chArenaSelect.value = ChallengeBuilder.getChallengeArena()
        rebuildChPlacements()
        rebuildChTypeButtons()
      })
    })
    chListDiv.querySelectorAll('.ch-del').forEach(btn => {
      btn.addEventListener('click', () => {
        ChallengeBuilder.deleteChallenge((btn as HTMLElement).dataset.name!)
        rebuildChList()
      })
    })
  }

  chNameInput.addEventListener('input', () => ChallengeBuilder.setChallengeName(chNameInput.value))
  chArenaSelect.addEventListener('change', () => ChallengeBuilder.setChallengeArena(chArenaSelect.value as Challenge['arenaShape']))

  panel.querySelector('#ed-ch-save')!.addEventListener('click', () => {
    ChallengeBuilder.saveChallenge()
    ChallengeBuilder.exitPlaceMode()
    ChallengeBuilder.clearPlacements()
    rebuildChTypeButtons()
    rebuildChPlacements()
    rebuildChList()
  })
  panel.querySelector('#ed-ch-clear')!.addEventListener('click', () => {
    ChallengeBuilder.clearPlacements()
    rebuildChPlacements()
  })
  panel.querySelector('#ed-ch-del-selected')!.addEventListener('click', () => {
    const sel = ChallengeBuilder.getSelectedPlacement()
    if (sel >= 0) {
      ChallengeBuilder.removeEnemy(sel)
      rebuildChPlacements()
    }
  })
  panel.querySelector('#ed-ch-play')!.addEventListener('click', () => {
    ChallengeBuilder.saveChallenge()
    ChallengeBuilder.exitPlaceMode()
    ChallengeBuilder.clearPlacements()
    rebuildChTypeButtons()
    rebuildChPlacements()
    rebuildChList()
    const ch = ChallengeBuilder.getChallenges().find(c => c.name === ChallengeBuilder.getChallengeName())
    if (ch) {
      ChallengeBuilder.setActiveChallenge(ch)
      startChallengeCallback?.(ch)
    }
  })

  panel.querySelector('#ed-ch-testplay')!.addEventListener('click', () => {
    testPlayCallback?.()
  })

  // ── Wall / Pillar tool wiring ────────────────────────────────────────────
  const wallBtn = panel.querySelector('#ed-ch-tool-wall') as HTMLButtonElement
  const pillarBtn = panel.querySelector('#ed-ch-tool-pillar') as HTMLButtonElement
  const thickSlider = panel.querySelector('#ed-ch-wall-thick') as HTMLInputElement
  const thickVal = panel.querySelector('#ed-ch-wall-thick-val') as HTMLSpanElement
  const wallsClearBtn = panel.querySelector('#ed-ch-walls-clear') as HTMLButtonElement
  const toolHint = panel.querySelector('#ed-ch-tool-hint') as HTMLDivElement
  function refreshToolButtons(): void {
    const tool = ChallengeBuilder.getPlaceTool()
    const activeBg = 'rgba(128,216,255,0.25)'
    const activeBd = 'rgba(128,216,255,0.55)'
    const inactiveBg = 'rgba(255,255,255,0.05)'
    const inactiveBd = 'rgba(255,255,255,0.15)'
    wallBtn.style.background = tool === 'wall' ? activeBg : inactiveBg
    wallBtn.style.borderColor = tool === 'wall' ? activeBd : inactiveBd
    pillarBtn.style.background = tool === 'pillar' ? activeBg : inactiveBg
    pillarBtn.style.borderColor = tool === 'pillar' ? activeBd : inactiveBd
    if (tool === 'wall') {
      if (ChallengeBuilder.getPlacingPrefab()) {
        toolHint.textContent = `PREFAB: click to drop "${ChallengeBuilder.getPlacingPrefab()!.name}". Scroll = rotate 5° (Shift+scroll = 45°). R = snap 90° CW (Shift+R = CCW). Esc to exit.`
      } else {
        toolHint.textContent = 'WALL: click+drag empty to draw (Shift = 15° snap). Click a wall = select. Drag SELECTED body = move whole piece. Yellow handles = reshape endpoint. CYAN diamond = bend. Scroll = rotate selected group 5° (Shift+scroll = 45°). R / Shift+R = snap 90°. Z = zoom out & freeze walls. Delete removes selected. Right-click deletes. Save selected group as prefab below.'
      }
    }
    else if (tool === 'pillar') toolHint.textContent = 'PILLAR: single click to place. Right-click any wall/enemy to delete.'
    else if (tool === 'enemy') toolHint.textContent = `ENEMY: click to place ${ChallengeBuilder.getPlaceTypeName()}. Right-click any wall/enemy to delete.`
    else toolHint.textContent = 'Pick an enemy type, Wall, or Pillar above. Right-click any wall/enemy to delete.'
  }
  wallBtn.addEventListener('click', () => {
    const tool = ChallengeBuilder.getPlaceTool()
    ChallengeBuilder.setPlaceTool(tool === 'wall' ? 'none' : 'wall')
    rebuildChTypeButtons()
    refreshToolButtons()
  })
  pillarBtn.addEventListener('click', () => {
    const tool = ChallengeBuilder.getPlaceTool()
    ChallengeBuilder.setPlaceTool(tool === 'pillar' ? 'none' : 'pillar')
    rebuildChTypeButtons()
    refreshToolButtons()
  })
  thickSlider.addEventListener('input', () => {
    const v = parseInt(thickSlider.value)
    ChallengeBuilder.setWallThickness(v)
    thickVal.textContent = String(v)
  })
  wallsClearBtn.addEventListener('click', () => {
    if (ChallengeBuilder.getPlacingWalls().length === 0) return
    if (confirm('Clear all walls from this challenge?')) ChallengeBuilder.clearWalls()
  })

  // ── Wall Properties panel (selected-wall editor) ──
  const wallPropsDiv = panel.querySelector('#ed-wall-props') as HTMLDivElement
  const propThickInput = panel.querySelector('#ed-wall-prop-thick') as HTMLInputElement
  const propThickVal = panel.querySelector('#ed-wall-prop-thick-val') as HTMLSpanElement
  propThickInput.addEventListener('input', () => {
    const v = parseInt(propThickInput.value) || 16
    propThickVal.textContent = String(v)
    ChallengeBuilder.setSelectedWallRadius(v)
  })
  const propNoClipInput = panel.querySelector('#ed-wall-prop-noclip') as HTMLInputElement
  propNoClipInput.addEventListener('change', () => {
    ChallengeBuilder.setSelectedWallNoClip(propNoClipInput.checked)
  })
  const motionTypeSel = panel.querySelector('#ed-wall-motion-type') as HTMLSelectElement
  const motionRotateParams = panel.querySelector('#ed-wall-motion-rotate-params') as HTMLDivElement
  const motionBeatsInput = panel.querySelector('#ed-wall-motion-beats') as HTMLInputElement
  const motionDirSel = panel.querySelector('#ed-wall-motion-dir') as HTMLSelectElement
  const motionPhaseInput = panel.querySelector('#ed-wall-motion-phase') as HTMLInputElement
  const motionSweepLabel = panel.querySelector('#ed-wall-motion-sweep-label') as HTMLSpanElement
  const motionSweepInput = panel.querySelector('#ed-wall-motion-sweep') as HTMLInputElement
  const motionSweepUnit = panel.querySelector('#ed-wall-motion-sweep-unit') as HTMLSpanElement
  const motionDegLabel = panel.querySelector('#ed-wall-motion-deg-label') as HTMLSpanElement
  const motionDegInput = panel.querySelector('#ed-wall-motion-deg') as HTMLInputElement
  const motionPauseLabel = panel.querySelector('#ed-wall-motion-pause-label') as HTMLSpanElement
  const motionPauseInput = panel.querySelector('#ed-wall-motion-pause') as HTMLInputElement
  const motionRevLabel = panel.querySelector('#ed-wall-motion-rev-label') as HTMLSpanElement
  const motionRevInput = panel.querySelector('#ed-wall-motion-rev') as HTMLInputElement
  const motionRevUnit = panel.querySelector('#ed-wall-motion-rev-unit') as HTMLSpanElement
  const motionHelpDiv = panel.querySelector('#ed-wall-motion-help') as HTMLDivElement
  const pivotRow = panel.querySelector('#ed-wall-pivot-row') as HTMLDivElement
  const pivotStatus = panel.querySelector('#ed-wall-pivot-status') as HTMLSpanElement
  const pivotSetBtn = panel.querySelector('#ed-wall-pivot-set') as HTMLButtonElement
  const pivotResetBtn = panel.querySelector('#ed-wall-pivot-reset') as HTMLButtonElement
  pivotSetBtn.addEventListener('click', () => {
    if (ChallengeBuilder.isPivotSetMode()) {
      ChallengeBuilder.exitPivotSetMode()
    } else {
      ChallengeBuilder.enterPivotSetMode()
    }
    refreshWallProps()
  })
  pivotResetBtn.addEventListener('click', () => {
    ChallengeBuilder.resetSelectedWallPivot()
    refreshWallProps()
  })
  // ── Translation panel wiring ──
  const transTypeSel = panel.querySelector('#ed-wall-trans-type') as HTMLSelectElement
  const transParams = panel.querySelector('#ed-wall-trans-params') as HTMLDivElement
  const transBeatsInput = panel.querySelector('#ed-wall-trans-beats') as HTMLInputElement
  const transAmpLabel = panel.querySelector('#ed-wall-trans-amp-label') as HTMLSpanElement
  const transAmpInput = panel.querySelector('#ed-wall-trans-amp') as HTMLInputElement
  const transDirSel = panel.querySelector('#ed-wall-trans-dir') as HTMLSelectElement
  const transPhaseInput = panel.querySelector('#ed-wall-trans-phase') as HTMLInputElement
  const transTickedInput = panel.querySelector('#ed-wall-trans-ticked') as HTMLInputElement
  const transPauseLabel = panel.querySelector('#ed-wall-trans-pause-label') as HTMLSpanElement
  const transPauseInput = panel.querySelector('#ed-wall-trans-pause') as HTMLInputElement
  const transCountLabel = panel.querySelector('#ed-wall-trans-count-label') as HTMLSpanElement
  const transCountInput = panel.querySelector('#ed-wall-trans-count') as HTMLInputElement
  const transHelpDiv = panel.querySelector('#ed-wall-trans-help') as HTMLDivElement
  function updateTransAmpLabel(): void {
    const t = transTypeSel.value
    if (t === 'circle') transAmpLabel.textContent = 'Radius'
    else if (t === 'square') transAmpLabel.textContent = 'Side ½'
    else transAmpLabel.textContent = 'Distance'
  }
  function updateTransPauseVisibility(): void {
    const show = transTickedInput.checked
    transPauseLabel.style.display = show ? '' : 'none'
    transPauseInput.style.display = show ? '' : 'none'
    transCountLabel.style.display = show ? '' : 'none'
    transCountInput.style.display = show ? '' : 'none'
    // For linear types the stops count MUST be even — clamp display to next even number.
    const tType = transTypeSel.value
    if (show && (tType === 'horizontal' || tType === 'vertical')) {
      transCountInput.step = '2'
      transCountInput.min = '2'
      const v = parseInt(transCountInput.value)
      if (Number.isFinite(v) && v % 2 !== 0) transCountInput.value = String(v + 1)
    } else {
      transCountInput.step = '1'
      transCountInput.min = tType === 'square' ? '4' : '2'
    }
  }
  function updateTransHelp(): void {
    const t = transTypeSel.value
    if (t === 'none') { transHelpDiv.textContent = ''; return }
    const beats = parseFloat(transBeatsInput.value) || 4
    const amp = parseFloat(transAmpInput.value) || 80
    const ticked = transTickedInput.checked
    const count = parseInt(transCountInput.value) || 2
    if (ticked) {
      if (t === 'horizontal' || t === 'vertical') {
        const half = Math.floor(count / 2)
        const axis = t === 'horizontal' ? 'horizontally' : 'vertically'
        transHelpDiv.textContent = `Patrols ±${amp}px ${axis} in ${count} ticks (${half} out, ${half} back) every ${beats} beat(s).`
      } else if (t === 'circle') {
        transHelpDiv.textContent = `Orbits in a circle of radius ${amp}px with ${count} ticked stops every ${beats} beat(s). Returns to rest position once per cycle.`
      } else if (t === 'square') {
        const perSide = count / 4
        const sideStr = Number.isInteger(perSide) ? `${perSide} stop(s) per side` : `${count} stops total`
        transHelpDiv.textContent = `Walks a square of side ${amp}px in ${count} ticks (${sideStr}), 1 lap every ${beats} beat(s).`
      }
    } else {
      if (t === 'horizontal') transHelpDiv.textContent = `Patrols ±${amp}px horizontally smoothly every ${beats} beat(s).`
      else if (t === 'vertical') transHelpDiv.textContent = `Patrols ±${amp}px vertically smoothly every ${beats} beat(s).`
      else if (t === 'circle') transHelpDiv.textContent = `Orbits in a circle of radius ${amp}px smoothly every ${beats} beat(s). Passes through rest position once per cycle.`
      else if (t === 'square') transHelpDiv.textContent = `Walks a square path of side ${amp}px smoothly (continuous perimeter), 1 lap every ${beats} beat(s).`
    }
  }
  function pushTransChange(): void {
    const t = transTypeSel.value
    if (t === 'none') { ChallengeBuilder.setSelectedWallTranslation(undefined); return }
    const beats = parseFloat(transBeatsInput.value)
    const amp = parseFloat(transAmpInput.value)
    const phase = parseFloat(transPhaseInput.value)
    const pause = parseFloat(transPauseInput.value)
    if (!Number.isFinite(beats) || beats <= 0) return
    if (!Number.isFinite(amp) || amp <= 0) return
    if (!Number.isFinite(phase)) return
    if (!Number.isFinite(pause)) return
    const tickCountRaw = parseInt(transCountInput.value)
    let tickCount: number | undefined
    if (Number.isFinite(tickCountRaw) && tickCountRaw >= 2) {
      tickCount = tickCountRaw
      // Linear types require even — round up
      if ((t === 'horizontal' || t === 'vertical') && tickCount % 2 !== 0) tickCount++
      if (t === 'square' && tickCount < 4) tickCount = 4
    }
    ChallengeBuilder.setSelectedWallTranslation({
      type: t as 'horizontal' | 'vertical' | 'circle' | 'square',
      beatsPerCycle: beats,
      amplitude: amp,
      direction: parseInt(transDirSel.value) === -1 ? -1 : 1,
      phaseBeats: phase,
      ticked: transTickedInput.checked,
      pauseFraction: Math.max(0, Math.min(1, pause)),
      ...(tickCount != null ? { tickCount } : {}),
    })
    updateTransHelp()
  }
  transTypeSel.addEventListener('change', () => {
    if (transTypeSel.value === 'none') {
      transParams.style.display = 'none'
      ChallengeBuilder.setSelectedWallTranslation(undefined)
    } else {
      transParams.style.display = 'flex'
      updateTransAmpLabel()
      pushTransChange()
    }
    updateTransHelp()
  })
  transBeatsInput.addEventListener('input', pushTransChange)
  transAmpInput.addEventListener('input', pushTransChange)
  transDirSel.addEventListener('change', pushTransChange)
  transPhaseInput.addEventListener('input', pushTransChange)
  transTickedInput.addEventListener('change', () => { updateTransPauseVisibility(); pushTransChange() })
  transPauseInput.addEventListener('input', pushTransChange)
  transCountInput.addEventListener('input', pushTransChange)
  function refreshTransRow(): void {
    const tr = ChallengeBuilder.getSelectedWallTranslation()
    if (!tr) {
      transTypeSel.value = 'none'
      transParams.style.display = 'none'
      updateTransHelp()
      return
    }
    transTypeSel.value = tr.type
    transParams.style.display = 'flex'
    transBeatsInput.value = String(tr.beatsPerCycle ?? 4)
    transAmpInput.value = String(tr.amplitude ?? 80)
    transDirSel.value = String(tr.direction ?? 1)
    transPhaseInput.value = String(tr.phaseBeats ?? 0)
    transTickedInput.checked = !!tr.ticked
    transPauseInput.value = String(tr.pauseFraction ?? 0.6)
    // Default tickCount per type: linear 2, circle 4, square 4
    const defaultCount = tr.type === 'square' ? 4 : tr.type === 'circle' ? 4 : 2
    transCountInput.value = String(tr.tickCount ?? defaultCount)
    updateTransAmpLabel()
    updateTransPauseVisibility()
    updateTransHelp()
  }

  function updatePivotRow(): void {
    const motion = ChallengeBuilder.getSelectedWallMotion()
    const isMoving = motion?.type === 'rotate' || motion?.type === 'pendulum' || motion?.type === 'tick'
    pivotRow.style.display = isMoving ? 'flex' : 'none'
    if (!isMoving) return
    const pivot = ChallengeBuilder.getSelectedWallPivotWorld()
    const offX = pivot?.offset.x ?? 0
    const offY = pivot?.offset.y ?? 0
    const atCenter = Math.abs(offX) < 0.5 && Math.abs(offY) < 0.5
    pivotStatus.textContent = atCenter
      ? '● Bbox center'
      : `● Off-center (${offX.toFixed(0)}, ${offY.toFixed(0)})`
    pivotStatus.style.color = atCenter ? '#888' : '#FFD740'
    pivotSetBtn.textContent = ChallengeBuilder.isPivotSetMode() ? 'Click arena…' : 'Set Pivot…'
    pivotSetBtn.style.background = ChallengeBuilder.isPivotSetMode() ? 'rgba(255,215,64,0.35)' : 'rgba(255,215,64,0.15)'
  }
  function setSweepFieldsVisible(visible: boolean): void {
    const d = visible ? '' : 'none'
    motionSweepLabel.style.display = d
    motionSweepInput.style.display = d
    motionSweepUnit.style.display = d
  }
  function setTickFieldsVisible(visible: boolean): void {
    const d = visible ? '' : 'none'
    motionDegLabel.style.display = d
    motionDegInput.style.display = d
    motionPauseLabel.style.display = d
    motionPauseInput.style.display = d
    motionRevLabel.style.display = d
    motionRevInput.style.display = d
    motionRevUnit.style.display = d
  }
  function updateMotionHelp(): void {
    const t = motionTypeSel.value
    if (t === 'rotate') {
      motionHelpDiv.textContent = 'Spins continuously around the connected piece\'s bbox center. Test Play to see it animate.'
    } else if (t === 'pendulum') {
      const sweep = parseFloat(motionSweepInput.value) || 90
      motionHelpDiv.textContent = `Swings ±${(sweep / 2).toFixed(0)}° around the bbox center, slowing at the turnarounds. One full A→B→A swing per cycle.`
    } else if (t === 'tick') {
      const deg = parseFloat(motionDegInput.value) || 30
      const beats = parseFloat(motionBeatsInput.value) || 1
      const rev = parseInt(motionRevInput.value) || 0
      if (rev > 0) {
        motionHelpDiv.textContent = `Steps ${deg}° every ${beats} beat(s), then reverses after ${rev} tick(s). Covers ±${(deg * rev).toFixed(0)}° each way before swinging back.`
      } else {
        motionHelpDiv.textContent = `Steps ${deg}° every ${beats} beat(s), always the same direction (clock-style). Full rotation in ${(360 / deg * beats).toFixed(1)} beats.`
      }
    } else {
      motionHelpDiv.textContent = 'Pick Rotate, Pendulum, or Tick to animate this wall group on the beat.'
    }
  }
  const springTypeSel = panel.querySelector('#ed-wall-spring-type') as HTMLSelectElement
  const springParams = panel.querySelector('#ed-wall-spring-params') as HTMLDivElement
  const springBeatsInput = panel.querySelector('#ed-wall-spring-beats') as HTMLInputElement
  const springPhaseInput = panel.querySelector('#ed-wall-spring-phase') as HTMLInputElement
  const springStrengthInput = panel.querySelector('#ed-wall-spring-strength') as HTMLInputElement
  // Re-read & repopulate the panel from current selection state. Called whenever selection
  // changes, motion changes, or initial setup.
  function refreshWallProps(): void {
    const selIdx = ChallengeBuilder.getSelectedWallIdx()
    if (selIdx < 0) { wallPropsDiv.style.display = 'none'; return }
    wallPropsDiv.style.display = 'block'
    const curR = ChallengeBuilder.getSelectedWallRadius()
    if (curR != null) {
      propThickInput.value = String(curR)
      propThickVal.textContent = String(curR)
    }
    propNoClipInput.checked = ChallengeBuilder.getSelectedWallNoClip()
    const motion = ChallengeBuilder.getSelectedWallMotion()
    if (!motion) {
      motionTypeSel.value = 'none'
      motionRotateParams.style.display = 'none'
      setSweepFieldsVisible(false)
    } else if (motion.type === 'rotate') {
      motionTypeSel.value = 'rotate'
      motionRotateParams.style.display = 'flex'
      motionBeatsInput.value = String(motion.beatsPerCycle ?? 4)
      motionDirSel.value = String(motion.direction ?? 1)
      motionPhaseInput.value = String(motion.phaseBeats ?? 0)
      setSweepFieldsVisible(false)
      setTickFieldsVisible(false)
    } else if (motion.type === 'pendulum') {
      motionTypeSel.value = 'pendulum'
      motionRotateParams.style.display = 'flex'
      motionBeatsInput.value = String(motion.beatsPerCycle ?? 4)
      motionDirSel.value = String(motion.direction ?? 1)
      motionPhaseInput.value = String(motion.phaseBeats ?? 0)
      motionSweepInput.value = String(motion.sweepDegrees ?? 90)
      setSweepFieldsVisible(true)
      setTickFieldsVisible(false)
    } else if (motion.type === 'tick') {
      motionTypeSel.value = 'tick'
      motionRotateParams.style.display = 'flex'
      // For tick, "Beats/cycle" doubles as beats-per-tick. Phase and direction reused.
      motionBeatsInput.value = String(motion.beatsPerTick ?? 1)
      motionDirSel.value = String(motion.direction ?? 1)
      motionPhaseInput.value = String(motion.phaseBeats ?? 0)
      motionDegInput.value = String(motion.degreesPerTick ?? 30)
      motionPauseInput.value = String(motion.pauseFraction ?? 0.6)
      motionRevInput.value = String(motion.ticksBeforeReverse ?? 0)
      setSweepFieldsVisible(false)
      setTickFieldsVisible(true)
    }
    updateMotionHelp()
    updatePivotRow()
    refreshTransRow()
    const spring = ChallengeBuilder.getSelectedWallSpring()
    if (!spring) {
      springTypeSel.value = 'none'
      springParams.style.display = 'none'
    } else {
      springTypeSel.value = 'on'
      springParams.style.display = 'flex'
      springBeatsInput.value = String(spring.beatsPerCycle)
      springPhaseInput.value = String(spring.phase)
      springStrengthInput.value = String(spring.strength)
    }
  }
  motionTypeSel.addEventListener('change', () => {
    if (motionTypeSel.value === 'none') {
      ChallengeBuilder.setSelectedWallMotion(undefined)
    } else if (motionTypeSel.value === 'rotate') {
      ChallengeBuilder.setSelectedWallMotion({
        type: 'rotate',
        beatsPerCycle: parseFloat(motionBeatsInput.value) || 4,
        direction: parseInt(motionDirSel.value) === -1 ? -1 : 1,
        phaseBeats: parseFloat(motionPhaseInput.value) || 0,
      })
    } else if (motionTypeSel.value === 'pendulum') {
      ChallengeBuilder.setSelectedWallMotion({
        type: 'pendulum',
        beatsPerCycle: parseFloat(motionBeatsInput.value) || 4,
        direction: parseInt(motionDirSel.value) === -1 ? -1 : 1,
        phaseBeats: parseFloat(motionPhaseInput.value) || 0,
        sweepDegrees: parseFloat(motionSweepInput.value) || 90,
      })
    } else if (motionTypeSel.value === 'tick') {
      ChallengeBuilder.setSelectedWallMotion({
        type: 'tick',
        beatsPerTick: parseFloat(motionBeatsInput.value) || 1,
        direction: parseInt(motionDirSel.value) === -1 ? -1 : 1,
        phaseBeats: parseFloat(motionPhaseInput.value) || 0,
        degreesPerTick: parseFloat(motionDegInput.value) || 30,
        pauseFraction: parseFloat(motionPauseInput.value),
        ticksBeforeReverse: parseInt(motionRevInput.value) || 0,
      })
    }
    refreshWallProps()
  })
  function pushMotionChange(): void {
    const t = motionTypeSel.value
    if (t !== 'rotate' && t !== 'pendulum' && t !== 'tick') return
    const bpc = parseFloat(motionBeatsInput.value)
    const ph = parseFloat(motionPhaseInput.value)
    if (!Number.isFinite(bpc) || bpc <= 0) return
    if (!Number.isFinite(ph)) return
    const dir = parseInt(motionDirSel.value) === -1 ? -1 : 1
    if (t === 'rotate') {
      ChallengeBuilder.setSelectedWallMotion({ type: 'rotate', beatsPerCycle: bpc, direction: dir, phaseBeats: ph })
    } else if (t === 'pendulum') {
      const sw = parseFloat(motionSweepInput.value)
      if (!Number.isFinite(sw) || sw <= 0) return
      ChallengeBuilder.setSelectedWallMotion({ type: 'pendulum', beatsPerCycle: bpc, direction: dir, phaseBeats: ph, sweepDegrees: sw })
    } else {
      // tick — beats input doubles as beatsPerTick
      const deg = parseFloat(motionDegInput.value)
      const pause = parseFloat(motionPauseInput.value)
      const rev = parseInt(motionRevInput.value)
      if (!Number.isFinite(deg) || deg <= 0) return
      if (!Number.isFinite(pause)) return
      if (!Number.isFinite(rev) || rev < 0) return
      ChallengeBuilder.setSelectedWallMotion({
        type: 'tick',
        beatsPerTick: bpc,
        direction: dir,
        phaseBeats: ph,
        degreesPerTick: deg,
        pauseFraction: Math.max(0, Math.min(1, pause)),
        ticksBeforeReverse: rev,
      })
    }
    updateMotionHelp()
  }
  motionBeatsInput.addEventListener('input', pushMotionChange)
  motionDirSel.addEventListener('change', pushMotionChange)
  motionPhaseInput.addEventListener('input', pushMotionChange)
  motionSweepInput.addEventListener('input', pushMotionChange)
  motionDegInput.addEventListener('input', pushMotionChange)
  motionPauseInput.addEventListener('input', pushMotionChange)
  motionRevInput.addEventListener('input', pushMotionChange)
  springTypeSel.addEventListener('change', () => {
    if (springTypeSel.value === 'none') {
      ChallengeBuilder.setSelectedWallSpring(undefined)
    } else {
      ChallengeBuilder.setSelectedWallSpring({
        beatsPerCycle: parseFloat(springBeatsInput.value) || 2,
        phase: parseFloat(springPhaseInput.value) || 0,
        strength: parseFloat(springStrengthInput.value) || 600,
      })
    }
    refreshWallProps()
  })
  function pushSpringChange(): void {
    if (springTypeSel.value !== 'on') return
    // Validate before pushing — empty/partial fields would otherwise push 0 or defaults
    // and the interval refresh would overwrite the user's in-progress typing.
    const bpc = parseFloat(springBeatsInput.value)
    const ph = parseFloat(springPhaseInput.value)
    const str = parseFloat(springStrengthInput.value)
    if (!Number.isFinite(bpc) || bpc <= 0) return
    if (!Number.isFinite(ph) || ph < 0) return
    if (!Number.isFinite(str) || str <= 0) return
    ChallengeBuilder.setSelectedWallSpring({ beatsPerCycle: bpc, phase: ph, strength: str })
  }
  springBeatsInput.addEventListener('input', pushSpringChange)
  springPhaseInput.addEventListener('input', pushSpringChange)
  springStrengthInput.addEventListener('input', pushSpringChange)
  // Refresh panel ONLY when the selection actually changes. The previous "refresh every 100ms"
  // approach overwrote inputs while the user was typing (e.g. typing "0.5" — the "0" got
  // pushed to wall, refresh tick wrote it back as "0", killing the in-progress value).
  let lastSelWallIdx = -2
  setInterval(() => {
    if (!visible || !chExpanded) return
    const cur = ChallengeBuilder.getSelectedWallIdx()
    if (cur !== lastSelWallIdx) {
      lastSelWallIdx = cur
      refreshWallProps()
    }
  }, 100)

  // ── Prefab library ──
  const prefabSaveBtn = panel.querySelector('#ed-ch-prefab-save') as HTMLButtonElement
  const prefabCancelBtn = panel.querySelector('#ed-ch-prefab-cancel') as HTMLButtonElement
  const prefabListDiv = panel.querySelector('#ed-ch-prefab-list') as HTMLDivElement
  function rebuildPrefabList(): void {
    const prefabs = ChallengeBuilder.getWallPrefabs()
    const placing = ChallengeBuilder.getPlacingPrefab()
    if (prefabs.length === 0) {
      prefabListDiv.innerHTML = '<span style="color:#666;font:10px monospace;">No prefabs saved. Select a wall, click "Save Selected Group" to capture its connected piece.</span>'
    } else {
      prefabListDiv.innerHTML = prefabs.map(p => {
        const active = placing?.name === p.name
        const bg = active ? 'rgba(180,140,255,0.3)' : 'rgba(255,255,255,0.05)'
        const bd = active ? 'rgba(180,140,255,0.55)' : 'rgba(255,255,255,0.15)'
        return `<div style="display:flex;gap:0;align-items:stretch;">` +
          `<button class="prefab-use" data-name="${p.name}" style="padding:3px 7px;cursor:pointer;background:${bg};border:1px solid ${bd};color:#B39DDB;font:10px monospace;border-radius:3px 0 0 3px;border-right:none;">${p.name} <span style="opacity:0.6;">(${p.walls.length})</span></button>` +
          `<button class="prefab-del" data-name="${p.name}" style="padding:3px 5px;cursor:pointer;background:rgba(255,80,80,0.1);border:1px solid rgba(255,80,80,0.2);color:#FF5252;font:10px monospace;border-radius:0 3px 3px 0;">×</button>` +
          `</div>`
      }).join('')
      prefabListDiv.querySelectorAll('.prefab-use').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = (btn as HTMLElement).dataset.name!
          // Toggle: click active prefab again to cancel
          if (ChallengeBuilder.getPlacingPrefab()?.name === name) {
            ChallengeBuilder.stopPlacingPrefab()
          } else {
            ChallengeBuilder.startPlacingPrefab(name)
          }
          rebuildPrefabList()
          refreshToolButtons()
        })
      })
      prefabListDiv.querySelectorAll('.prefab-del').forEach(btn => {
        btn.addEventListener('click', () => {
          const name = (btn as HTMLElement).dataset.name!
          if (confirm(`Delete prefab "${name}"?`)) {
            ChallengeBuilder.deleteWallPrefab(name)
            rebuildPrefabList()
            refreshToolButtons()
          }
        })
      })
    }
    prefabCancelBtn.style.display = placing ? 'inline-block' : 'none'
  }
  prefabSaveBtn.addEventListener('click', () => {
    if (ChallengeBuilder.getSelectedWallIdx() < 0) {
      alert('Select a wall first — the prefab will capture its entire connected group.')
      return
    }
    const name = prompt('Prefab name:')
    if (!name) return
    if (ChallengeBuilder.saveSelectedGroupAsPrefab(name)) {
      rebuildPrefabList()
    }
  })
  prefabCancelBtn.addEventListener('click', () => {
    ChallengeBuilder.stopPlacingPrefab()
    rebuildPrefabList()
    refreshToolButtons()
  })

  ChallengeBuilder.loadFromStorage()
  rebuildChTypeButtons()
  rebuildChPlacements()
  rebuildChList()
  rebuildPrefabList()
  refreshToolButtons()

  // Expose click handler for canvas placement
  challengeCanvasClick = (screenX: number, screenY: number) => {
    if (getPhase() !== 'designer') return false
    if (!chExpanded) return false
    // Prefab placement (highest priority — supersedes wall tool drag behavior)
    if (ChallengeBuilder.getPlacingPrefab()) {
      ChallengeBuilder.dropPrefabAt(screenX, screenY)
      return true
    }
    const tool = ChallengeBuilder.getPlaceTool()
    // Pillar tool: single click places a pillar at the cursor.
    if (tool === 'pillar') {
      ChallengeBuilder.placePillar(screenX, screenY)
      return true
    }
    // Wall tool: drag is handled via pointerdown/up. Click alone does nothing.
    if (tool === 'wall') return true
    // If a ghost is currently being moved, click drops it (deselect — its position
    // already follows the cursor via mouse-move).
    if (ChallengeBuilder.getSelectedPlacement() >= 0) {
      ChallengeBuilder.clearSelection()
      rebuildChPlacements()
      return true
    }
    // Otherwise, try to pick up an existing ghost
    if (ChallengeBuilder.selectPlacement(screenX, screenY)) {
      rebuildChPlacements()
      return true
    }
    // Or place a new one (if a type button is active)
    if (ChallengeBuilder.isPlaceMode()) {
      ChallengeBuilder.placeEnemy(screenX, screenY)
      rebuildChPlacements()
      return true
    }
    return false
  }
  challengeCanvasMouseDown = (screenX: number, screenY: number, _shift = false) => {
    if (getPhase() !== 'designer') return false
    if (!chExpanded) return false
    // Pivot-set mode — highest priority: click anywhere → place the pivot for the selected
    // wall's group, exit mode. Right-click handler (separate) resets to bbox center.
    if (ChallengeBuilder.isPivotSetMode()) {
      ChallengeBuilder.consumePivotSetClick(screenX, screenY)
      refreshWallProps()
      return true
    }
    // Prefab placement is click-only (drop on mouse-up). Suppress dash on pointer-down but
    // don't start a wall drag.
    if (ChallengeBuilder.getPlacingPrefab()) return true
    // Pillar tool: click is for placement (handled in challengeCanvasClick). Don't
    // hijack with wall-selection — pillar placement needs an unmolested click event,
    // including clicks on top of existing walls (a pillar dropped on a wall's snap point
    // is the intended way to clip a pillar onto a line).
    if (ChallengeBuilder.getPlaceTool() === 'pillar') return false
    // Wall interaction always works regardless of place tool — selecting / re-shaping /
    // moving an existing wall should never require activating the Wall tool first. The
    // place tool only gates CREATING new walls below.
    if (ChallengeBuilder.hitTestSelectedWallCurveHandle(screenX, screenY)) {
      ChallengeBuilder.startBendDrag()
      return true
    }
    const handle = ChallengeBuilder.hitTestSelectedWallHandle(screenX, screenY)
    if (handle) {
      ChallengeBuilder.startEndpointDrag(handle)
      return true
    }
    const selIdx = ChallengeBuilder.getSelectedWallIdx()
    if (selIdx >= 0 && ChallengeBuilder.hitTestSpecificWall(selIdx, screenX, screenY)) {
      ChallengeBuilder.startMoveDrag(screenX, screenY)
      return true
    }
    if (ChallengeBuilder.selectWallAtScreen(screenX, screenY)) {
      return true
    }
    // No wall under cursor — only the Wall tool starts a NEW wall drag on empty space.
    if (ChallengeBuilder.getPlaceTool() !== 'wall') return false
    ChallengeBuilder.clearWallSelection()
    ChallengeBuilder.startWallDrag(screenX, screenY)
    return true
  }
  challengeCanvasMouseMove = (screenX: number, screenY: number, shift = false) => {
    if (ChallengeBuilder.getSelectedPlacement() >= 0) {
      ChallengeBuilder.moveSelectedPlacement(screenX, screenY)
    }
    // Bend drag — projects cursor onto the chord-perpendicular and sets the wall's `bend`
    if (ChallengeBuilder.getBendDrag()) {
      ChallengeBuilder.updateBendDrag(screenX, screenY)
      return
    }
    // Move-group drag — translates the selected wall's whole connected component
    if (ChallengeBuilder.getMoveDrag()) {
      ChallengeBuilder.updateMoveDrag(screenX, screenY)
      return
    }
    // Endpoint drag of a selected wall — Shift locks angle from the OTHER endpoint
    if (ChallengeBuilder.getEndpointDrag()) {
      ChallengeBuilder.updateEndpointDrag(screenX, screenY, shift)
      return
    }
    // New-wall drag preview — Shift locks angle from the drag start
    if (ChallengeBuilder.getWallDrag()) {
      ChallengeBuilder.updateWallDrag(screenX, screenY, shift)
    }
    // Track hovered enemy/wall for delete-overlay feedback (always in designer; right-click
    // removes whichever is hovered — enemy takes priority over wall since it's the more
    // specific hit-target).
    if (getPhase() === 'designer') {
      ChallengeBuilder.updateHover(screenX, screenY)
      if (ChallengeBuilder.getPlacingPrefab()) ChallengeBuilder.updatePrefabCursor(screenX, screenY)
    }
  }
  challengeCanvasMouseUp = () => {
    if (ChallengeBuilder.getBendDrag()) {
      ChallengeBuilder.endBendDrag()
      return
    }
    if (ChallengeBuilder.getMoveDrag()) {
      ChallengeBuilder.endMoveDrag()
      return
    }
    if (ChallengeBuilder.getEndpointDrag()) {
      ChallengeBuilder.endEndpointDrag()
      return
    }
    if (ChallengeBuilder.getWallDrag()) ChallengeBuilder.endWallDrag()
  }

  window.addEventListener('keydown', e => {
    if (__DEV__ && e.key === 'Tab') {
      e.preventDefault()
      toggleDesigner()
    }
    // Esc — cancel prefab placement, in-progress wall drag, or clear wall selection
    if (e.key === 'Escape') {
      if (ChallengeBuilder.getPlacingPrefab()) {
        ChallengeBuilder.stopPlacingPrefab()
        e.preventDefault()
        return
      }
      if (ChallengeBuilder.getWallDrag()) {
        ChallengeBuilder.cancelWallDrag()
        e.preventDefault()
        return
      }
      if (ChallengeBuilder.getSelectedWallIdx() >= 0) {
        ChallengeBuilder.clearWallSelection()
        e.preventDefault()
        return
      }
    }
    // Delete/Backspace removes the currently selected wall (if one is selected)
    if ((e.key === 'Delete' || e.key === 'Backspace') && ChallengeBuilder.getSelectedWallIdx() >= 0) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      ChallengeBuilder.deleteSelectedWall()
      e.preventDefault()
      return
    }
    // Z — toggle designer zoom-out (see whole arena + freeze wall motion for stable authoring).
    // Also clears all ephemeral spawn-test enemies on toggle so the wide view is uncluttered.
    if ((e.key === 'z' || e.key === 'Z') && getPhase() === 'designer') {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      Renderer.toggleDesignerZoomOut()
      clearDesignerEphemerals()
      e.preventDefault()
      return
    }
    // R — rotate prefab being placed (priority), or selected group, by 90°.
    //   Shift+R = CCW. Designer mode + not typing in an input.
    if ((e.key === 'r' || e.key === 'R') && getPhase() === 'designer') {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      const ccw = e.shiftKey
      if (ChallengeBuilder.getPlacingPrefab()) {
        ChallengeBuilder.snapPrefabRotation90(ccw)
        e.preventDefault()
        return
      }
      if (ChallengeBuilder.getSelectedWallIdx() >= 0) {
        ChallengeBuilder.rotateSelectedGroup(ccw ? -Math.PI / 2 : Math.PI / 2)
        e.preventDefault()
        return
      }
    }
    // Delete/Backspace removes the currently selected placement
    if ((e.key === 'Delete' || e.key === 'Backspace') && ChallengeBuilder.getSelectedPlacement() >= 0) {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      const sel = ChallengeBuilder.getSelectedPlacement()
      ChallengeBuilder.removeEnemy(sel)
      rebuildChPlacements()
      e.preventDefault()
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

  // Rebuild challenge type buttons + spawn-test strip now that enemies are loaded
  rebuildChTypeButtons()
  rebuildSpawnStrip(spawnStrip)
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
            <input id="ed-dodge-${id}" type="checkbox" ${existing?.dodge ? 'checked' : ''}>
            <span style="color:#4FC3F7;font:11px monospace;">Dodge</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-shield-${id}" type="checkbox" ${existing?.shield ? 'checked' : ''}>
            <span style="color:#00DCFF;font:11px monospace;">Shield</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-summon-${id}" type="checkbox" ${existing?.summon ? 'checked' : ''}>
            <span style="color:#FFD740;font:11px monospace;">Summon</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-totem-check-${id}" type="checkbox" ${existing?.totemSpawn ? 'checked' : ''}>
            <span style="color:#66BB6A;font:11px monospace;">Totem</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-shrine-${id}" type="checkbox" ${existing?.isShrine ? 'checked' : ''}>
            <span style="color:#FFD740;font:11px monospace;">Shrine</span>
          </label>
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="ed-pusher-${id}" type="checkbox" ${existing?.pusher ? 'checked' : ''}>
            <span style="color:#FFB74D;font:11px monospace;">Pusher</span>
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
          <input id="ed-volatile-range-${id}" type="range" min="80" max="800" step="10" value="${existing?.volatileRange ?? 150}" style="width:100%;">
        </div>
        <div id="ed-revenge-wrap-${id}" style="margin-top:4px;display:${existing?.revenge ? 'block' : 'none'};">
          <div style="display:flex;gap:6px;">
            <div style="flex:1;"><span style="color:#FF5252;font:9px monospace;">Rings: <span id="ed-revenge-rings-val-${id}">${existing?.revengeRings ?? 4}</span></span><input id="ed-revenge-rings-${id}" type="range" min="1" max="8" step="1" value="${existing?.revengeRings ?? 4}" style="width:100%;"></div>
            <div style="flex:1;"><span style="color:#FF5252;font:9px monospace;">Range: <span id="ed-revenge-radius-val-${id}">${existing?.revengeRadius ?? 120}</span></span><input id="ed-revenge-radius-${id}" type="range" min="60" max="300" step="10" value="${existing?.revengeRadius ?? 120}" style="width:100%;"></div>
          </div>
        </div>
        <div id="ed-pusher-wrap-${id}" style="margin-top:4px;display:${existing?.pusher ? 'block' : 'none'};">
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <div style="flex:1;min-width:80px;"><span style="color:#FFB74D;font:9px monospace;">Every <span id="ed-pusher-beats-val-${id}">${existing?.pusherBeats ?? 2}</span> beats</span><input id="ed-pusher-beats-${id}" type="range" min="0.25" max="16" step="0.25" value="${existing?.pusherBeats ?? 2}" style="width:100%;"></div>
            <div style="flex:1;min-width:80px;"><span style="color:#FFB74D;font:9px monospace;">Offset <span id="ed-pusher-phase-val-${id}">${existing?.pusherPhase ?? 0}</span> beats</span><input id="ed-pusher-phase-${id}" type="range" min="0" max="16" step="0.25" value="${existing?.pusherPhase ?? 0}" style="width:100%;"></div>
            <div style="flex:1;min-width:80px;"><span style="color:#FFB74D;font:9px monospace;">Strength <span id="ed-pusher-strength-val-${id}">${existing?.pusherStrength ?? 600}</span></span><input id="ed-pusher-strength-${id}" type="range" min="50" max="2500" step="50" value="${existing?.pusherStrength ?? 600}" style="width:100%;"></div>
          </div>
        </div>
        <div id="ed-dodge-wrap-${id}" style="margin-top:4px;display:${existing?.dodge ? 'block' : 'none'};">
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <div style="flex:1;min-width:80px;"><span style="color:#4FC3F7;font:9px monospace;">Charges: <span id="ed-dodge-charges-val-${id}">${existing?.dodgeCharges ?? 2}</span></span><input id="ed-dodge-charges-${id}" type="range" min="1" max="5" step="1" value="${existing?.dodgeCharges ?? 2}" style="width:100%;"></div>
            <div style="flex:1;min-width:80px;"><span style="color:#4FC3F7;font:9px monospace;">CD: <span id="ed-dodge-cd-val-${id}">${existing?.dodgeChargeTime ?? 1.5}</span>s</span><input id="ed-dodge-cd-${id}" type="range" min="0.5" max="6" step="0.1" value="${existing?.dodgeChargeTime ?? 1.5}" style="width:100%;"></div>
            <div style="flex:1;min-width:80px;"><span style="color:#4FC3F7;font:9px monospace;">Dist: <span id="ed-dodge-dist-val-${id}">${existing?.dodgeDistance ?? 100}</span></span><input id="ed-dodge-dist-${id}" type="range" min="40" max="1000" step="10" value="${existing?.dodgeDistance ?? 100}" style="width:100%;"></div>
            <div style="flex:1;min-width:80px;"><span style="color:#4FC3F7;font:9px monospace;">Speed: <span id="ed-dodge-speed-val-${id}">${existing?.dodgeSpeed ?? 1}</span>x</span><input id="ed-dodge-speed-${id}" type="range" min="0.3" max="3" step="0.1" value="${existing?.dodgeSpeed ?? 1}" style="width:100%;"></div>
          </div>
        </div>
        <div id="ed-shield-wrap-${id}" style="margin-top:4px;display:${existing?.shield ? 'block' : 'none'};">
          <span style="color:#00DCFF;font:9px monospace;">Recharge: <span id="ed-shield-recharge-val-${id}">${existing?.shieldRechargeTime ?? 4}</span>s</span>
          <input id="ed-shield-recharge-${id}" type="range" min="1" max="20" step="0.5" value="${existing?.shieldRechargeTime ?? 4}" style="width:100%;display:block;">
        </div>
        <div id="ed-summon-wrap-${id}" style="margin-top:4px;display:${existing?.summon ? 'block' : 'none'};">
          <div style="display:flex;gap:6px;align-items:center;">
            <span style="color:#FFD740;font:10px monospace;">Nodes: <span id="ed-summon-nodes-val-${id}">${existing?.summonNodes ?? 3}</span></span>
            <input id="ed-summon-nodes-${id}" type="range" min="3" max="7" step="1" value="${existing?.summonNodes ?? 3}" style="flex:1;">
          </div>
          <div id="ed-summon-phases-${id}" style="margin-top:4px;">
            ${(existing?.summonPhases ?? [{ spawns: [] }]).map((phase: any, pi: number) =>
              `<div class="ed-phase-row" style="display:flex;gap:3px;align-items:center;margin-top:2px;" draggable="true">
                <span class="ed-phase-handle" style="cursor:grab;color:#666;font:11px monospace;user-select:none;">≡</span>
                <span class="ed-phase-label" style="color:#FFD740;font:9px monospace;min-width:18px;">P${pi + 1}</span>
                <input class="ed-summon-phase" type="text" value="${(phase.spawns ?? []).map((s: any) => s.enemyName + ':' + s.count).join(', ')}" placeholder="enemy:count, ..." style="flex:1;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
                <span class="ed-phase-up" style="cursor:pointer;color:#888;font:10px monospace;user-select:none;" title="Move up">▲</span>
                <span class="ed-phase-down" style="cursor:pointer;color:#888;font:10px monospace;user-select:none;" title="Move down">▼</span>
                <span class="ed-phase-del" style="cursor:pointer;color:#FF5252;font:12px monospace;user-select:none;" title="Delete">×</span>
              </div>`
            ).join('')}
          </div>
          <button id="ed-summon-add-phase-${id}" style="margin-top:4px;padding:3px 8px;cursor:pointer;background:rgba(255,215,64,0.1);border:1px solid rgba(255,215,64,0.3);color:#FFD740;font:9px monospace;border-radius:3px;">+ Phase</button>
        </div>
        <div id="ed-totem-wrap-${id}" style="margin-top:4px;display:${existing?.totemSpawn ? 'block' : 'none'};">
          <span style="color:#66BB6A;font:10px monospace;">Spawn:</span>
          <input id="ed-totem-${id}" type="text" value="${existing?.totemSpawn ?? ''}" placeholder="enemy name" style="width:100%;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
        </div>
        <div id="ed-shrine-wrap-${id}" style="margin-top:4px;display:${existing?.isShrine ? 'block' : 'none'};">
          <span style="color:#FFD740;font:10px monospace;">Shrine Phases (each = 1 beat-dash hit):</span>
          <div id="ed-shrine-phases-${id}" style="margin-top:4px;">
            ${(existing?.shrinePhases ?? [{ xpOrbs: 3 }]).map((phase: any, pi: number) =>
              `<div class="ed-shrine-phase-row" draggable="true" style="display:flex;align-items:center;gap:4px;margin-top:2px;padding:2px 4px;background:rgba(255,255,255,0.03);border-radius:3px;">
                <span class="ed-shrine-phase-label" style="color:#FFD740;font:9px monospace;min-width:18px;">S${pi + 1}</span>
                <input class="ed-shrine-phase-input" type="text" value="${phaseToString(phase)}" placeholder="xp:3, hp:1, enemy:Name:2, shop" style="flex:1;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;">
                <span class="ed-shrine-phase-del" style="cursor:pointer;color:#FF5252;font:12px monospace;user-select:none;" title="Delete">×</span>
              </div>`
            ).join('')}
          </div>
          <div style="margin-top:4px;display:flex;gap:6px;">
            <span id="ed-shrine-add-${id}" style="cursor:pointer;color:#64FFc8;font:10px monospace;user-select:none;">+ Add Phase</span>
          </div>
        </div>
      </div>
      <!-- Behavior section -->
      <div style="margin-top:8px;display:flex;gap:8px;">
        <div style="flex:1;">
          <span style="color:#64FFc8;font:9px monospace;">XP: <span id="ed-drop-xp-val-${id}">${existing?.dropXp ?? 100}</span>%</span>
          <input id="ed-drop-xp-${id}" type="range" min="0" max="100" step="5" value="${existing?.dropXp ?? 100}" style="width:100%;">
        </div>
        <div style="flex:1;">
          <span style="color:#FF5252;font:9px monospace;">HP: <span id="ed-drop-hp-val-${id}">${existing?.dropHp ?? 0}</span>%</span>
          <input id="ed-drop-hp-${id}" type="range" min="0" max="100" step="5" value="${existing?.dropHp ?? 0}" style="width:100%;">
        </div>
        <div style="flex:0.6;">
          <span style="color:#aaa;font:9px monospace;">×<span id="ed-drop-count-val-${id}">${existing?.dropCount ?? 1}</span></span>
          <input id="ed-drop-count-${id}" type="range" min="1" max="10" step="1" value="${existing?.dropCount ?? 1}" style="width:100%;">
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
  // Pusher trait wiring — same pattern as revenge (checkbox toggles visibility, sliders
  // mirror their value into the label spans). Beat/phase/strength all live in pusher-wrap.
  const pusherCheckbox = body.querySelector(`#ed-pusher-${id}`) as HTMLInputElement
  const pusherWrap = body.querySelector(`#ed-pusher-wrap-${id}`) as HTMLDivElement
  const pusherBeatsInput = body.querySelector(`#ed-pusher-beats-${id}`) as HTMLInputElement
  const pusherBeatsVal = body.querySelector(`#ed-pusher-beats-val-${id}`) as HTMLSpanElement
  const pusherPhaseInput = body.querySelector(`#ed-pusher-phase-${id}`) as HTMLInputElement
  const pusherPhaseVal = body.querySelector(`#ed-pusher-phase-val-${id}`) as HTMLSpanElement
  const pusherStrengthInput = body.querySelector(`#ed-pusher-strength-${id}`) as HTMLInputElement
  const pusherStrengthVal = body.querySelector(`#ed-pusher-strength-val-${id}`) as HTMLSpanElement
  pusherCheckbox.addEventListener('change', () => {
    pusherWrap.style.display = pusherCheckbox.checked ? 'block' : 'none'
  })
  pusherBeatsInput.addEventListener('input', () => { pusherBeatsVal.textContent = pusherBeatsInput.value })
  pusherPhaseInput.addEventListener('input', () => { pusherPhaseVal.textContent = pusherPhaseInput.value })
  pusherStrengthInput.addEventListener('input', () => { pusherStrengthVal.textContent = pusherStrengthInput.value })

  // Dodge checkbox toggles sliders
  const dodgeCheckbox = body.querySelector(`#ed-dodge-${id}`) as HTMLInputElement
  const dodgeWrap = body.querySelector(`#ed-dodge-wrap-${id}`) as HTMLDivElement
  const dodgeChargesInput = body.querySelector(`#ed-dodge-charges-${id}`) as HTMLInputElement
  const dodgeChargesVal = body.querySelector(`#ed-dodge-charges-val-${id}`) as HTMLSpanElement
  const dodgeCdInput = body.querySelector(`#ed-dodge-cd-${id}`) as HTMLInputElement
  const dodgeCdVal = body.querySelector(`#ed-dodge-cd-val-${id}`) as HTMLSpanElement
  const dodgeDistInput = body.querySelector(`#ed-dodge-dist-${id}`) as HTMLInputElement
  const dodgeDistVal = body.querySelector(`#ed-dodge-dist-val-${id}`) as HTMLSpanElement
  const dodgeSpeedInput = body.querySelector(`#ed-dodge-speed-${id}`) as HTMLInputElement
  const dodgeSpeedVal = body.querySelector(`#ed-dodge-speed-val-${id}`) as HTMLSpanElement
  dodgeCheckbox.addEventListener('change', () => {
    dodgeWrap.style.display = dodgeCheckbox.checked ? 'block' : 'none'
  })
  dodgeChargesInput.addEventListener('input', () => { dodgeChargesVal.textContent = dodgeChargesInput.value })
  dodgeCdInput.addEventListener('input', () => { dodgeCdVal.textContent = dodgeCdInput.value })
  dodgeDistInput.addEventListener('input', () => { dodgeDistVal.textContent = dodgeDistInput.value })
  dodgeSpeedInput.addEventListener('input', () => { dodgeSpeedVal.textContent = dodgeSpeedInput.value })

  // Shield checkbox toggles recharge slider
  const shieldCheckbox = body.querySelector(`#ed-shield-${id}`) as HTMLInputElement
  const shieldWrap = body.querySelector(`#ed-shield-wrap-${id}`) as HTMLDivElement
  const shieldRechargeInput = body.querySelector(`#ed-shield-recharge-${id}`) as HTMLInputElement
  const shieldRechargeVal = body.querySelector(`#ed-shield-recharge-val-${id}`) as HTMLSpanElement
  shieldCheckbox.addEventListener('change', () => {
    shieldWrap.style.display = shieldCheckbox.checked ? 'block' : 'none'
  })
  shieldRechargeInput.addEventListener('input', () => { shieldRechargeVal.textContent = shieldRechargeInput.value })

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

  function renumberPhases(): void {
    const rows = summonPhasesDiv.querySelectorAll('.ed-phase-row')
    rows.forEach((row, i) => {
      const label = row.querySelector('.ed-phase-label') as HTMLSpanElement
      if (label) label.textContent = `P${i + 1}`
    })
  }

  function createPhaseRow(value = ''): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'ed-phase-row'
    row.style.cssText = 'display:flex;gap:3px;align-items:center;margin-top:2px;'
    row.draggable = true
    row.innerHTML = `<span class="ed-phase-handle" style="cursor:grab;color:#666;font:11px monospace;user-select:none;">≡</span><span class="ed-phase-label" style="color:#FFD740;font:9px monospace;min-width:18px;">P1</span><input class="ed-summon-phase" type="text" value="${value}" placeholder="enemy:count, ..." style="flex:1;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;"><span class="ed-phase-up" style="cursor:pointer;color:#888;font:10px monospace;user-select:none;" title="Move up">▲</span><span class="ed-phase-down" style="cursor:pointer;color:#888;font:10px monospace;user-select:none;" title="Move down">▼</span><span class="ed-phase-del" style="cursor:pointer;color:#FF5252;font:12px monospace;user-select:none;" title="Delete">×</span>`
    return row
  }

  // Phase controls — delegate clicks on the container
  summonPhasesDiv.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const row = target.closest('.ed-phase-row') as HTMLElement | null
    if (!row) return
    if (target.classList.contains('ed-phase-up')) {
      const prev = row.previousElementSibling
      if (prev) { summonPhasesDiv.insertBefore(row, prev); renumberPhases() }
    } else if (target.classList.contains('ed-phase-down')) {
      const next = row.nextElementSibling
      if (next) { summonPhasesDiv.insertBefore(next, row); renumberPhases() }
    } else if (target.classList.contains('ed-phase-del')) {
      row.remove(); renumberPhases()
    }
  })

  // Drag and drop reorder
  let dragRow: HTMLElement | null = null
  summonPhasesDiv.addEventListener('dragstart', (e) => {
    dragRow = (e.target as HTMLElement).closest('.ed-phase-row')
    if (dragRow) dragRow.style.opacity = '0.4'
  })
  summonPhasesDiv.addEventListener('dragend', () => {
    if (dragRow) dragRow.style.opacity = '1'
    dragRow = null
  })
  summonPhasesDiv.addEventListener('dragover', (e) => { e.preventDefault() })
  summonPhasesDiv.addEventListener('drop', (e) => {
    e.preventDefault()
    if (!dragRow) return
    const target = (e.target as HTMLElement).closest('.ed-phase-row') as HTMLElement | null
    if (target && target !== dragRow) {
      const rows = Array.from(summonPhasesDiv.querySelectorAll('.ed-phase-row'))
      const dragIdx = rows.indexOf(dragRow)
      const dropIdx = rows.indexOf(target)
      if (dragIdx < dropIdx) {
        summonPhasesDiv.insertBefore(dragRow, target.nextSibling)
      } else {
        summonPhasesDiv.insertBefore(dragRow, target)
      }
      renumberPhases()
    }
  })

  summonAddPhase.addEventListener('click', () => {
    const row = createPhaseRow()
    summonPhasesDiv.appendChild(row)
    renumberPhases()
  })

  // Shrine checkbox + phase list
  const shrineCheckbox = body.querySelector(`#ed-shrine-${id}`) as HTMLInputElement
  const shrineWrap = body.querySelector(`#ed-shrine-wrap-${id}`) as HTMLDivElement
  const shrinePhasesDiv = body.querySelector(`#ed-shrine-phases-${id}`) as HTMLDivElement
  const shrineAddBtn = body.querySelector(`#ed-shrine-add-${id}`) as HTMLSpanElement

  shrineCheckbox.addEventListener('change', () => {
    shrineWrap.style.display = shrineCheckbox.checked ? 'block' : 'none'
  })

  function renumberShrinePhases(): void {
    const labels = shrinePhasesDiv.querySelectorAll('.ed-shrine-phase-label')
    labels.forEach((el, i) => { el.textContent = `S${i + 1}` })
  }

  function createShrinePhaseRow(value = 'xp:3'): HTMLDivElement {
    const row = document.createElement('div')
    row.className = 'ed-shrine-phase-row'
    row.draggable = true
    row.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;padding:2px 4px;background:rgba(255,255,255,0.03);border-radius:3px;'
    row.innerHTML = `<span class="ed-shrine-phase-label" style="color:#FFD740;font:9px monospace;min-width:18px;">S1</span><input class="ed-shrine-phase-input" type="text" value="${value}" placeholder="xp:3, hp:1, enemy:Name:2, shop" style="flex:1;padding:3px 5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#eee;font:10px monospace;border-radius:3px;"><span class="ed-shrine-phase-del" style="cursor:pointer;color:#FF5252;font:12px monospace;user-select:none;" title="Delete">×</span>`
    return row
  }

  shrinePhasesDiv.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const row = target.closest('.ed-shrine-phase-row') as HTMLElement
    if (!row) return
    if (target.classList.contains('ed-shrine-phase-del')) {
      row.remove()
      renumberShrinePhases()
    }
  })

  shrineAddBtn.addEventListener('click', () => {
    const row = createShrinePhaseRow()
    shrinePhasesDiv.appendChild(row)
    renumberShrinePhases()
  })

  // Drop sliders
  const dropXpInput = body.querySelector(`#ed-drop-xp-${id}`) as HTMLInputElement
  const dropXpVal = body.querySelector(`#ed-drop-xp-val-${id}`) as HTMLSpanElement
  const dropHpInput = body.querySelector(`#ed-drop-hp-${id}`) as HTMLInputElement
  const dropHpVal = body.querySelector(`#ed-drop-hp-val-${id}`) as HTMLSpanElement
  const dropCountInput = body.querySelector(`#ed-drop-count-${id}`) as HTMLInputElement
  const dropCountVal = body.querySelector(`#ed-drop-count-val-${id}`) as HTMLSpanElement
  dropXpInput.addEventListener('input', () => { dropXpVal.textContent = dropXpInput.value })
  dropHpInput.addEventListener('input', () => { dropHpVal.textContent = dropHpInput.value })
  dropCountInput.addEventListener('input', () => { dropCountVal.textContent = dropCountInput.value })

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
      dodge: form.dodge ?? false,
      dodgeCharges: form.dodgeCharges ?? 2,
      dodgeChargeTime: form.dodgeChargeTime ?? 1.5,
      dodgeDistance: form.dodgeDistance ?? 100,
      dodgeSpeed: form.dodgeSpeed ?? 1,
      shield: form.shield ?? false,
      shieldRechargeTime: form.shieldRechargeTime ?? 4,
      totemSpawn: form.totemSpawn ?? '',
      isShrine: form.isShrine ?? false,
      shrineSpawnEnemy: form.shrineSpawnEnemy ?? '',
      shrineXpCount: form.shrineXpCount ?? 0,
      shrineHpCount: form.shrineHpCount ?? 0,
      shrinePhases: form.shrinePhases ?? [],
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
    const pusher = (div.querySelector(`#ed-pusher-${id}`) as HTMLInputElement).checked
    const pusherBeats = parseFloat((div.querySelector(`#ed-pusher-beats-${id}`) as HTMLInputElement).value) || 2
    const pusherPhase = parseFloat((div.querySelector(`#ed-pusher-phase-${id}`) as HTMLInputElement).value) || 0
    const pusherStrength = parseInt((div.querySelector(`#ed-pusher-strength-${id}`) as HTMLInputElement).value) || 600
    const dodge = (div.querySelector(`#ed-dodge-${id}`) as HTMLInputElement).checked
    const dodgeCharges = parseInt((div.querySelector(`#ed-dodge-charges-${id}`) as HTMLInputElement).value) || 2
    const dodgeChargeTime = parseFloat((div.querySelector(`#ed-dodge-cd-${id}`) as HTMLInputElement).value) || 1.5
    const dodgeDistance = parseInt((div.querySelector(`#ed-dodge-dist-${id}`) as HTMLInputElement).value) || 100
    const dodgeSpeed = parseFloat((div.querySelector(`#ed-dodge-speed-${id}`) as HTMLInputElement).value) || 1
    const shield = (div.querySelector(`#ed-shield-${id}`) as HTMLInputElement).checked
    const shieldRechargeTime = parseFloat((div.querySelector(`#ed-shield-recharge-${id}`) as HTMLInputElement).value) || 4
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
    const isShrine = (div.querySelector(`#ed-shrine-${id}`) as HTMLInputElement).checked
    const shrinePhaseInputs = div.querySelectorAll(`#ed-shrine-phases-${id} .ed-shrine-phase-input`) as NodeListOf<HTMLInputElement>
    const shrinePhases: ShrinePhase[] = []
    shrinePhaseInputs.forEach(input => {
      const text = input.value.trim()
      if (!text) return
      shrinePhases.push(parsePhaseString(text))
    })
    const shrineSpawnEnemy = ''
    const shrineXpCount = 0
    const shrineHpCount = 0
    const dropXp = parseInt((div.querySelector(`#ed-drop-xp-${id}`) as HTMLInputElement).value) || 0
    const dropHp = parseInt((div.querySelector(`#ed-drop-hp-${id}`) as HTMLInputElement).value) || 0
    const dropCount = parseInt((div.querySelector(`#ed-drop-count-${id}`) as HTMLInputElement).value) || 1
    const dropType: 'xp' | 'hp' | 'none' = dropXp > 0 ? 'xp' : dropHp > 0 ? 'hp' : 'none'
    const movePattern = (div.querySelector(`#ed-move-${id}`) as HTMLSelectElement).value as import('../entities/EnemyTypes.ts').MovePattern
    const rings: RingConfig[] = readRingForms()
    const sound = (rings[0]?.sound ?? 'pop') as SoundName
    const beats = rings[0]?.beats ?? []
    const ringRadius = rings[0]?.ringRadius ?? 120
    const finalHp = isShrine && shrinePhases.length > 0 ? shrinePhases.length : hp
    return { name, color, hp: finalHp, moveSpeed: speed, radius, ringRadius, key, role: sound, sound, beats, rings, blocksRings, consume, magnet, magnetRange, blink, blinkBeats, volatile: volatile_, volatileRange, revenge, revengeRings, revengeRadius, pusher, pusherBeats, pusherPhase, pusherStrength, dodge, dodgeCharges, dodgeChargeTime, dodgeDistance, dodgeSpeed, shield, shieldRechargeTime, movePattern, totemSpawn, dropType, dropXp, dropHp, dropCount, summon, summonNodes, summonPhases, isShrine, shrineSpawnEnemy, shrineXpCount, shrineHpCount, shrinePhases }
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
    // Auto-save to project folder (dev server only, no download)
    const data = { version: SAVE_VERSION, enemies: designedEnemies, challenges: ChallengeBuilder.getChallenges() }
    fetch('/api/save-enemies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data, null, 2),
    }).catch(() => {})
  })

  // Spawn — matches the spawn-test strip behavior (500-700px ring around the player)
  div.querySelector(`#ed-spawn-${id}`)!.addEventListener('click', () => {
    const designed = readForm()
    if (!ENEMY_TYPES.find(t => t.name === designed.name)) ENEMY_TYPES.push(designed)
    const player = getPlayer()
    const angle = Math.random() * Math.PI * 2
    const dist = 500 + Math.random() * 200
    const sx = player.x + Math.cos(angle) * dist
    const sy = player.y + Math.sin(angle) * dist
    const radius = (designed as any).radius ?? 40
    const pos = findClearSpawnPos(sx, sy, radius, getEnemies(), player)
    getEnemies().push(createEnemy(pos.x, pos.y, designed))
  })
}

function rebuildPattern(): void {
  const pat = getPattern()
  const patterns: Record<string, number[]> = pat ? { ...pat.patterns } : {
    'Player': [0, 1, 2, 3, 4, 5, 6, 7],
  }
  // Always include HalfBeat for zigzag enemies
  if (!patterns['HalfBeat']) {
    patterns['HalfBeat'] = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5]
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

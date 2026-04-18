import type { Player } from '../entities/Player.ts'
import { getEffectiveRadius, getBodyRadius } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { getRingOrigins } from '../entities/Enemy.ts'
import type { Ring } from '../entities/Ring.ts'
import { getRingExpansion, getRingAlpha, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import { getPattern, getLoopPosition, getLoopLength } from '../audio/PatternClock.ts'
import { getPreviewEnemy } from '../game/EnemyDesigner.ts'
import type { Camera } from '../game/Arena.ts'
import { ARENA_W, ARENA_H, ARENA_RADIUS, ARENA_CX, ARENA_CY, PILL_R, PILL_HALF_W, CROSS_HW, CROSS_HE, getArenaShape, getHexVertices, getCrossVertices } from '../game/Arena.ts'
import { getBlockedArcs } from '../game/RingOcclusion.ts'
import { getRitualGroups, getActiveIndex } from '../game/RitualNodes.ts'
import { isPlaceMode, getPlacingEnemies, getSelectedPlacement, getChallenges, getActiveChallenge } from '../game/ChallengeBuilder.ts'
import { getBestTime, getScoresForChallenge, formatTime, hasOnlineScores } from '../game/HighScores.ts'
import type { Challenge } from '../game/ChallengeBuilder.ts'
import type { BlockedArc } from '../game/RingOcclusion.ts'
import { getEnemies, getRunTimer, isRunTimerActive, isRunComplete, getRunFinalTime, getPhase, getRunBeatCount } from '../core/GameState.ts'
import { hasBonus } from '../game/UpgradeManager.ts'
import { getOrbs } from '../entities/XPOrb.ts'
import { getBeatName, getVolume } from '../audio/AudioEngine.ts'
import { isTouchMode, getJoystickState } from '../game/InputManager.ts'
import { BEAT_SEC } from '../utils/constants.ts'
import {
  GRID_ALPHA,
  GRID_CELL_PX,
  COLOR_PLAYER,
  PLAYER_RADIUS,
  MAX_RING_RADIUS,
  PARTICLE_CAP,
  ARENA_BUFFER,
  HIT_FLASH_DURATION,
  SHIELD_ORBIT_RADIUS_OFFSET,
  SHIELD_BREAK_FLASH,
  MASTER_BPM,
  COLOR_BG,
} from '../utils/constants.ts'

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let width = 0
let height = 0
let camX = 0
let camY = 0

// ── Particle system ──
interface Particle {
  x: number; y: number
  vx: number; vy: number
  r: number; g: number; b: number
  life: number
  lifetime: number
  size: number
}

const particles: Particle[] = []
const MAX_PARTICLES = PARTICLE_CAP
let lastDt = 0.016
let borderWaveIntensity = 0
let globalBeatPulse = 0  // 0→1 on ring fire, decays — used by all beat-sync visuals
let titleTime = 0         // time since title screen started
let titleBeatPulse = 0    // beat pulse for title screen
let titleLastBeat = -1    // last whole beat seen on title
let nameEntryText = ''    // current name being typed
let pauseMouseX = 0
let pauseMouseY = 0
export function updatePauseMouse(x: number, y: number): void { pauseMouseX = x; pauseMouseY = y }
let bgPulseSmooth = 0    // smoothed follower for background color
let gameTimeMs = 0       // accumulated game time in ms (pauses when game pauses)
export function getGameTimeMs(): number { return gameTimeMs }

export function getLogicalSize(): { w: number; h: number } { return { w: width, h: height } }

// "Add to Home Screen" message for iOS
let addToHomeTimer = 0
export function showAddToHomeMessage(): void { addToHomeTimer = 15 }
export function dismissAddToHomeMessage(): void { addToHomeTimer = Math.min(addToHomeTimer, 0.8) }

/** Convert screen (CSS) coords to canvas (logical) coords */
export function screenToCanvas(screenX: number, screenY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((screenX - rect.left) / rect.width) * width,
    y: ((screenY - rect.top) / rect.height) * height,
  }
}
let outerPulseIntensity = 0
let dashSweepIntensity = 0
let beatDashFlash = 0       // countdown for beat dash shockwave visual
let beatDashX = 0
let beatDashY = 0
let beatDashRadius = 0
let dashSweepRadius = 0
let ringPeakX = 0  // player position at ring peak — for aligned post-peak effects
let ringPeakY = 0
let dashSweepPath: { x: number; y: number }[] = []
let prevShieldCharges = -1  // track for restore particle trigger
let shieldRestoreAnim = 0   // countdown for restore converge effect
let shieldDisplayProgress = 0  // smoothed recharge progress for retreat animation
let prevDashSlots: number[] = []  // track dash slot states for burst detection
let frameDt = 0.016         // render dt stored for use in draw functions
const wavePts: number[] = []  // reused per frame for all waveforms

// ── Perf tracking ──
const perfTimers: Record<string, number> = {}
let perfDisplay: Record<string, number> = {}
let perfAccum: Record<string, number> = {}
let perfFrames = 0

export function perfStart(label: string): void {
  perfTimers[label] = performance.now()
}
export function perfEnd(label: string): void {
  const start = perfTimers[label]
  if (start !== undefined) {
    perfAccum[label] = (perfAccum[label] ?? 0) + (performance.now() - start)
  }
}
const perfFrame: Record<string, number> = {}

function perfFlush(): void {
  // Capture this frame's values (delta from last accumulation)
  const snapshot: Record<string, number> = {}
  for (const k of Object.keys(perfAccum)) {
    snapshot[k] = (perfAccum[k] ?? 0) - (perfFrame[k] ?? 0)
    perfFrame[k] = perfAccum[k] ?? 0
  }
  perfLog.push(snapshot)
  if (perfLog.length > MAX_LOG_FRAMES) perfLog.shift()

  perfFrames++
  if (perfFrames >= 60) {
    perfDisplay = { ...perfAccum }
    for (const k of Object.keys(perfAccum)) {
      perfAccum[k] = 0
      perfFrame[k] = 0
    }
    perfFrames = 0
  }
}
export function getPerfDisplay(): Record<string, number> { return perfDisplay }

// Perf log — stores per-frame snapshots for export
const perfLog: Record<string, number>[] = []
const MAX_LOG_FRAMES = 600  // ~10 seconds at 60fps

export function exportPerfLog(): void {
  const csv = ['frame,' + Object.keys(perfLog[0] ?? {}).join(',')]
  for (let i = 0; i < perfLog.length; i++) {
    const row = perfLog[i]!
    csv.push(i + ',' + Object.values(row).map(v => v.toFixed(3)).join(','))
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'perf-log.csv'
  a.click()
  URL.revokeObjectURL(url)
  console.log('Perf log exported:', perfLog.length, 'frames')
}

// Death ripples
interface DeathRipple {
  x: number; y: number
  r: number; g: number; b: number
  startRadius: number
  maxRadius: number
  timer: number
  delay: number
  duration: number
}
const deathRipples: DeathRipple[] = []

const MAX_RIPPLES = 30

// Orb absorb effects — stream from orb to player
interface AbsorbEffect {
  originX: number; originY: number
  targetX: number; targetY: number  // -1,-1 = track player
  r: number; g: number; b: number
  timer: number
  duration: number
}
const absorbEffects: AbsorbEffect[] = []
const MAX_ABSORBS = 15

export function addAbsorbEffect(x: number, y: number, r: number, g: number, b: number, targetX = -1, targetY = -1): void {
  if (absorbEffects.length >= MAX_ABSORBS) absorbEffects.shift()
  absorbEffects.push({ originX: x, originY: y, targetX, targetY, r, g, b, timer: 0, duration: 0.4 })
}

function updateAndDrawAbsorbEffects(dt: number, player: Player): void {
  for (let i = absorbEffects.length - 1; i >= 0; i--) {
    const fx = absorbEffects[i]!
    fx.timer += dt
    if (fx.timer >= fx.duration) {
      absorbEffects[i] = absorbEffects[absorbEffects.length - 1]!
      absorbEffects.pop()
      continue
    }
    const t = fx.timer / fx.duration

    const sx1 = fx.originX - camX
    const sy1 = fx.originY - camY
    const tx = fx.targetX < 0 ? player.x : fx.targetX
    const ty = fx.targetY < 0 ? player.y : fx.targetY
    const sx2 = tx - camX
    const sy2 = ty - camY
    const ddx = sx2 - sx1, ddy = sy2 - sy1

    // 5 orbs streaming from origin to player
    const chainCount = 5
    const spacing = 0.1
    ctx.lineCap = 'round'

    for (let c = 0; c < chainCount; c++) {
      const orbT = t - c * spacing
      if (orbT < 0 || orbT > 1) continue
      const orbEase = orbT * orbT * (3 - 2 * orbT)  // smooth ease in-out
      const orbLife = 1 - orbT

      // Sine wave perpendicular to travel direction
      const perpX = -ddy, perpY = ddx
      const perpLen = Math.sqrt(perpX * perpX + perpY * perpY)
      const wave = perpLen > 1
        ? Math.sin(orbT * 12 + c * 1.5) * 15 * orbLife * orbLife  // wave fades faster near target
        : 0
      const wnx = perpLen > 1 ? perpX / perpLen : 0
      const wny = perpLen > 1 ? perpY / perpLen : 0

      const orbX = sx1 + ddx * orbEase + wnx * wave
      const orbY = sy1 + ddy * orbEase + wny * wave
      const orbSize = (16 - c * 1.6) * Math.max(orbLife, 0.15)

      // Glow
      ctx.beginPath()
      ctx.arc(orbX, orbY, orbSize + 13, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${orbLife * 0.1})`
      ctx.fill()

      // Core
      ctx.beginPath()
      ctx.arc(orbX, orbY, Math.max(1, orbSize), 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${Math.min(255, fx.r + 80)}, ${Math.min(255, fx.g + 60)}, ${Math.min(255, fx.b + 60)}, ${orbLife * 0.6})`
      ctx.fill()

      // Beam to next
      if (c < chainCount - 1) {
        const nextT = t - (c + 1) * spacing
        if (nextT >= 0) {
          const nextEase = nextT * nextT * (3 - 2 * nextT)
          const nextLife = 1 - nextT
          const nextWave = Math.sin(nextT * 12 + (c + 1) * 1.5) * 15 * nextLife * nextLife
          const nextX = sx1 + ddx * nextEase + wnx * nextWave
          const nextY = sy1 + ddy * nextEase + wny * nextWave
          ctx.beginPath()
          ctx.moveTo(orbX, orbY)
          ctx.lineTo(nextX, nextY)
          ctx.strokeStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${orbLife * 0.25})`
          ctx.lineWidth = 3.5 * orbLife
          ctx.stroke()
        }
      }

      // Energy sparks along stream
      if (Math.random() < 0.3) {
        const sparkSpeed = 15 + Math.random() * 25
        const sa = Math.random() * Math.PI * 2
        spawnParticle(
          fx.originX + (tx - fx.originX) * orbEase + wnx * wave,
          fx.originY + (ty - fx.originY) * orbEase + wny * wave,
          Math.cos(sa) * sparkSpeed, Math.sin(sa) * sparkSpeed,
          fx.r, fx.g, fx.b, 0.1 + Math.random() * 0.08, 2 + Math.random() * 1.5)
      }
    }
    ctx.lineCap = 'butt'
  }
}

// Volatile explosion effects
interface VolatileExplosion {
  x: number; y: number
  range: number
  r: number; g: number; b: number
  timer: number
  duration: number
}
const volatileExplosions: VolatileExplosion[] = []

// Pending volatile buildup visuals (read from GameManager)
export interface PendingExplosionVisual {
  x: number; y: number; range: number
  r: number; g: number; b: number; timer: number
}
let pendingExplosionVisuals: PendingExplosionVisual[] = []

export function setPendingExplosions(pending: PendingExplosionVisual[]): void {
  pendingExplosionVisuals = pending
}

export function addVolatileExplosion(x: number, y: number, range: number, r: number, g: number, b: number): void {
  volatileExplosions.push({ x, y, range, r, g, b, timer: 0, duration: 0.3 })
}

export function spawnVolatileParticles(cx: number, cy: number, range: number, r: number, g: number, b: number): void {
  const count = Math.min(30, Math.round(range / 6))
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
    const dist = Math.random() * range  // spread across entire circle
    const px = cx + Math.cos(angle) * dist
    const py = cy + Math.sin(angle) * dist
    const speed = 40 + Math.random() * 80
    const outAngle = Math.atan2(py - cy, px - cx)
    // Enemy color tinted toward red-white
    const tint = Math.random()
    const pr = Math.min(255, r + Math.floor(tint * 120))
    const pg = Math.min(255, g + Math.floor(tint * 40))
    const pb = Math.min(255, b + Math.floor(tint * 40))
    spawnParticle(px, py,
      Math.cos(outAngle) * speed, Math.sin(outAngle) * speed,
      pr, pg, pb,
      0.45 + Math.random() * 0.25, 9 + Math.random() * 7)
  }
}

function updateAndDrawVolatileEffects(dt: number): void {
  // Buildup — ring expands from center to blast range over 1s
  for (const p of pendingExplosionVisuals) {
    const sx = p.x - camX, sy = p.y - camY
    const progress = Math.min(p.timer / BEAT_SEC, 1)  // 0→1 over 1 second
    const ringR = progress * p.range
    const alpha = 0.15 + progress * 0.25

    // Start red, blend slightly toward enemy color mid-way, then back to red
    const redBase = 0.6  // 60% red from the start
    const redBlend = redBase + (1 - redBase) * progress
    const rr = Math.min(255, Math.floor(p.r + (255 - p.r) * redBlend))
    const rg = Math.floor(p.g * (1 - redBlend * 0.8))
    const rb = Math.floor(p.b * (1 - redBlend * 0.8))

    // Dark fill inside swept area — "claimed" zone, intensifies smoothly
    ctx.beginPath()
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${rr}, ${rg}, ${rb}, ${progress * progress * 0.12})`
    ctx.fill()

    // Outer glow — gets wider and brighter smoothly
    ctx.beginPath()
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rr}, ${rg}, ${rb}, ${alpha * 0.25 + progress * 0.15})`
    ctx.lineWidth = 6 + progress * 8
    ctx.stroke()

    // Core ring — smooth intensification
    ctx.beginPath()
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rr}, ${rg}, ${rb}, ${alpha + progress * 0.2})`
    ctx.lineWidth = 2 + progress * 4
    ctx.stroke()

    // Fire particles inside the ring — intensify toward detonation
    const fireRate = progress * progress * 0.8  // accelerates: sparse early, dense late
    if (ringR > 5) {
      for (let f = 0; f < 3; f++) {
        if (Math.random() < fireRate) {
          const a = Math.random() * Math.PI * 2
          const dist = Math.random() * ringR * 0.9
          const px = p.x + Math.cos(a) * dist
          const py = p.y + Math.sin(a) * dist
          // Rise upward + drift outward
          const outA = Math.atan2(py - p.y, px - p.x)
          const speed = 15 + Math.random() * 30
          const fr = Math.min(255, rr + Math.floor(Math.random() * 40))
          const fg = Math.floor(40 + Math.random() * 60 * (1 - progress))
          spawnParticle(px, py,
            Math.cos(outA) * speed * 0.5, -20 - Math.random() * 40 + Math.sin(outA) * speed * 0.3,
            fr, fg, 20, 0.2 + progress * 0.2, 3 + Math.random() * 3)
        }
      }
      // Edge sparks along the expanding ring — inside and outside
      for (let e = 0; e < 2; e++) {
        if (Math.random() < fireRate * 1.5) {
          const a = Math.random() * Math.PI * 2
          const edgeDist = ringR + (Math.random() - 0.5) * 16  // straddle the ring edge
          const speed = 40 + Math.random() * 60
          const inward = Math.random() < 0.5 ? -1 : 1
          spawnParticle(
            p.x + Math.cos(a) * edgeDist, p.y + Math.sin(a) * edgeDist,
            Math.cos(a) * speed * inward, Math.sin(a) * speed * inward - 15,
            255, 120 + Math.floor(Math.random() * 80), 30,
            0.12 + Math.random() * 0.1, 2 + Math.random() * 2)
        }
      }
    }
  }

  // Explosion flashes
  for (let i = volatileExplosions.length - 1; i >= 0; i--) {
    const ex = volatileExplosions[i]!
    ex.timer += dt
    if (ex.timer >= ex.duration) {
      volatileExplosions[i] = volatileExplosions[volatileExplosions.length - 1]!
      volatileExplosions.pop()
      continue
    }
    const t = ex.timer / ex.duration
    const alpha = (1 - t) * (1 - t)
    const sx = ex.x - camX, sy = ex.y - camY

    // Red-tinted flash — carries the buildup color into detonation
    const erR = Math.min(255, ex.r + Math.floor((255 - ex.r) * 0.7))
    const erG = Math.floor(ex.g * 0.4)
    const erB = Math.floor(ex.b * 0.4)

    // Full area flash
    ctx.beginPath()
    ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 200, 200, ${alpha * 0.3})`
    ctx.fill()

    // Red-tinted fill
    ctx.beginPath()
    ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${erR}, ${erG}, ${erB}, ${alpha * 0.25})`
    ctx.fill()

    // Edge ring
    ctx.beginPath()
    ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${erR}, ${erG}, ${erB}, ${alpha * 0.5})`
    ctx.lineWidth = 3 * (1 - t)
    ctx.stroke()
  }
}

// Revenge ring fire — uses real ring system
interface RevengeRingAnim {
  x: number; y: number; radius: number
  color: [number, number, number, number]
  timer: number
  expandTime: number  // time to peak — synced to next beat
}
const revengeRings: RevengeRingAnim[] = []

export function spawnRevengeRingParticles(x: number, y: number, radius: number, r: number, g: number, b: number, expandTime: number): void {
  revengeRings.push({ x, y, radius, color: [r / 255, g / 255, b / 255, 1], timer: 0, expandTime })
}

function updateAndDrawRevengeRings(dt: number): void {
  for (let i = revengeRings.length - 1; i >= 0; i--) {
    const rr = revengeRings[i]!
    rr.timer += dt
    if (rr.timer > rr.expandTime + 0.15) {
      revengeRings[i] = revengeRings[revengeRings.length - 1]!
      revengeRings.pop()
      continue
    }
    const fakeRing = { radius: rr.radius, color: rr.color, tempo: 1, phase: 0 }
    drawRing(rr.x, rr.y, fakeRing as any, rr.timer, rr.radius, rr.expandTime)
  }
}

// Totem spawn effects
interface SpawnEffect {
  totemX: number; totemY: number
  spawnX: number; spawnY: number
  r: number; g: number; b: number
  timer: number
  duration: number
  totemRadius: number
}
const spawnEffects: SpawnEffect[] = []
const MAX_SPAWN_EFFECTS = 10

export function addSpawnEffect(totemX: number, totemY: number, totemRadius: number, spawnX: number, spawnY: number, color: string): void {
  if (spawnEffects.length >= MAX_SPAWN_EFFECTS) spawnEffects.shift()
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  spawnEffects.push({ totemX, totemY, spawnX, spawnY, r, g, b, timer: 0, duration: 0.51, totemRadius })
}

function updateAndDrawSpawnEffects(dt: number): void {
  for (let i = spawnEffects.length - 1; i >= 0; i--) {
    const fx = spawnEffects[i]!
    fx.timer += dt
    if (fx.timer >= fx.duration) {
      spawnEffects[i] = spawnEffects[spawnEffects.length - 1]!
      spawnEffects.pop()
      continue
    }
    const t = fx.timer / fx.duration
    const ease = 1 - (1 - t) * (1 - t)  // ease-out

    const sx1 = fx.totemX - camX
    const sy1 = fx.totemY - camY
    const sx2 = fx.spawnX - camX
    const sy2 = fx.spawnY - camY
    const alpha = (1 - t) * (1 - t)

    // Direction from totem to spawn
    const ddx = sx2 - sx1, ddy = sy2 - sy1
    const dLen = Math.sqrt(ddx * ddx + ddy * ddy)
    const dnx = dLen > 0 ? ddx / dLen : 0, dny = dLen > 0 ? ddy / dLen : 0

    // 1. Totem flash — bright glow on totem body at the start
    if (t < 0.2) {
      const flashAlpha = (1 - t / 0.2) * 0.6
      ctx.beginPath()
      ctx.arc(sx1, sy1, fx.totemRadius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${flashAlpha})`
      ctx.fill()
    }

    // 2. Ejection chain — 5 orbs shooting from totem, fast with trail
    const chainCount = 5
    const spacing = 0.08
    ctx.lineCap = 'round'

    for (let c = 0; c < chainCount; c++) {
      const orbT = t - c * spacing
      if (orbT < 0 || orbT > 1) continue
      // Cubic ease-out — fast launch, decelerates
      const orbEase = 1 - (1 - orbT) * (1 - orbT) * (1 - orbT)
      const orbLife = 1 - orbT
      const isLead = c === 0
      const orbSize = isLead ? 28 : (20 - c * 2.5)
      if (orbSize <= 0) continue

      const orbX = sx1 + ddx * orbEase
      const orbY = sy1 + ddy * orbEase

      // All orbs white-hot to bright, glow in enemy color
      const blend = c / chainCount  // 0 = lead (white), 1 = tail (lighter enemy color)
      const coreR = Math.floor(255 - blend * (255 - Math.min(255, fx.r + 120)) * 0.5)
      const coreG = Math.floor(255 - blend * (255 - Math.min(255, fx.g + 100)) * 0.5)
      const coreB = Math.floor(255 - blend * (255 - Math.min(255, fx.b + 100)) * 0.5)

      // Glow halo — enemy color
      ctx.beginPath()
      ctx.arc(orbX, orbY, orbSize + 16, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${Math.min(255, fx.r + 80)}, ${Math.min(255, fx.g + 60)}, ${Math.min(255, fx.b + 60)}, ${orbLife * 0.15})`
      ctx.fill()

      // Core orb — white to light
      ctx.beginPath()
      ctx.arc(orbX, orbY, orbSize * orbLife, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${coreR}, ${coreG}, ${coreB}, ${orbLife * 0.8})`
      ctx.fill()

      // Beam to next orb — bright white
      if (c < chainCount - 1) {
        const nextT = t - (c + 1) * spacing
        if (nextT >= 0) {
          const nextEase = 1 - (1 - nextT) * (1 - nextT) * (1 - nextT)
          const nextX = sx1 + ddx * nextEase
          const nextY = sy1 + ddy * nextEase
          ctx.beginPath()
          ctx.moveTo(orbX, orbY)
          ctx.lineTo(nextX, nextY)
          ctx.strokeStyle = `rgba(255, 255, 255, ${orbLife * 0.2})`
          ctx.lineWidth = 10 * orbLife
          ctx.stroke()
        }
      }
    }

    ctx.lineCap = 'butt'

    // 3. Spawn pulse ring — expands from spawn point when head arrives
    if (t > 0.3) {
      const pulseT = (t - 0.3) / 0.7
      const pulseR = 16 + pulseT * 70
      const pulseAlpha = (1 - pulseT) * (1 - pulseT) * 0.5
      ctx.beginPath()
      ctx.arc(sx2, sy2, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${pulseAlpha})`
      ctx.lineWidth = 3 * (1 - pulseT)
      ctx.stroke()
    }
  }
}

function spawnDeathRipples(x: number, y: number, radius: number, color: string): void {
  if (deathRipples.length >= MAX_RIPPLES) return
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  for (let i = 0; i < 3; i++) {
    deathRipples.push({
      x, y, r, g, b,
      startRadius: radius,
      maxRadius: radius + 150 + i * 80,
      timer: 0,
      delay: i * 0.06,
      duration: 0.3 + i * 0.075,
    })
  }
}

function updateAndDrawDeathRipples(dt: number): void {
  for (let i = deathRipples.length - 1; i >= 0; i--) {
    const rip = deathRipples[i]!
    rip.timer += dt
    if (rip.timer < rip.delay) continue
    const elapsed = rip.timer - rip.delay
    if (elapsed >= rip.duration) {
      // Swap-and-pop instead of splice
      deathRipples[i] = deathRipples[deathRipples.length - 1]!
      deathRipples.pop()
      continue
    }
    const t = elapsed / rip.duration
    const eased = 1 - (1 - t) * (1 - t)
    const radius = rip.startRadius + (rip.maxRadius - rip.startRadius) * eased
    const alpha = (1 - t) * (1 - t)
    const sx = rip.x - camX
    const sy = rip.y - camY
    // Dashed dissolve ring — distinct from solid attack rings
    const dashLen = 6 + t * 12  // gaps widen as it expands
    ctx.setLineDash([dashLen, dashLen * (0.8 + t)])
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rip.r}, ${rip.g}, ${rip.b}, ${alpha * 0.17})`
    ctx.lineWidth = 2.5 * (1 - t * 0.4)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

function spawnParticle(
  x: number, y: number,
  vx: number, vy: number,
  r: number, g: number, b: number,
  lifetime: number, size: number
): void {
  if (particles.length >= MAX_PARTICLES) return
  particles.push({ x, y, vx, vy, r, g, b, life: 0, lifetime, size })
}

export function triggerBeatDashFlash(x: number, y: number, radius: number): void {
  beatDashFlash = 0.444
  beatDashX = x
  beatDashY = y
  beatDashRadius = radius
}

export function spawnParticleExport(
  x: number, y: number, vx: number, vy: number,
  r: number, g: number, b: number, lifetime: number, size: number
): void {
  spawnParticle(x, y, vx, vy, r, g, b, lifetime, size)
}

function spawnRingParticles(
  cx: number, cy: number, radius: number,
  ri: number, gi: number, bi: number,
  count: number, speed: number, lifetime: number, size: number,
  blocked: BlockedArc[] = []
): void {
  const angleOffset = Math.random() * Math.PI * 2  // random rotation per burst
  for (let i = 0; i < count; i++) {
    const angle = angleOffset + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI * 2 / count) * 0.3
    // Skip if in a blocked arc
    if (blocked.length > 0) {
      let skip = false
      const na = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
      for (const arc of blocked) {
        const s = ((arc.start % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        const e = ((arc.end % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        if (s <= e ? (na >= s && na <= e) : (na >= s || na <= e)) { skip = true; break }
      }
      if (skip) continue
    }
    const px = cx + Math.cos(angle) * radius
    const py = cy + Math.sin(angle) * radius
    const s = speed * (0.5 + Math.random())
    const vx = Math.cos(angle) * s + (Math.random() - 0.5) * s * 0.7
    const vy = Math.sin(angle) * s + (Math.random() - 0.5) * s * 0.7
    spawnParticle(px, py, vx, vy, ri, gi, bi, lifetime * (0.8 + Math.random() * 0.2), size * 1.1)
  }
}

function updateParticles(dt: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!
    p.life += dt / p.lifetime
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.vx *= 0.98
    p.vy *= 0.98
    if (p.life >= 1) {
      particles[i] = particles[particles.length - 1]!
      particles.pop()
    }
  }
}

function drawParticles(): void {
  for (const p of particles) {
    const t = 1 - p.life
    const alpha = Math.min(1, t * 1.6)  // bright early, smooth fade
    const sx = p.x - camX
    const sy = p.y - camY
    const spin = p.life * 2.7 + (p.x * 0.01)  // spin based on lifetime + unique offset
    const hs = p.size / 2
    ctx.fillStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha})`
    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(spin)
    ctx.fillRect(-hs, -hs, p.size, p.size)
    ctx.restore()
  }
}

export function init(c: HTMLCanvasElement): void {
  canvas = c
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not get 2d context')
  ctx = context
  resize()
  window.addEventListener('resize', resize)
  window.addEventListener('orientationchange', () => setTimeout(resize, 100))
}

// Target minimum visible area — ensures small screens see enough of the world
const MIN_VIEW_H = 620

function resize(): void {
  const screenW = canvas.clientWidth || window.innerWidth
  const screenH = canvas.clientHeight || window.innerHeight
  // On small screens, scale up the canvas so it represents a larger view
  const scale = screenH < MIN_VIEW_H ? MIN_VIEW_H / screenH : 1
  width = Math.round(screenW * scale)
  height = Math.round(screenH * scale)
  canvas.width = width
  canvas.height = height
}

/** Clear all renderer state — call on run restart */
/** Draw a hex path (for clip, border, buffer) centered at screen coords */
function hexPath(cx: number, cy: number, r: number): void {
  const verts = getHexVertices(cx + camX, cy + camY, r)  // world coords
  ctx.beginPath()
  for (let i = 0; i < verts.length; i++) {
    const vx = verts[i]!.x - camX
    const vy = verts[i]!.y - camY
    if (i === 0) ctx.moveTo(vx, vy)
    else ctx.lineTo(vx, vy)
  }
  ctx.closePath()
}

/** Draw hex path in screen-space directly (no camera offset needed) */
function hexPathScreen(cx: number, cy: number, r: number): void {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3
    const vx = cx + Math.cos(angle) * r
    const vy = cy + Math.sin(angle) * r
    if (i === 0) ctx.moveTo(vx, vy)
    else ctx.lineTo(vx, vy)
  }
  ctx.closePath()
}

/** Add a cross subpath from world-space vertices (no beginPath) */
function crossPath(cx: number, cy: number, ccw = false): void {
  const verts = getCrossVertices(cx + camX, cy + camY)
  const len = verts.length
  for (let i = 0; i < len; i++) {
    const idx = ccw ? len - 1 - i : i
    const vx = verts[idx]!.x - camX
    const vy = verts[idx]!.y - camY
    if (i === 0) ctx.moveTo(vx, vy)
    else ctx.lineTo(vx, vy)
  }
  ctx.closePath()
}

/** Add a cross subpath at screen coords with offset */
function crossPathScreen(cx: number, cy: number, offset = 0): void {
  const hw = CROSS_HW + offset, he = CROSS_HE + offset
  const pts = [
    [cx - hw, cy - he], [cx + hw, cy - he],
    [cx + hw, cy - hw], [cx + he, cy - hw],
    [cx + he, cy + hw], [cx + hw, cy + hw],
    [cx + hw, cy + he], [cx - hw, cy + he],
    [cx - hw, cy + hw], [cx - he, cy + hw],
    [cx - he, cy - hw], [cx - hw, cy - hw],
  ]
  ctx.beginPath()
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) ctx.moveTo(pts[i]![0]!, pts[i]![1]!)
    else ctx.lineTo(pts[i]![0]!, pts[i]![1]!)
  }
  ctx.closePath()
}

/** Add a pill/stadium subpath (no beginPath — caller controls that) */
function pillPath(cx: number, cy: number, halfW: number, r: number, ccw = false): void {
  if (ccw) {
    // Reverse winding for even-odd clip cutout
    ctx.moveTo(cx + halfW, cy + r)
    ctx.arc(cx + halfW, cy, r, Math.PI / 2, -Math.PI / 2, true)
    ctx.arc(cx - halfW, cy, r, -Math.PI / 2, Math.PI / 2, true)
  } else {
    ctx.moveTo(cx - halfW, cy + r)
    ctx.arc(cx - halfW, cy, r, Math.PI / 2, -Math.PI / 2)
    ctx.arc(cx + halfW, cy, r, -Math.PI / 2, Math.PI / 2)
  }
  ctx.closePath()
}

export function resetRenderer(): void {
  particles.length = 0
  deathRipples.length = 0
  spawnEffects.length = 0
  absorbEffects.length = 0
  volatileExplosions.length = 0
  pendingExplosionVisuals = []
  revengeRings.length = 0
  borderWaveIntensity = 0
  globalBeatPulse = 0
  outerPulseIntensity = 0
  dashSweepIntensity = 0
  dashSweepPath = []
  shieldDisplayProgress = 0
  gameTimeMs = 0
}

export function render(player: Player, enemies: Enemy[], _alpha: number, fps = 0, dt = 0.016, cam?: Camera): void {
  // Portrait orientation check — touch-capable devices
  const hasTouchScreen = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  if (hasTouchScreen && window.innerWidth < window.innerHeight) {
    ctx.fillStyle = '#0D0A1A'
    ctx.fillRect(0, 0, width, height)
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Rotate icon — phone outline with arrow
    const rcx = width / 2
    const rcy = height / 2 - 30
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.roundRect(rcx - 20, rcy - 35, 40, 70, 6)
    ctx.stroke()
    // Rotation arrow
    ctx.beginPath()
    ctx.arc(rcx, rcy, 50, -Math.PI * 0.3, Math.PI * 0.8)
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.4)'
    ctx.lineWidth = 2
    ctx.stroke()
    // Arrowhead
    const arrowEnd = Math.PI * 0.8
    const ax = rcx + Math.cos(arrowEnd) * 50
    const ay = rcy + Math.sin(arrowEnd) * 50
    ctx.beginPath()
    ctx.moveTo(ax + 8, ay - 6)
    ctx.lineTo(ax, ay)
    ctx.lineTo(ax + 8, ay + 6)
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.4)'
    ctx.lineWidth = 2
    ctx.stroke()
    // Text
    ctx.font = 'bold 24px monospace'
    ctx.fillStyle = 'rgba(0, 255, 255, 0.8)'
    ctx.fillText('ROTATE DEVICE', rcx, rcy + 80)
    ctx.font = '16px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.fillText('Landscape mode required', rcx, rcy + 110)
    ctx.restore()
    return
  }

  perfStart('R_TOTAL')
  lastDt = dt
  frameDt = dt
  if (getPhase() === 'playing') gameTimeMs += dt * 1000

  if (cam) {
    camX = cam.x - width / 2
    camY = cam.y - height / 2
  } else {
    camX = player.x - width / 2
    camY = player.y - height / 2
  }

  updateParticles(dt)

  // Update global beat pulse — used by all beat-sync visuals
  if (player.attackTimer >= 0) {
    const buildup = Math.min(player.attackTimer / (ATTACK_EXPAND_TIME * 0.8), 1)
    const target = buildup * buildup * 0.5
    if (target > globalBeatPulse) globalBeatPulse = target
  } else {
    globalBeatPulse *= 0.95
    if (globalBeatPulse < 0.005) globalBeatPulse = 0
  }

  // Background — smooth follower for color shift
  if (globalBeatPulse > bgPulseSmooth) {
    bgPulseSmooth += (globalBeatPulse - bgPulseSmooth) * 0.15
  } else {
    bgPulseSmooth += (globalBeatPulse - bgPulseSmooth) * 0.08
  }
  const bgR = 13 + Math.floor(bgPulseSmooth * 25)
  const bgG = 10 + Math.floor(bgPulseSmooth * 12)
  const bgB = 26 + Math.floor(bgPulseSmooth * 20)
  ctx.fillStyle = `rgb(${bgR}, ${bgG}, ${bgB})`
  ctx.fillRect(0, 0, width, height)

  perfStart('grid')
  drawGrid(player)
  perfEnd('grid')

  // Cross corner mask — paint concave corners before border effects so glow renders on top
  if (getArenaShape() === 'cross') {
    const cx = ARENA_CX - camX, cy = ARENA_CY - camY
    const hw = CROSS_HW, he = CROSS_HE
    ctx.fillStyle = '#0D0A1A'
    ctx.fillRect(cx - he, cy - he, he - hw, he - hw)
    ctx.fillRect(cx + hw, cy - he, he - hw, he - hw)
    ctx.fillRect(cx - he, cy + hw, he - hw, he - hw)
    ctx.fillRect(cx + hw, cy + hw, he - hw, he - hw)
  }

  drawArenaBorder(player)
  perfStart('ripples')
  updateAndDrawDeathRipples(lastDt)
  perfEnd('ripples')

  // Clip rings and particles to arena bounds
  perfStart('clip')
  ctx.save()
  const shape = getArenaShape()
  if (shape === 'cross') {
    // Use bounding box clip (fast) — we'll mask the corners after drawing
    ctx.beginPath()
    ctx.rect(ARENA_CX - CROSS_HE - camX, ARENA_CY - CROSS_HE - camY, CROSS_HE * 2, CROSS_HE * 2)
  } else if (shape === 'pill') {
    // Use bounding box clip (fast) — pill caps are masked by buffer zone
    ctx.beginPath()
    ctx.rect(ARENA_CX - PILL_HALF_W - PILL_R - camX, ARENA_CY - PILL_R - camY, (PILL_HALF_W + PILL_R) * 2, PILL_R * 2)
  } else if (shape === 'hex') {
    hexPath(ARENA_CX - camX, ARENA_CY - camY, ARENA_RADIUS)
  } else if (shape === 'circle') {
    ctx.beginPath()
    ctx.arc(ARENA_CX - camX, ARENA_CY - camY, ARENA_RADIUS, 0, Math.PI * 2)
  } else {
    ctx.beginPath()
    ctx.rect(-camX, -camY, ARENA_W, ARENA_H)
  }
  ctx.clip()
  perfEnd('clip')

  updateAndDrawVolatileEffects(lastDt)

  perfStart('e_occlusion')
  // Pre-compute blocked arcs for all enemies with active rings
  const blockedArcsCache = new Map<Enemy, BlockedArc[]>()
  const allEnemies = getEnemies()
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.dying) continue
    for (const rs of enemy.rings) {
      const ringRadius = rs.ring.radius * getRingExpansion(rs.attackTimer)
      if (ringRadius > 1) {
        blockedArcsCache.set(enemy, getBlockedArcs(enemy.x, enemy.y, ringRadius, allEnemies, enemy))
        break  // only need arcs once per enemy, not per ring
      }
    }
  }
  perfEnd('e_occlusion')

  perfStart('e_rings')
  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    if (!enemy.dying) {
      const arcs = blockedArcsCache.get(enemy) ?? []
      for (const rs of enemy.rings) {
        // Capture enemy position at ring peak
        const pastPeak = rs.attackTimer - rs.expandTime
        if (pastPeak >= 0 && !rs.peakCaptured) {
          rs.peakX = enemy.x
          rs.peakY = enemy.y
          rs.peakCaptured = true
        }
        // Use peak position for post-peak, current position for pre-peak
        const useX = rs.peakCaptured && pastPeak >= 0 ? rs.peakX : enemy.x
        const useY = rs.peakCaptured && pastPeak >= 0 ? rs.peakY : enemy.y
        const savedX = enemy.x
        const savedY = enemy.y
        enemy.x = useX
        enemy.y = useY
        const origins = getRingOrigins(enemy, rs)
        enemy.x = savedX
        enemy.y = savedY
        for (const origin of origins) {
          drawRing(origin.x, origin.y, rs.ring, rs.attackTimer, undefined, rs.expandTime, arcs)
        }
      }
    }
  }
  updateAndDrawRevengeRings(lastDt)
  perfEnd('e_rings')

  perfStart('e_bodies')
  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    drawEnemy(enemy, player)
  }
  perfEnd('e_bodies')

  // Dash sweep band — follows curved dash path
  {
    // Check main ring + all extra rings for peak
    let anyPeak = false
    const mainPast = player.attackTimer - ATTACK_EXPAND_TIME
    if (mainPast >= 0 && mainPast < 0.03) anyPeak = true
    for (let i = 0; i < player.extraRingCount; i++) {
      const extraPast = player.extraRingTimers[i]! - ATTACK_EXPAND_TIME
      if (extraPast >= 0 && extraPast < 0.03) anyPeak = true
    }

    if (player.dashTimer >= 0 && anyPeak) {
      dashSweepIntensity = 1
      dashSweepRadius = getEffectiveRadius(player) * 1.0  // full radius at peak
      const capStart = Math.floor(player.dashPath.length * 0.7)
      dashSweepPath = player.dashPath.slice(capStart).map(p => ({ x: p.x, y: p.y }))
      dashSweepPath.push({ x: player.x, y: player.y })
    } else {
      dashSweepIntensity *= 0.92
      if (dashSweepIntensity < 0.005) dashSweepIntensity = 0
    }

    if (dashSweepIntensity > 0.005 && dashSweepPath.length > 1) {
      const fade = dashSweepIntensity
      const grace = 8
      // Draw along curved path
      for (let s = 0; s < dashSweepPath.length; s++) {
        const pt = dashSweepPath[s]!
        const sx = pt.x - camX
        const sy = pt.y - camY
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 80, 80, ${0.13 * fade})`
        ctx.lineWidth = grace * 2
        ctx.stroke()
      }
      for (const edgeR of [dashSweepRadius + grace, Math.max(0, dashSweepRadius - grace)]) {
        ctx.beginPath()
        for (const pt of dashSweepPath) {
          const sx = pt.x - camX
          const sy = pt.y - camY
          ctx.moveTo(sx + edgeR, sy)
          ctx.arc(sx, sy, edgeR, 0, Math.PI * 2)
        }
        ctx.strokeStyle = `rgba(255, 80, 80, ${0.4 * fade})`
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
  }

  perfStart('p_ring')
  // Capture position at ring peak, use it for post-peak so flash + particles align
  const pastPeakPlayer = player.attackTimer - ATTACK_EXPAND_TIME
  if (pastPeakPlayer >= 0 && pastPeakPlayer < lastDt * 2) {
    ringPeakX = player.x
    ringPeakY = player.y
  }
  const ringDrawX = pastPeakPlayer >= 0 ? ringPeakX : player.x
  const ringDrawY = pastPeakPlayer >= 0 ? ringPeakY : player.y
  drawRing(ringDrawX, ringDrawY, player.ring, player.attackTimer, getEffectiveRadius(player))

  // Extra rings from upgrades — same peak position logic
  for (let i = 0; i < player.extraRingCount; i++) {
    const extraTimer = player.extraRingTimers[i]!
    const extraPastPeak = extraTimer - ATTACK_EXPAND_TIME
    if (extraPastPeak >= 0 && extraPastPeak < lastDt * 2) {
      ringPeakX = player.x
      ringPeakY = player.y
    }
    const exDrawX = extraPastPeak >= 0 ? ringPeakX : player.x
    const exDrawY = extraPastPeak >= 0 ? ringPeakY : player.y
    drawRing(exDrawX, exDrawY, player.ring, extraTimer, getEffectiveRadius(player))
  }
  perfEnd('p_ring')

  perfStart('orbs')
  drawXPOrbs(player)
  perfEnd('orbs')

  perfStart('particles')
  drawParticles()
  perfEnd('particles')

  ctx.restore()

  drawRitualNodes()

  perfStart('player')
  drawPlayer(player)
  perfEnd('player')

  // Beat dash shockwave — drawn on top of everything
  if (beatDashFlash > 0) {
    beatDashFlash -= lastDt
    const t = beatDashFlash / 0.444  // 1→0
    const bsx = beatDashX - camX
    const bsy = beatDashY - camY

    // White area flash — exact hitbox size, brighter initial
    const whiteAlpha = t > 0.7 ? t * 0.3 : t * t * 0.15
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${whiteAlpha})`
    ctx.fill()

    // Red shockwave expanding to fill attack range
    const shockExpand = Math.min((1 - t) * 3, 1)
    const shockR = beatDashRadius * shockExpand
    if (shockR > 2) {
      ctx.beginPath()
      ctx.arc(bsx, bsy, shockR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 40, 40, ${t * 0.3})`
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 60, 60, ${t * 0.7})`
      ctx.lineWidth = 5 * t
      ctx.stroke()
    }

    // Cyan border glow at exact hitbox edge
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(0, 255, 255, ${t * 0.15})`
    ctx.lineWidth = 8 * t
    ctx.stroke()
    // Cyan border crisp
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(0, 255, 255, ${t * 0.7})`
    ctx.lineWidth = 2 * t + 1
    ctx.stroke()

    // Initial burst particles on first frame
    if (beatDashFlash > 0.42) {
      for (let p = 0; p < 8; p++) {
        const pa = (p / 8) * Math.PI * 2 + Math.random() * 0.4
        const dist = beatDashRadius * (0.3 + Math.random() * 0.7)
        spawnParticle(
          beatDashX + Math.cos(pa) * dist,
          beatDashY + Math.sin(pa) * dist,
          Math.cos(pa) * 60, Math.sin(pa) * 60,
          0, 230, 255, 0.25 + Math.random() * 0.15, 7 + Math.random() * 5)
      }
    }

    // Disintegration particles breaking off the edge
    if (Math.random() < 0.6 + (1 - t) * 0.4) {
      const count = Math.ceil(3 + (1 - t) * 4)  // more particles as it fades
      for (let p = 0; p < count; p++) {
        const pa = Math.random() * Math.PI * 2
        const dist = beatDashRadius * (0.6 + Math.random() * 0.4)
        const px = beatDashX + Math.cos(pa) * dist
        const py = beatDashY + Math.sin(pa) * dist
        const speed = 20 + Math.random() * 40
        const outA = pa + (Math.random() - 0.5) * 1.5
        spawnParticle(px, py,
          Math.cos(outA) * speed, Math.sin(outA) * speed - 15,
          255, 60 + Math.floor(Math.random() * 60), 50 + Math.floor(Math.random() * 50),
          0.2 + Math.random() * 0.15, 4 + Math.random() * 3)
      }
    }
  }

  updateAndDrawSpawnEffects(lastDt)
  updateAndDrawAbsorbEffects(lastDt, player)

  if (__DEV__) {
    drawDesignerPreview(player)
    drawSpawnPanel()
    drawChallengePlacements()
  }

  drawHUD(player, enemies, fps)
  perfEnd('R_TOTAL')
  perfFlush()

  // Perf overlay — dev only
  if (__DEV__) {
    const perf = perfDisplay
    const perfKeys = Object.keys(perf)
    if (perfKeys.length > 0) {
      const perfY = 140
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(width - 180, perfY, 180, perfKeys.length * 14 + 8)
      ctx.font = '11px monospace'
      let py = perfY + 14
      for (const k of perfKeys) {
        const ms = perf[k]! / 60
        ctx.fillStyle = ms > 2 ? '#FF5252' : ms > 1 ? '#FFD740' : '#888'
        ctx.fillText(`${k}: ${ms.toFixed(2)}ms`, width - 174, py)
        py += 14
      }
    }
  }
}

function drawGrid(player: Player): void {
  const cellSize = GRID_CELL_PX

  // Subtle fine grid texture
  {
    const gridSize = 8
    const startX = Math.floor(camX / gridSize) * gridSize
    const startY = Math.floor(camY / gridSize) * gridSize
    ctx.strokeStyle = 'rgba(100, 130, 200, 0.05)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (let gx = startX; gx < camX + width + gridSize; gx += gridSize) {
      const sx = gx - camX
      ctx.moveTo(sx, 0)
      ctx.lineTo(sx, height)
    }
    for (let gy = startY; gy < camY + height + gridSize; gy += gridSize) {
      const sy = gy - camY
      ctx.moveTo(0, sy)
      ctx.lineTo(width, sy)
    }
    ctx.stroke()
  }

  // Inner vignette — spotlight centered on player, edges darken
  const psx = player.x - camX
  const psy = player.y - camY
  const shape = getArenaShape()
  const maxR = shape === 'circle' ? ARENA_RADIUS
    : shape === 'hex' ? ARENA_RADIUS
    : shape === 'pill' ? PILL_HALF_W + PILL_R
    : shape === 'cross' ? CROSS_HE
    : Math.max(ARENA_W, ARENA_H) * 0.5

  const vignetteGrad = ctx.createRadialGradient(psx, psy, maxR * 0.15, psx, psy, maxR * 0.9)
  // Vignette breathes with beat — lighter center on pulse
  const vPulse = globalBeatPulse * 0.02
  vignetteGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignetteGrad.addColorStop(0.3, `rgba(0, 0, 0, ${0.2 - vPulse})`)
  vignetteGrad.addColorStop(0.6, `rgba(0, 0, 0, ${0.45 - vPulse})`)
  vignetteGrad.addColorStop(1, `rgba(0, 0, 0, ${0.9 - vPulse})`)
  ctx.fillStyle = vignetteGrad
  ctx.fillRect(0, 0, width, height)

}

function drawArenaBorder(player: Player): void {
  const x = -camX
  const y = -camY
  const w = ARENA_W
  const h = ARENA_H
  const buffer = ARENA_BUFFER

  // Beat pulse — swells on ring fire
  const beatPulse = player.attackTimer >= 0
    ? getRingExpansion(player.attackTimer) * 0.6
    : 0

  // Wave intensity — ramps up before explosion, decays after
  const timeToPeak = ATTACK_EXPAND_TIME - player.attackTimer
  if (player.attackTimer >= 0 && timeToPeak >= -0.04 && timeToPeak < 0.08) {
    // Ramp from 0→1 over 0.08s, peaking 0.04s after explosion
    const ramp = 1 - (Math.max(0, timeToPeak) / 0.08)
    const target = ramp * ramp  // ease-in curve
    if (target > borderWaveIntensity) borderWaveIntensity = target
  } else {
    borderWaveIntensity *= 0.92
    if (borderWaveIntensity < 0.005) borderWaveIntensity = 0
  }

  const arenaShape = getArenaShape()
  const isRound = arenaShape !== 'rect'
  const acx = ARENA_CX - camX  // arena center in screen coords
  const acy = ARENA_CY - camY

  perfStart('buf_zone')
  // Dark buffer zone
  if (isRound) {
    const pillExtent = PILL_HALF_W + PILL_R
    const shapeExtent = arenaShape === 'pill' ? pillExtent : arenaShape === 'cross' ? CROSS_HE : ARENA_RADIUS
    const bufInner = shapeExtent * 0.85
    const bufOuter = shapeExtent + buffer
    const bufGrad = ctx.createRadialGradient(acx, acy, bufInner, acx, acy, bufOuter)
    bufGrad.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
    bufGrad.addColorStop(1, 'rgba(0, 0, 0, 0.85)')
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
    if (arenaShape === 'cross') {
      crossPath(acx, acy, true)
    } else if (arenaShape === 'pill') {
      pillPath(acx, acy, PILL_HALF_W, PILL_R, true)
    } else if (arenaShape === 'hex') {
      const verts = getHexVertices(ARENA_CX, ARENA_CY, ARENA_RADIUS)
      for (let i = verts.length - 1; i >= 0; i--) {
        const vx = verts[i]!.x - camX, vy = verts[i]!.y - camY
        if (i === verts.length - 1) ctx.moveTo(vx, vy)
        else ctx.lineTo(vx, vy)
      }
      ctx.closePath()
    } else {
      ctx.arc(acx, acy, ARENA_RADIUS, 0, Math.PI * 2, true)
    }
    ctx.clip('evenodd')
    ctx.fillStyle = bufGrad
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  } else {
    // Top
    const topGrad = ctx.createLinearGradient(0, y, 0, y - buffer)
    topGrad.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
    topGrad.addColorStop(1, 'rgba(0, 0, 0, 0.85)')
    ctx.fillStyle = topGrad
    ctx.fillRect(x - buffer, y - buffer, w + buffer * 2, buffer)
    // Bottom
    const botGrad = ctx.createLinearGradient(0, y + h, 0, y + h + buffer)
    botGrad.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
    botGrad.addColorStop(1, 'rgba(0, 0, 0, 0.85)')
    ctx.fillStyle = botGrad
    ctx.fillRect(x - buffer, y + h, w + buffer * 2, buffer)
    // Left
    const leftGrad = ctx.createLinearGradient(x, 0, x - buffer, 0)
    leftGrad.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
    leftGrad.addColorStop(1, 'rgba(0, 0, 0, 0.85)')
    ctx.fillStyle = leftGrad
    ctx.fillRect(x - buffer, y, buffer, h)
    // Right
    const rightGrad = ctx.createLinearGradient(x + w, 0, x + w + buffer, 0)
    rightGrad.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
    rightGrad.addColorStop(1, 'rgba(0, 0, 0, 0.85)')
    ctx.fillStyle = rightGrad
    ctx.fillRect(x + w, y, buffer, h)
    // Corners
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)'
    ctx.fillRect(x - buffer, y - buffer, buffer, buffer)
    ctx.fillRect(x + w, y - buffer, buffer, buffer)
    ctx.fillRect(x - buffer, y + h, buffer, buffer)
    ctx.fillRect(x + w, y + h, buffer, buffer)
  }

  perfEnd('buf_zone')
  perfStart('glow')
  // Arena border — layered glow with beat pulse
  const drawBorder = (alpha: number, lw: number, offset = 0) => {
    ctx.strokeStyle = `rgba(79, 195, 247, ${alpha})`
    ctx.lineWidth = lw
    if (arenaShape === 'cross') {
      crossPathScreen(acx, acy, offset)
      ctx.stroke()
    } else if (arenaShape === 'pill') {
      ctx.beginPath()
      pillPath(acx, acy, PILL_HALF_W, PILL_R + offset)
      ctx.stroke()
    } else if (arenaShape === 'hex') {
      hexPathScreen(acx, acy, ARENA_RADIUS + offset)
      ctx.stroke()
    } else if (arenaShape === 'circle') {
      ctx.beginPath()
      ctx.arc(acx, acy, ARENA_RADIUS + offset, 0, Math.PI * 2)
      ctx.stroke()
    } else {
      ctx.strokeRect(x - offset, y - offset, w + offset * 2, h + offset * 2)
    }
  }
  drawBorder(0.03 + beatPulse * 0.04, 30, 10)
  drawBorder(0.06 + beatPulse * 0.06, 18, 4)
  drawBorder(0.12 + beatPulse * 0.1, 8, 0)
  drawBorder(0.4 + beatPulse * 0.25, 2, 0)

  perfEnd('glow')
  perfStart('waveform')
  // Waveform line — spikes on beat, flattens out smoothly
  if (borderWaveIntensity > 0.005) {
    const baseAmp = borderWaveIntensity * 11
    const freq = 0.25
    const alpha = Math.min(borderWaveIntensity * 1.5, 0.85)
    const step = 5
    const t = performance.now() * 0.005

    const whiteBlend = Math.min(borderWaveIntensity * 0.6, 0.4)
    const cr = Math.floor(79 + (255 - 79) * whiteBlend)
    const cg = Math.floor(195 + (255 - 195) * whiteBlend)
    const cb = Math.floor(247 + (255 - 247) * whiteBlend)

    const coreWidth = 1 + borderWaveIntensity * 2
    const midWidth = 3 + borderWaveIntensity * 3
    const outerWidth = 6 + borderWaveIntensity * 6

    const px = player.x
    const py = player.y

    const vary = (i: number, seed: number) => {
      const h = Math.sin(i * 0.73 + seed * 3.17) * 0.5 + 0.5
      return 0.3 + h * 0.7
    }

    // ── Compute waveform points once into wavePts, stroke 3x ──
    wavePts.length = 0
    let totalLen = 0
    const waveStep = arenaShape === 'cross' ? 12 : step
    const addWavePt = (wx: number, wy: number, nx: number, ny: number, prox: number, seed: number) => {
      const wave = Math.sin(totalLen * freq + t) * baseAmp * prox * vary(Math.floor(totalLen), seed)
      wavePts.push(wx + nx * wave, wy + ny * wave)
      totalLen += waveStep
    }

    if (arenaShape === 'cross') {
      const verts = getCrossVertices(ARENA_CX, ARENA_CY)
      for (let e = 0; e < 12; e++) {
        const v0 = verts[e]!, v1 = verts[(e + 1) % 12]!
        const edx = v1.x - v0.x, edy = v1.y - v0.y
        const edgeLen = Math.sqrt(edx * edx + edy * edy)
        if (edgeLen < 1) continue
        const enx = edy / edgeLen, eny = -edx / edgeLen
        const midX = v0.x + edx * 0.5, midY = v0.y + edy * 0.5
        const pdx = midX - px, pdy = midY - py
        const prox = 0.3 + 0.7 * Math.max(0, 1 - Math.sqrt(pdx * pdx + pdy * pdy) / (CROSS_HE * 2))
        const edgeSteps = Math.ceil(edgeLen / waveStep)
        for (let s = 0; s <= edgeSteps; s++) {
          const frac = s / edgeSteps
          addWavePt(v0.x + edx * frac - camX, v0.y + edy * frac - camY, enx, eny, prox, e)
        }
      }
    } else if (arenaShape === 'pill') {
      const proxPill = (wx: number, wy: number) => {
        const dx = wx + camX - px, dy = wy + camY - py
        return 0.3 + 0.7 * Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / ((PILL_HALF_W + PILL_R) * 1.5))
      }
      for (let i = -PILL_HALF_W; i <= PILL_HALF_W; i += waveStep) addWavePt(acx + i, acy - PILL_R, 0, -1, proxPill(acx + i, acy - PILL_R), 0)
      const capSteps = Math.ceil(Math.PI * PILL_R / waveStep)
      for (let s = 0; s <= capSteps; s++) {
        const a = -Math.PI / 2 + (s / capSteps) * Math.PI
        const wx = acx + PILL_HALF_W + Math.cos(a) * PILL_R, wy = acy + Math.sin(a) * PILL_R
        addWavePt(wx, wy, Math.cos(a), Math.sin(a), proxPill(wx, wy), 1)
      }
      for (let i = PILL_HALF_W; i >= -PILL_HALF_W; i -= waveStep) addWavePt(acx + i, acy + PILL_R, 0, 1, proxPill(acx + i, acy + PILL_R), 2)
      for (let s = 0; s <= capSteps; s++) {
        const a = Math.PI / 2 + (s / capSteps) * Math.PI
        const wx = acx - PILL_HALF_W + Math.cos(a) * PILL_R, wy = acy + Math.sin(a) * PILL_R
        addWavePt(wx, wy, Math.cos(a), Math.sin(a), proxPill(wx, wy), 3)
      }
    } else if (arenaShape === 'hex') {
      const verts = getHexVertices(ARENA_CX, ARENA_CY, ARENA_RADIUS)
      for (let e = 0; e < 6; e++) {
        const v0 = verts[e]!, v1 = verts[(e + 1) % 6]!
        const edx = v1.x - v0.x, edy = v1.y - v0.y
        const edgeLen = Math.sqrt(edx * edx + edy * edy)
        const enx = edy / edgeLen, eny = -edx / edgeLen
        const midX = v0.x + edx * 0.5, midY = v0.y + edy * 0.5
        const pdx = midX - px, pdy = midY - py
        const prox = 0.3 + 0.7 * (1 - Math.sqrt(pdx * pdx + pdy * pdy) / (ARENA_RADIUS * 2))
        const edgeSteps = Math.ceil(edgeLen / waveStep)
        for (let s = 0; s <= edgeSteps; s++) {
          const frac = s / edgeSteps
          addWavePt(v0.x + edx * frac - camX, v0.y + edy * frac - camY, enx, eny, prox, e)
        }
      }
    } else if (arenaShape === 'circle') {
      const circumference = Math.PI * 2 * ARENA_RADIUS
      const angleStep = (waveStep / circumference) * Math.PI * 2
      for (let a = 0; a < Math.PI * 2; a += angleStep) {
        const edgeX = ARENA_CX + Math.cos(a) * ARENA_RADIUS
        const edgeY = ARENA_CY + Math.sin(a) * ARENA_RADIUS
        const pdx = edgeX - px, pdy = edgeY - py
        const prox = 0.3 + 0.7 * (1 - Math.sqrt(pdx * pdx + pdy * pdy) / (ARENA_RADIUS * 2))
        const wave = Math.sin(a * ARENA_RADIUS * freq + t) * baseAmp * prox * vary(Math.floor(a * ARENA_RADIUS), 0)
        const r = ARENA_RADIUS + wave
        wavePts.push(acx + Math.cos(a) * r, acy + Math.sin(a) * r)
        totalLen += waveStep
      }
    } else {
      // Rect: 4 separate edge segments stored sequentially
      const maxDist = Math.sqrt(ARENA_W * ARENA_W + ARENA_H * ARENA_H)
      const proxR = (posX: number, posY: number) => {
        const dx = posX - px, dy = posY - py
        return 0.3 + 0.7 * (1 - Math.sqrt(dx * dx + dy * dy) / maxDist)
      }
      // Top
      for (let i = 0; i <= w; i += waveStep) addWavePt(x + i, y, 0, -1, proxR(camX + x + i, camY + y), 0)
      wavePts.push(NaN, NaN) // segment break
      // Bottom
      totalLen = 0
      for (let i = 0; i <= w; i += waveStep) addWavePt(x + i, y + h, 0, 1, proxR(camX + x + i, camY + y + h), 2)
      wavePts.push(NaN, NaN)
      // Left
      totalLen = 0
      for (let i = 0; i <= h; i += waveStep) addWavePt(x, y + i, -1, 0, proxR(camX + x, camY + y + i), 4)
      wavePts.push(NaN, NaN)
      // Right
      totalLen = 0
      for (let i = 0; i <= h; i += waveStep) addWavePt(x + w, y + i, 1, 0, proxR(camX + x + w, camY + y + i), 6)
    }

    // ── Stroke the cached points 3x ──
    const isClosedWave = arenaShape !== 'rect'
    const strokeWave = (lw: number, style: string) => {
      ctx.strokeStyle = style
      ctx.lineWidth = lw
      ctx.beginPath()
      let segStart = true
      for (let i = 0; i < wavePts.length; i += 2) {
        const sx = wavePts[i]!, sy = wavePts[i + 1]!
        if (sx !== sx) { // NaN = segment break
          ctx.stroke()
          ctx.beginPath()
          segStart = true
          continue
        }
        if (segStart) { ctx.moveTo(sx, sy); segStart = false }
        else {
          const cpx = (wavePts[i - 2]! + sx) / 2
          const cpy = (wavePts[i - 1]! + sy) / 2
          ctx.quadraticCurveTo(wavePts[i - 2]!, wavePts[i - 1]!, cpx, cpy)
        }
      }
      if (isClosedWave) ctx.closePath()
      ctx.stroke()
    }
    strokeWave(outerWidth, `rgba(${cr}, ${cg}, ${cb}, ${alpha * 0.15})`)
    strokeWave(midWidth, `rgba(${cr}, ${cg}, ${cb}, ${alpha * 0.35})`)
    strokeWave(coreWidth, `rgba(${cr}, ${cg}, ${cb}, ${alpha})`)
  }

  perfEnd('waveform')
  perfStart('outer_pulse')
  // Outer pulse — only outside the arena, clip out the arena rect
  {
    // Smooth follower — eases toward borderWaveIntensity, no harsh flash
    const target = borderWaveIntensity
    if (target > outerPulseIntensity) {
      outerPulseIntensity += (target - outerPulseIntensity) * 0.15  // slow rise
    } else {
      outerPulseIntensity += (target - outerPulseIntensity) * 0.08  // slower fall
    }
    const pulseAlpha = 0.05 + outerPulseIntensity * 0.18
    const pcx = isRound ? acx : x + w / 2
    const pcy = isRound ? acy : y + h / 2
    const innerR = arenaShape === 'pill' ? PILL_HALF_W + PILL_R : arenaShape === 'cross' ? CROSS_HE : isRound ? ARENA_RADIUS : Math.min(w, h) / 2
    const outerR = Math.max(width, height)

    ctx.save()
    // Clip to outside arena only
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
    if (arenaShape === 'cross') {
      crossPath(acx, acy, true)
    } else if (arenaShape === 'pill') {
      pillPath(acx, acy, PILL_HALF_W, PILL_R, true)
    } else if (arenaShape === 'hex') {
      const verts = getHexVertices(ARENA_CX, ARENA_CY, ARENA_RADIUS)
      for (let i = verts.length - 1; i >= 0; i--) {
        const vx = verts[i]!.x - camX, vy = verts[i]!.y - camY
        if (i === verts.length - 1) ctx.moveTo(vx, vy)
        else ctx.lineTo(vx, vy)
      }
      ctx.closePath()
    } else if (arenaShape === 'circle') {
      ctx.arc(acx, acy, ARENA_RADIUS, 0, Math.PI * 2, true)
    } else {
      ctx.rect(x + w, y, -w, h)
    }
    ctx.clip('evenodd')

    const grad = ctx.createRadialGradient(pcx, pcy, innerR, pcx, pcy, outerR)
    grad.addColorStop(0, `rgba(79, 195, 247, ${pulseAlpha})`)
    grad.addColorStop(0.4, `rgba(79, 195, 247, ${pulseAlpha * 0.4})`)
    grad.addColorStop(1, 'rgba(79, 195, 247, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }
  perfEnd('outer_pulse')
}

/** Normalize, split wrapping arcs, merge overlaps, return sorted non-overlapping arcs */
function resolveArcs(blocked: BlockedArc[]): { start: number; end: number }[] {
  if (blocked.length === 0) return []
  const TWO_PI = Math.PI * 2
  const flat: { start: number; end: number }[] = []

  for (const a of blocked) {
    let s = ((a.start % TWO_PI) + TWO_PI) % TWO_PI
    let e = ((a.end % TWO_PI) + TWO_PI) % TWO_PI
    if (s > e) {
      // Wraps around 0 — split into two
      flat.push({ start: s, end: TWO_PI })
      flat.push({ start: 0, end: e })
    } else {
      flat.push({ start: s, end: e })
    }
  }

  // Sort by start
  flat.sort((a, b) => a.start - b.start)

  // Merge overlapping
  const merged: { start: number; end: number }[] = [flat[0]!]
  for (let i = 1; i < flat.length; i++) {
    const prev = merged[merged.length - 1]!
    const curr = flat[i]!
    if (curr.start <= prev.end) {
      prev.end = Math.max(prev.end, curr.end)
    } else {
      merged.push(curr)
    }
  }
  return merged
}

/** Draw a circle arc, skipping blocked angle ranges */
function drawArcWithGaps(cx: number, cy: number, radius: number, blocked: BlockedArc[]): void {
  if (blocked.length === 0) {
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
    return
  }

  const arcs = resolveArcs(blocked)

  let angle = 0
  for (const arc of arcs) {
    if (arc.start > angle + 0.01) {
      ctx.beginPath()
      ctx.arc(cx, cy, radius, angle, arc.start)
      ctx.stroke()
    }
    angle = arc.end
  }
  if (angle < Math.PI * 2 - 0.01) {
    ctx.beginPath()
    ctx.arc(cx, cy, radius, angle, Math.PI * 2)
    ctx.stroke()
  }
}

function drawRing(worldX: number, worldY: number, ring: Ring, attackTimer: number, radiusOverride?: number, expandTime = ATTACK_EXPAND_TIME, blockedArcs: BlockedArc[] = []): void {
  if (attackTimer < 0) return

  const sx = worldX - camX
  const sy = worldY - camY
  const baseRadius = radiusOverride ?? ring.radius
  // Use local expandTime for expansion — not global ATTACK_EXPAND_TIME
  const buildup = Math.min(attackTimer / expandTime, 1)
  const expansion = attackTimer <= expandTime
    ? 1 - (1 - buildup) * (1 - buildup)  // ease-out
    : (attackTimer < expandTime + 0.11 ? 1.0 : 0)
  const currentRadius = baseRadius * expansion
  if (currentRadius < 1) return

  const [r, g, b] = ring.color
  const ri = Math.floor(r * 255)
  const gi = Math.floor(g * 255)
  const bi = Math.floor(b * 255)

  const baseAlpha = 0.12 + 0.68 * buildup * buildup
  const alpha = attackTimer <= expandTime ? baseAlpha
    : (attackTimer < expandTime + 0.05 ? baseAlpha * (1 - (attackTimer - expandTime) / 0.05) : 0)
  const lineW = 1.5 + 2.5 * buildup
  // Red ring visible from peak for a short fade-out
  const pastPeak = attackTimer - expandTime
  const showRedRing = pastPeak >= 0 && pastPeak < 0.2

  // Trail particles — reduced count to leave room for explosions
  if (buildup > 0.3) {
    const trailCount = Math.floor(buildup * 2)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, trailCount, 20 + buildup * 40, 0.3, 2, blockedArcs)
  }

  // Explosion at peak — interleave white + colored for even distribution
  if (showRedRing && pastPeak < lastDt * 2 && particles.length < MAX_PARTICLES - 20) {
    const ringScale = Math.max(1, currentRadius / 140)
    const totalCount = Math.round(25 * ringScale)
    const angleOffset = Math.random() * Math.PI * 2
    for (let i = 0; i < totalCount; i++) {
      const angle = angleOffset + (i / totalCount) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI * 2 / totalCount) * 0.3
      if (blockedArcs.length > 0) {
        let skip = false
        const na = ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
        for (const arc of blockedArcs) {
          const as = ((arc.start % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
          const ae = ((arc.end % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
          if (as <= ae ? (na >= as && na <= ae) : (na >= as || na <= ae)) { skip = true; break }
        }
        if (skip) continue
      }
      const px = worldX + Math.cos(angle) * currentRadius
      const py = worldY + Math.sin(angle) * currentRadius
      const isWhite = i % 3 === 0  // every 3rd is white
      const sp = isWhite ? 20 : 15
      const sv = sp * (0.5 + Math.random())
      const vx = Math.cos(angle) * sv + (Math.random() - 0.5) * sv * 0.7
      const vy = Math.sin(angle) * sv + (Math.random() - 0.5) * sv * 0.7
      const lt = (isWhite ? 0.5 : 0.6) * (0.8 + Math.random() * 0.2)
      const sz = (isWhite ? 8 : 7) * 1.1
      const pr = isWhite ? 255 : ri
      const pg = isWhite ? 255 : gi
      const pb = isWhite ? 255 : bi
      spawnParticle(px, py, vx, vy, pr, pg, pb, lt, sz)
    }
  }

  // Soft outer glow
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${alpha * 0.1})`
  ctx.lineWidth = lineW + 6
  drawArcWithGaps(sx, sy, currentRadius, blockedArcs)

  // Mid glow
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${alpha * 0.2})`
  ctx.lineWidth = lineW + 2
  drawArcWithGaps(sx, sy, currentRadius, blockedArcs)

  // Main ring — sharp crisp stroke
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${alpha})`
  ctx.lineWidth = lineW
  drawArcWithGaps(sx, sy, currentRadius, blockedArcs)

  // Red flash at peak
  if (showRedRing) {
    const redAlpha = 0.8 * (1 - pastPeak / 0.2)
    // Wide outer glow
    ctx.strokeStyle = `rgba(255, 100, 100, ${redAlpha * 0.08})`
    ctx.lineWidth = 26
    drawArcWithGaps(sx, sy, currentRadius, blockedArcs)
    // Soft red glow
    ctx.strokeStyle = `rgba(255, 100, 100, ${redAlpha * 0.18})`
    ctx.lineWidth = 10
    drawArcWithGaps(sx, sy, currentRadius, blockedArcs)
    // Mid red
    ctx.strokeStyle = `rgba(255, 80, 80, ${redAlpha * 0.5})`
    ctx.lineWidth = 5
    drawArcWithGaps(sx, sy, currentRadius, blockedArcs)
    // Sharp red core
    ctx.strokeStyle = `rgba(255, 80, 80, ${redAlpha})`
    ctx.lineWidth = 3
    drawArcWithGaps(sx, sy, currentRadius, blockedArcs)
  }
}

function drawXPOrbs(player: Player): void {
  const orbs = getOrbs()
  const playerRadius = player.attackTimer >= 0 ? getEffectiveRadius(player) * getRingExpansion(player.attackTimer) : 0
  for (const orb of orbs) {
    if (!orb.alive && !orb.dying) continue
    const sx = orb.x - camX
    const sy = orb.y - camY

    // Resolve orb color by type
    const isHP = orb.orbType === 'hp'
    const isDouble = orb.value >= 2
    let orbR: number, orbG: number, orbB: number
    if (isHP) {
      orbR = isDouble ? 255 : 230
      orbG = isDouble ? 80 : 60
      orbB = isDouble ? 80 : 70
    } else {
      orbR = isDouble ? 100 : 100
      orbG = isDouble ? 215 : 255
      orbB = isDouble ? 50 : 200
    }

    // Death animation — dissolve like enemies
    if (orb.dying) {
      const t = Math.min(orb.deathTimer / 0.2, 1)
      const r = orb.baseRadius * (1 - t * 0.5)

      // Spawn particles on first frame — fly toward player
      if (orb.deathTimer < 0.02) {
        const toPlayerDx = player.x - orb.x
        const toPlayerDy = player.y - orb.y
        const toPlayerDist = Math.sqrt(toPlayerDx * toPlayerDx + toPlayerDy * toPlayerDy)
        const tpnx = toPlayerDist > 1 ? toPlayerDx / toPlayerDist : 0
        const tpny = toPlayerDist > 1 ? toPlayerDy / toPlayerDist : 0

        // Absorb stream — only for player-collected orbs
        if (orb.consumedBy !== 'enemy') {
          const absR = isHP ? 255 : Math.min(255, orbR + 50)
          const absG = isHP ? 140 : Math.min(255, orbG + 30)
          const absB = isHP ? 140 : Math.min(255, orbB + 30)
          addAbsorbEffect(orb.x, orb.y, absR, absG, absB)
        }

        // Spark explosion — orb-colored burst
        for (let i = 0; i < 18; i++) {
          const angle = (i / 18) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
          const speed = 765 + Math.random() * 425
          spawnParticle(orb.x, orb.y,
            Math.cos(angle) * speed, Math.sin(angle) * speed,
            Math.min(255, orbR + 60), Math.min(255, orbG + 50), Math.min(255, orbB + 50),
            0.15 + Math.random() * 0.1, 2.5 + Math.random() * 2)
        }
        // Hot white core sparks
        for (let i = 0; i < 8; i++) {
          const angle = Math.random() * Math.PI * 2
          const speed = 850 + Math.random() * 425
          spawnParticle(orb.x, orb.y,
            Math.cos(angle) * speed, Math.sin(angle) * speed,
            255, 255, 255, 0.12 + Math.random() * 0.1, 1.5 + Math.random() * 1.5)
        }

        const rippleColor = isHP ? '#E63B3B' : (isDouble ? '#64D732' : '#64FFc8')
        spawnDeathRipples(orb.x, orb.y, r * 1.5, rippleColor)
      }

      ctx.globalAlpha = (1 - t) * (1 - t)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${orbR}, ${orbG}, ${orbB}, 0.5)`
      ctx.fill()
      ctx.globalAlpha = 1
      continue
    }

    const r = orb.radius

    // Check if player ring is over this orb
    const distToPlayer = Math.sqrt((orb.x - player.x) ** 2 + (orb.y - player.y) ** 2)
    const ringOver = playerRadius > 0 && Math.abs(distToPlayer - playerRadius) < r

    // Soft outer glow
    const glowR = r + (isDouble ? 6 : 4)
    const glowGrad = ctx.createRadialGradient(sx, sy, r * 0.5, sx, sy, glowR)
    if (ringOver) {
      glowGrad.addColorStop(0, 'rgba(255, 255, 255, 0.2)')
      glowGrad.addColorStop(1, 'rgba(255, 255, 255, 0)')
    } else {
      glowGrad.addColorStop(0, `rgba(${orbR}, ${orbG}, ${orbB}, ${isDouble ? 0.18 : 0.1})`)
      glowGrad.addColorStop(1, `rgba(${orbR}, ${orbG}, ${orbB}, 0)`)
    }
    ctx.beginPath()
    ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
    ctx.fillStyle = glowGrad
    ctx.fill()

    // Orb body — radial gradient (brighter center in orb color, darker edge)
    const bodyGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
    bodyGrad.addColorStop(0, `rgba(${Math.min(255, orbR + 80)}, ${Math.min(255, orbG + 40)}, ${Math.min(255, orbB + 40)}, 0.75)`)
    bodyGrad.addColorStop(0.6, `rgba(${orbR}, ${orbG}, ${orbB}, 0.6)`)
    bodyGrad.addColorStop(1, `rgba(${orbR}, ${orbG}, ${orbB}, 0.5)`)
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = bodyGrad
    ctx.fill()

    // Edge glow — wider faint stroke underneath
    if (ringOver) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
    } else if (isHP) {
      ctx.strokeStyle = `rgba(255, 100, 200, ${isDouble ? 0.2 : 0.15})`
    } else {
      ctx.strokeStyle = `rgba(0, 230, 255, ${isDouble ? 0.2 : 0.15})`
    }
    ctx.lineWidth = isDouble ? 4 : 3.5
    ctx.stroke()

    // Edge stroke — magenta for HP, cyan for XP
    if (ringOver) {
      ctx.strokeStyle = '#FFFFFF'
    } else if (isHP) {
      ctx.strokeStyle = `rgba(255, 100, 200, ${isDouble ? 0.7 : 0.55})`
    } else {
      ctx.strokeStyle = `rgba(0, 230, 255, ${isDouble ? 0.7 : 0.55})`
    }
    ctx.lineWidth = isDouble ? 1.8 : 1.3
    ctx.stroke()

    // Icon — procedural heart (HP) or plus (XP)
    const heartBeat = player.attackTimer >= 0 ? Math.min(player.attackTimer / (ATTACK_EXPAND_TIME * 0.65), 1) : globalBeatPulse * 1.5
    const orbBeat = Math.min(heartBeat, 1)
    const beatPulse = 1 + orbBeat * (isHP ? 0.4 : 0.15)
    const iconScale = (r / 4.5) * beatPulse  // scale to orb size, breathes with beat
    const iconAlpha = ringOver ? 0.9 : (0.6 + globalBeatPulse * 0.15)
    ctx.fillStyle = `rgba(255, 255, 255, ${iconAlpha})`
    ctx.strokeStyle = `rgba(255, 255, 255, ${iconAlpha})`
    if (isHP) {
      // Heart — single combined path
      const hs = iconScale * 2.2
      const cy = sy - hs * 0.1
      const humpR = hs * 0.45
      const lx = sx - humpR * 0.9  // left hump center
      const rx = sx + humpR * 0.9  // right hump center
      const hy = cy - hs * 0.15    // hump center y
      ctx.beginPath()
      // Start at bottom tip
      ctx.moveTo(sx, cy + hs * 0.85)
      // Left side up to left hump
      ctx.lineTo(lx - humpR, hy)
      // Left hump arc (bottom to top to right)
      ctx.arc(lx, hy, humpR, Math.PI, 0)
      // Right hump arc
      ctx.arc(rx, hy, humpR, Math.PI, 0)
      // Right side down to tip
      ctx.lineTo(sx, cy + hs * 0.85)
      ctx.closePath()
      ctx.fill()
    } else {
      // Plus / cross
      const ps = iconScale * 2.2
      const pw = iconScale * 0.8
      ctx.lineWidth = pw
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(sx, sy - ps)
      ctx.lineTo(sx, sy + ps)
      ctx.moveTo(sx - ps, sy)
      ctx.lineTo(sx + ps, sy)
      ctx.stroke()
      ctx.lineCap = 'butt'
    }
  }
}

function drawPlayer(player: Player): void {
  const baseRadius = getBodyRadius(player)
  let sx = player.x - camX
  let sy = player.y - camY

  // Hit jitter
  if (player.hitFlash > 0) {
    const jitter = 6 * (player.hitFlash / HIT_FLASH_DURATION)
    sx += (Math.random() - 0.5) * 2 * jitter
    sy += (Math.random() - 0.5) * 2 * jitter
  }

  // Glow aura — soft radial gradient behind player, pulses on beat
  {
    const beatPulse = globalBeatPulse
    const glowRadius = baseRadius * (2.5 + beatPulse * 0.8)
    const glowAlpha = 0.18 + beatPulse * 0.22
    const grad = ctx.createRadialGradient(sx, sy, baseRadius * 0.3, sx, sy, glowRadius)
    grad.addColorStop(0, `rgba(79, 195, 247, ${glowAlpha})`)
    grad.addColorStop(0.4, `rgba(79, 195, 247, ${glowAlpha * 0.4})`)
    grad.addColorStop(1, 'rgba(79, 195, 247, 0)')
    ctx.beginPath()
    ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
  }

  // Movement trail — clipped to arena
  ctx.save()
  const trailShape = getArenaShape()
  if (trailShape === 'cross') {
    ctx.beginPath()
    ctx.rect(ARENA_CX - CROSS_HE - camX, ARENA_CY - CROSS_HE - camY, CROSS_HE * 2, CROSS_HE * 2)
  } else if (trailShape === 'pill') {
    ctx.beginPath()
    ctx.rect(ARENA_CX - PILL_HALF_W - PILL_R - camX, ARENA_CY - PILL_R - camY, (PILL_HALF_W + PILL_R) * 2, PILL_R * 2)
  } else if (trailShape === 'hex') {
    hexPath(ARENA_CX - camX, ARENA_CY - camY, ARENA_RADIUS)
  } else if (trailShape === 'circle') {
    ctx.beginPath()
    ctx.arc(ARENA_CX - camX, ARENA_CY - camY, ARENA_RADIUS, 0, Math.PI * 2)
  } else {
    ctx.beginPath()
    ctx.rect(-camX, -camY, ARENA_W, ARENA_H)
  }
  ctx.clip()
  const shielded = player.shieldCharges > 0
  for (let i = 0; i < player.trail.length; i++) {
    const t = player.trail[i]!
    const tx = t.x - camX
    const ty = t.y - camY
    const frac = i / player.trail.length
    const alpha = frac * (shielded ? 0.18 : 0.12)
    ctx.beginPath()
    ctx.arc(tx, ty, baseRadius * (0.5 + 0.5 * frac), 0, Math.PI * 2)
    ctx.fillStyle = shielded ? `rgba(255, 80, 220, ${alpha})` : `rgba(79, 195, 247, ${alpha})`
    ctx.fill()
  }
  ctx.restore()

  // Ghost dash — semi-transparent + white shimmer
  const isGhostDashing = player.dashTimer >= 0 && hasBonus('ghostDash')
  if (isGhostDashing) {
    ctx.globalAlpha = 0.4 + Math.sin(performance.now() / 50) * 0.15
  }

  // Hit shrink + color fade
  let drawRadius = baseRadius
  let fillColor = isGhostDashing ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 255, 255, 0.22)'
  let strokeColor = isGhostDashing ? '#FFFFFF' : COLOR_PLAYER
  if (player.hitFlash > 0) {
    const t = player.hitFlash / HIT_FLASH_DURATION // 1 = just hit, 0 = recovered
    drawRadius = baseRadius * (0.7 + 0.3 * (1 - t)) // shrinks to 70% then bounces back
    fillColor = `rgba(255, ${Math.floor(30 + 225 * (1 - t))}, ${Math.floor(30 + 217 * (1 - t))}, ${0.2 + 0.5 * t})`
    strokeColor = `rgb(255, ${Math.floor(30 + 225 * (1 - t))}, ${Math.floor(30 + 217 * (1 - t))})`
  }

  // Dash afterimages — follow curved dash path (use sweep path if captured, else live path)
  const afterimagePath = dashSweepIntensity > 0.5 && dashSweepPath.length > 1 ? dashSweepPath : player.dashPath
  if (player.dashTimer >= 0 && afterimagePath.length > 1) {
    const fade = player.dashTimer / player.dashDuration
    if (fade > 0) {
      const pathLen = afterimagePath.length
      const count = Math.min(7, pathLen - 1)
      for (let i = 1; i <= count; i++) {
        const idx = pathLen - 1 - Math.floor(i * pathLen / (count + 1))
        if (idx < 0) continue
        const pt = afterimagePath[idx]!
        const ax = pt.x - camX
        const ay = pt.y - camY
        const t = i / (count + 1)
        const aScale = 1 - t * 0.3
        const aRadius = drawRadius * aScale
        const aFade = fade * (1 - t * 0.6)

        ctx.beginPath()
        ctx.arc(ax, ay, aRadius, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(79, 195, 247, ${0.2 * aFade})`
        ctx.fill()

        ctx.beginPath()
        ctx.arc(ax, ay, aRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(79, 195, 247, ${0.4 * aFade})`
        ctx.lineWidth = 2 * aScale
        ctx.stroke()
      }
    }
  }

  // HP fractions — needed by both blood particles and pie chart
  const hpFraction = player.displayHp / player.maxHp
  const actualPlayerHp = player.hp / player.maxHp
  const hpStart = -Math.PI / 2
  const hpEnd = hpStart + hpFraction * Math.PI * 2

  // Hit particles — burst from inside the damage wedge
  if (player.hitFlash > HIT_FLASH_DURATION - 0.02 && player.shieldBreakFlash <= 0) {
    const dmgFraction = 1 / player.maxHp
    const intensity = Math.min(Math.max(dmgFraction / 0.05, 1), 3)
    const count = Math.floor(16 * intensity)
    // Damage arc: from current HP to where displayHp was (the fresh bite)
    const dmgArcStart = hpStart + actualPlayerHp * Math.PI * 2
    const dmgArcEnd = dmgArcStart + dmgFraction * Math.PI * 2
    const arcSpan = dmgArcEnd - dmgArcStart
    for (let i = 0; i < count; i++) {
      const angle = dmgArcStart + Math.random() * arcSpan
      const dist = Math.random() * drawRadius
      const px = player.x + Math.cos(angle) * dist
      const py = player.y + Math.sin(angle) * dist
      const speed = (228 + Math.random() * 325) * (0.8 + intensity * 0.2)
      const outAngle = Math.atan2(py - player.y, px - player.x)
      const spread = (Math.random() - 0.5) * speed * 0.25
      const size = (3 + Math.random() * 3) * (0.8 + intensity * 0.2)
      const isBlue = Math.random() < 0.2
      spawnParticle(px, py,
        Math.cos(outAngle) * speed + spread, Math.sin(outAngle) * speed + spread,
        isBlue ? 79 : 255, isBlue ? 195 : 80 + Math.floor(Math.random() * 50), isBlue ? 247 : 70,
        0.55 + Math.random() * 0.35, size)
    }
    // Extra center spray — white-hot core burst
    for (let i = 0; i < 6; i++) {
      const angle = dmgArcStart + Math.random() * arcSpan
      const speed = 98 + Math.random() * 195
      spawnParticle(player.x, player.y,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        255, 200 + Math.floor(Math.random() * 55), 180, 0.3 + Math.random() * 0.2, 3 + Math.random() * 2)
    }
  }

  // HP pie chart

  // Background — gradient
  {
    const pbgGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
    pbgGrad.addColorStop(0, 'rgba(0, 0, 0, 0.25)')
    pbgGrad.addColorStop(1, 'rgba(0, 0, 0, 0.5)')
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
    ctx.fillStyle = pbgGrad
    ctx.fill()
  }

  if (hpFraction > 0) {
    // Red draining wedge
    if (hpFraction > actualPlayerHp) {
      const actualEnd = hpStart + actualPlayerHp * Math.PI * 2
      const redGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      redGrad.addColorStop(0, 'rgba(255, 70, 70, 0.55)')
      redGrad.addColorStop(0.7, 'rgba(255, 40, 40, 0.4)')
      redGrad.addColorStop(1, 'rgba(140, 20, 20, 0.3)')
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, actualEnd, hpEnd)
      ctx.closePath()
      ctx.fillStyle = redGrad
      ctx.fill()
    }

    // Main HP fill — use displayHp for smooth fill animation
    const fillFraction = Math.min(hpFraction, actualPlayerHp)
    const mainEnd = hpStart + fillFraction * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
    ctx.closePath()
    ctx.fillStyle = fillColor
    ctx.fill()

    // Heal juice — glowing leading edge + particles when filling
    const healGap = actualPlayerHp - hpFraction
    if (healGap > 0.01) {
      const tipAngle = mainEnd
      const tipX = sx + Math.cos(tipAngle) * drawRadius * 0.7
      const tipY = sy + Math.sin(tipAngle) * drawRadius * 0.7
      // Leading edge glow
      const glowR = drawRadius * 0.5
      const healGlow = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, glowR)
      healGlow.addColorStop(0, 'rgba(100, 255, 160, 0.45)')
      healGlow.addColorStop(1, 'rgba(100, 255, 160, 0)')
      ctx.beginPath()
      ctx.arc(tipX, tipY, glowR, 0, Math.PI * 2)
      ctx.fillStyle = healGlow
      ctx.fill()
      // Bright tip dot
      const edgeX = sx + Math.cos(tipAngle) * drawRadius
      const edgeY = sy + Math.sin(tipAngle) * drawRadius
      ctx.beginPath()
      ctx.arc(edgeX, edgeY, 4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(150, 255, 200, 0.9)'
      ctx.fill()
      // Outer glow on tip
      ctx.beginPath()
      ctx.arc(edgeX, edgeY, 8, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(100, 255, 160, 0.15)'
      ctx.fill()
      // Heal particles — spawn from the tip
      for (let hp = 0; hp < 2; hp++) {
        if (Math.random() < 0.4) {
          const pAngle = tipAngle + (Math.random() - 0.5) * 0.8
          const pDist = drawRadius * (0.6 + Math.random() * 0.4)
          const speed = 25 + Math.random() * 40
          spawnParticle(
            player.x + Math.cos(pAngle) * pDist,
            player.y + Math.sin(pAngle) * pDist,
            Math.cos(pAngle) * speed, Math.sin(pAngle) * speed,
            100, 255, 160, 0.2 + Math.random() * 0.15, 3.5 + Math.random() * 3)
        }
      }
    }

    // HP segment lines — only on remaining health
    if (player.maxHp <= 40) {
      const segStart = player.hp < player.maxHp ? 1 : 0
      const now = performance.now()
      const segBeat = player.attackTimer >= 0 && player.attackTimer < ATTACK_EXPAND_TIME
        ? Math.min(player.attackTimer / (ATTACK_EXPAND_TIME * 0.80), 0.6)
        : globalBeatPulse
      const segInner = drawRadius * (0.60 - segBeat * 0.30)
      for (let i = segStart; i < player.hp; i++) {
        const phase = (i / player.maxHp) * Math.PI * 2
        const wave = 0.5 + 0.5 * Math.sin(now / 800 - phase * 1.5)
        const segAlpha = 0.12 + wave * 0.18
        const segAngle = hpStart + (i / player.maxHp) * Math.PI * 2
        const ix = sx + Math.cos(segAngle) * segInner
        const iy = sy + Math.sin(segAngle) * segInner
        const ox = sx + Math.cos(segAngle) * drawRadius
        const oy = sy + Math.sin(segAngle) * drawRadius
        // Glow layer — soft white-cyan
        ctx.beginPath()
        ctx.moveTo(ix, iy)
        ctx.lineTo(ox, oy)
        ctx.strokeStyle = `rgba(180, 230, 255, ${segAlpha * 0.6})`
        ctx.lineWidth = 4
        ctx.stroke()
        // Core line — bright white-pink
        ctx.beginPath()
        ctx.moveTo(ix, iy)
        ctx.lineTo(ox, oy)
        ctx.strokeStyle = `rgba(230, 210, 255, ${segAlpha + 0.12})`
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }
  }

  // ── Shield on body stroke ──
  if (player.shieldCharges > 0) {
    // Shielded — pulsing energy field
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300)
    const fastPulse = 0.5 + 0.5 * Math.sin(performance.now() / 120)
    // Activation flash — bright white-pink flare that fades quickly
    const activFlash = shieldRestoreAnim > 0 ? Math.min(shieldRestoreAnim / 0.12, 1) : 0
    if (activFlash > 0) {
      ctx.beginPath()
      ctx.arc(sx, sy, drawRadius + 1, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 220, 255, ${activFlash * 0.4})`
      ctx.lineWidth = 4 + activFlash * 2
      ctx.stroke()
    }

    // Core energy ring
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 50, 200, ${0.85 + fastPulse * 0.15})`
    ctx.lineWidth = 2.5 + pulse * 0.5
    ctx.stroke()

    // Hot inner edge
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius - 0.5, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 180, 240, ${0.25 + fastPulse * 0.15})`
    ctx.lineWidth = 1
    ctx.stroke()


    // Ambient shield sparks — constant stream around circumference
    const sparkCount = globalBeatPulse > 0.5 ? 5 : 2
    for (let s = 0; s < sparkCount; s++) {
      if (Math.random() < 0.7) {
        const sparkAngle = Math.random() * Math.PI * 2
        const outAngle = sparkAngle + (Math.random() - 0.5) * 1.2
        const speed = 50 + Math.random() * 80
        spawnParticle(
          player.x + Math.cos(sparkAngle) * drawRadius,
          player.y + Math.sin(sparkAngle) * drawRadius,
          Math.cos(outAngle) * speed, Math.sin(outAngle) * speed,
          255, 100 + Math.floor(Math.random() * 100), 220,
          0.14 + Math.random() * 0.1, 2.5 + Math.random() * 1.5)
      }
    }
  } else if (player.shieldRechargeTimer > 0) {
    // Recharging — normal stroke underneath, purple arc filling on top
    const progress = 1 - (player.shieldRechargeTimer / player.shieldRechargeTime)

    // Smooth display progress — snaps forward, retreats fast on hit
    if (progress > shieldDisplayProgress) {
      shieldDisplayProgress += (progress - shieldDisplayProgress) * 12 * frameDt
      if (progress - shieldDisplayProgress < 0.005) shieldDisplayProgress = progress
    } else {
      shieldDisplayProgress -= (shieldDisplayProgress - progress) * 8 * frameDt
      if (shieldDisplayProgress - progress < 0.005) shieldDisplayProgress = progress
    }

    // Base stroke (normal)
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 2.5
    ctx.stroke()

    // Magenta progress arc clockwise from top — pulses throughout, intensifies near end
    const visProgress = Math.max(0, shieldDisplayProgress)
    if (visProgress > 0) {
      const eighthNote = BEAT_SEC * 500  // 8th note period in ms
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * Math.PI * 2 / eighthNote)
      const nearEnd = visProgress > 0.5 ? (visProgress - 0.5) / 0.5 : 0
      const flash = pulse * (0.5 + nearEnd * 0.5)
      ctx.beginPath()
      ctx.arc(sx, sy, drawRadius, -Math.PI / 2, -Math.PI / 2 + visProgress * Math.PI * 2)
      const r = 255
      const g = Math.round(50 + flash * 150)
      const b = Math.round(200 + flash * 40)

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.6 + progress * 0.35 + flash * 0.05})`
      ctx.lineWidth = 3 + flash + progress * 1.5
      ctx.stroke()

      // Outer glow that grows with progress
      if (progress > 0.2) {
        ctx.beginPath()
        ctx.arc(sx, sy, drawRadius + 1, -Math.PI / 2, -Math.PI / 2 + visProgress * Math.PI * 2)
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${progress * 0.2})`
        ctx.lineWidth = 3 + progress * 3
        ctx.stroke()
      }

      // Leading tip glow + sparks
      const tipAngle = -Math.PI / 2 + visProgress * Math.PI * 2
      const tipX = sx + Math.cos(tipAngle) * drawRadius
      const tipY = sy + Math.sin(tipAngle) * drawRadius

      // Tip glow — grows with progress
      const tipGlowR = 4 + progress * 10
      ctx.beginPath()
      ctx.arc(tipX, tipY, tipGlowR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 150, 230, ${0.2 + progress * 0.4})`
      ctx.fill()

      // Sparks from the tip — more and bigger as it progresses
      const sparkCount = Math.floor(1 + progress * 3)
      for (let s = 0; s < sparkCount; s++) {
        if (Math.random() < 0.25 + visProgress * 0.5) {
          const sparkAngle = tipAngle + (Math.random() - 0.5) * 1.5
          const speed = (50 + Math.random() * 90) * (1 + progress * 0.5)
          const sparkSize = (5 + Math.random() * 3) * (1 + progress * 0.8)
          spawnParticle(
            player.x + Math.cos(tipAngle) * drawRadius,
            player.y + Math.sin(tipAngle) * drawRadius,
            Math.cos(sparkAngle) * speed, Math.sin(sparkAngle) * speed,
            255, 100 + Math.floor(Math.random() * 100), 220,
            0.2 + Math.random() * 0.12, sparkSize)
        }
      }
    }
  } else {
    // No shield, not recharging — normal stroke
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 2.5
    ctx.stroke()
  }

  // Missing HP glow — inside the empty pie section
  if (actualPlayerHp < 1 && actualPlayerHp > 0) {
    const missingStart = hpStart + actualPlayerHp * Math.PI * 2
    const missingEnd = hpStart + Math.PI * 2
    const hpBeat = player.attackTimer >= 0 && player.attackTimer < ATTACK_EXPAND_TIME
      ? Math.min(player.attackTimer / (ATTACK_EXPAND_TIME * 0.35), 1)
      : globalBeatPulse * 1.5
    const missPulse = 0.5 + Math.min(hpBeat, 1) * 0.5

    // Inner glow fill along the missing wedge
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, drawRadius, missingStart, missingEnd)
    ctx.closePath()
    ctx.clip()
    // Radial glow from edge inward — pulses hard with beat, grows inward on beat
    const glowInner = drawRadius * (0.2 - missPulse * 0.2)
    const glowGrad = ctx.createRadialGradient(sx, sy, glowInner, sx, sy, drawRadius)
    glowGrad.addColorStop(0, 'rgba(255, 50, 50, 0)')
    glowGrad.addColorStop(0.4, `rgba(255, 50, 50, ${0.1 * missPulse})`)
    glowGrad.addColorStop(0.7, `rgba(255, 50, 50, ${0.25 * missPulse})`)
    glowGrad.addColorStop(1, `rgba(255, 50, 50, ${0.5 * missPulse})`)
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
    ctx.fillStyle = glowGrad
    ctx.fill()

    // Glow bleed along the pie edges (same color as radial glow)
    for (const edgeAngle of [missingStart, missingEnd]) {
      const edgeGrad = ctx.createLinearGradient(
        sx, sy,
        sx + Math.cos(edgeAngle) * drawRadius,
        sy + Math.sin(edgeAngle) * drawRadius
      )
      edgeGrad.addColorStop(0, `rgba(255, 50, 50, ${0.01 * missPulse})`)
      edgeGrad.addColorStop(1, `rgba(255, 50, 50, ${0.2 * missPulse})`)
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(
        sx + Math.cos(edgeAngle) * drawRadius,
        sy + Math.sin(edgeAngle) * drawRadius
      )
      ctx.strokeStyle = edgeGrad
      ctx.lineWidth = 6
      ctx.stroke()
    }
    ctx.restore()
  }

  // Shield break particles — explosive burst from body edge
  if (player.shieldBreakFlash > SHIELD_BREAK_FLASH - 0.02 && player.shieldBreakFlash <= SHIELD_BREAK_FLASH) {
    // Main pink shard burst — wide spread
    for (let i = 0; i < 50; i++) {
      const angle = (i / 50) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
      const px = player.x + Math.cos(angle) * drawRadius
      const py = player.y + Math.sin(angle) * drawRadius
      const speed = 500 + Math.random() * 400
      spawnParticle(px, py,
        Math.cos(angle) * speed + (Math.random() - 0.5) * 120,
        Math.sin(angle) * speed + (Math.random() - 0.5) * 120,
        255, 50 + Math.floor(Math.random() * 60), 200,
        0.4 + Math.random() * 0.25, 6 + Math.random() * 7)
    }
    // Hot white core sparks — fast, far
    for (let i = 0; i < 20; i++) {
      const angle = Math.random() * Math.PI * 2
      const px = player.x + Math.cos(angle) * drawRadius * 0.5
      const py = player.y + Math.sin(angle) * drawRadius * 0.5
      const speed = 600 + Math.random() * 400
      spawnParticle(px, py,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        255, 220, 255, 0.35 + Math.random() * 0.2, 4 + Math.random() * 3)
    }
    // Slow drifting embers — linger after the burst
    for (let i = 0; i < 15; i++) {
      const angle = Math.random() * Math.PI * 2
      const dist = drawRadius * (0.5 + Math.random() * 0.5)
      const speed = 30 + Math.random() * 60
      spawnParticle(
        player.x + Math.cos(angle) * dist,
        player.y + Math.sin(angle) * dist,
        Math.cos(angle) * speed + (Math.random() - 0.5) * 20,
        Math.sin(angle) * speed - 20 - Math.random() * 30,
        255, 100, 220, 0.5 + Math.random() * 0.3, 3 + Math.random() * 3)
    }
  }

  // Shield break shockwave — expanding ring over the flash duration
  if (player.shieldBreakFlash > 0) {
    const bt = player.shieldBreakFlash / SHIELD_BREAK_FLASH  // 1→0
    const shockR = drawRadius + (1 - bt) * 120
    ctx.beginPath()
    ctx.arc(sx, sy, shockR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 80, 220, ${bt * bt * 0.6})`
    ctx.lineWidth = 5 * bt + 1
    ctx.stroke()
    // Second inner ring
    const innerR = drawRadius + (1 - bt) * 50
    ctx.beginPath()
    ctx.arc(sx, sy, innerR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 200, 255, ${bt * 0.4})`
    ctx.lineWidth = 3 * bt
    ctx.stroke()
    // Center flash
    if (bt > 0.7) {
      ctx.beginPath()
      ctx.arc(sx, sy, drawRadius + 2, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 150, 240, ${(bt - 0.7) * 2})`
      ctx.fill()
    }
  }

  // Shield restore — detect trigger
  if (prevShieldCharges === 0 && player.shieldCharges > 0) {
    shieldRestoreAnim = 0.47
  }
  prevShieldCharges = player.shieldCharges

  // Shield restore — spiral converge + impact shockwave
  if (shieldRestoreAnim > 0) {
    shieldRestoreAnim -= frameDt
    const totalDur = 0.47
    const convergeDur = 0.28  // spiral phase
    const shockDur = 0.19     // shockwave phase
    const elapsed = totalDur - shieldRestoreAnim

    if (elapsed < convergeDur) {
      // Phase 1: spiral inward
      const t = elapsed / convergeDur  // 0→1
      const outerR = drawRadius + 136
      const currentR = outerR * (1 - t * t * t)  // cubic ease
      const spiralRot = t * Math.PI * 3  // 3 full rotations
      const alpha = 0.5 + t * 0.5
      const count = 12
      for (let i = 0; i < count; i++) {
        const baseAngle = (i / count) * Math.PI * 2
        const angle = baseAngle + spiralRot
        const dx = Math.cos(angle) * currentR
        const dy = Math.sin(angle) * currentR
        const size = 4.5 + t * t * 12
        const white = 1 - t
        const cr = 255
        const cg = Math.round(200 * white + 50 * (1 - white))
        const cb = Math.round(255 * white + 200 * (1 - white))
        ctx.beginPath()
        ctx.arc(sx + dx, sy + dy, size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`
        ctx.fill()

        // Trailing sparks behind each dot
        if (Math.random() < 0.5 + t * 0.5) {
          const trailAngle = angle + Math.PI + (Math.random() - 0.5) * 0.8
          const trailSpeed = 20 + Math.random() * 40
          spawnParticle(
            player.x + dx, player.y + dy,
            Math.cos(trailAngle) * trailSpeed, Math.sin(trailAngle) * trailSpeed,
            cr, cg, cb, 0.15 + Math.random() * 0.1, 3 + Math.random() * 3)
        }
      }
    } else {
      // Phase 2: impact shockwave
      const shockT = (elapsed - convergeDur) / shockDur  // 0→1
      const shockR = drawRadius + shockT * 45
      const shockAlpha = (1 - shockT)

      // Expanding shockwave ring
      ctx.beginPath()
      ctx.arc(sx, sy, shockR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 150, 230, ${shockAlpha * 0.6})`
      ctx.lineWidth = 4 * (1 - shockT) + 1
      ctx.stroke()

      // Second tighter ring
      const innerShockR = drawRadius + shockT * 20
      ctx.beginPath()
      ctx.arc(sx, sy, innerShockR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 220, 255, ${shockAlpha * 0.5})`
      ctx.lineWidth = 2 * (1 - shockT)
      ctx.stroke()

      // Full body flash
      ctx.beginPath()
      ctx.arc(sx, sy, drawRadius + 1, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 180, 240, ${shockAlpha * 0.2})`
      ctx.fill()

      // Impact sparks burst
      if (shockT < 0.12) {
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
          const speed = 80 + Math.random() * 120
          spawnParticle(
            player.x + Math.cos(a) * drawRadius,
            player.y + Math.sin(a) * drawRadius,
            Math.cos(a) * speed, Math.sin(a) * speed,
            255, 120 + Math.floor(Math.random() * 100), 230,
            0.15 + Math.random() * 0.1, 6 + Math.random() * 4.5)
        }
      }
    }
  }

  // Beat anticipation — 10 chained rings shrinking toward player body
  if (player.attackTimer >= 0 && player.attackTimer < ATTACK_EXPAND_TIME) {
    const buildup = player.attackTimer / ATTACK_EXPAND_TIME  // 0→1
    for (let i = 0; i < 10; i++) {
      const offset = i * 0.06  // stagger each ring
      const t = Math.min(1, buildup + offset)
      const anticipateR = drawRadius + (MAX_RING_RADIUS * 0.4) * (1 - t * t)
      const anticipateAlpha = (0.02 + t * 0.06) * (1 - i * 0.09)  // trailing rings dimmer
      const anticipateWidth = 0.8 + t * 0.4
      ctx.beginPath()
      ctx.arc(sx, sy, anticipateR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(79, 195, 247, ${anticipateAlpha})`
      ctx.lineWidth = anticipateWidth
      ctx.stroke()
    }
  }

  // Beat ripple — ring of light expanding from body on attack fire
  if (player.attackTimer >= 0 && player.attackTimer < 0.15) {
    const rippleT = player.attackTimer / 0.15
    const rippleR = drawRadius + rippleT * drawRadius * 0.35
    const rippleAlpha = 0.3 * (1 - rippleT)
    ctx.beginPath()
    ctx.arc(sx, sy, rippleR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(79, 195, 247, ${rippleAlpha})`
    ctx.lineWidth = 2 * (1 - rippleT)
    ctx.stroke()
  }

  // Dash charges
  const orbitR = drawRadius
  const orbitSpeed = performance.now() / 800

  for (let i = 0; i < player.dashSlots.length; i++) {
    const baseAngle = orbitSpeed + (Math.PI * 2 * i) / player.dashSlots.length
    const dotX = sx + Math.cos(baseAngle) * orbitR
    const dotY = sy + Math.sin(baseAngle) * orbitR
    const timer = player.dashSlots[i]!
    const prevTimer = prevDashSlots[i] ?? 0

    // Dash charge just consumed — green particle explosion
    if (timer > 0 && prevTimer <= 0) {
      const worldX = player.x + Math.cos(baseAngle) * orbitR
      const worldY = player.y + Math.sin(baseAngle) * orbitR
      for (let p = 0; p < 30; p++) {
        const a = (p / 30) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
        const speed = 250 + Math.random() * 250
        spawnParticle(worldX, worldY,
          Math.cos(a) * speed, Math.sin(a) * speed,
          100, 255, 120, 0.25 + Math.random() * 0.15, 3 + Math.random() * 2.5)
      }
    }

    if (timer <= 0) {
      // Ready — green dot
      ctx.beginPath()
      ctx.arc(dotX, dotY, 5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(100, 255, 120, 0.95)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(dotX, dotY, 10, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(100, 255, 120, 0.25)'
      ctx.fill()
    } else {
      // Charging — white pie in place
      const fill = 1 - (timer / (player.dashChargeTime * player.modifiers.dashChargeMult))
      ctx.beginPath()
      ctx.arc(dotX, dotY, 5.2, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
      ctx.fill()
      if (fill > 0) {
        ctx.beginPath()
        ctx.moveTo(dotX, dotY)
        ctx.arc(dotX, dotY, 5.2, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2)
        ctx.closePath()
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
        ctx.fill()
      }
    }
  }
  prevDashSlots = player.dashSlots.map(t => t)

  // Green dash particles — trail behind during entire dash
  if (player.dashTimer >= 0 && player.dashTimer > 0) {
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2
      const px = player.x + Math.cos(a) * orbitR * (0.5 + Math.random() * 0.5)
      const py = player.y + Math.sin(a) * orbitR * (0.5 + Math.random() * 0.5)
      spawnParticle(px, py,
        -player.dashDirX * 30 + (Math.random() - 0.5) * 20,
        -player.dashDirY * 30 + (Math.random() - 0.5) * 20,
        100, 255, 120, 0.4, 3.5)
    }
  }

  // Cyan dash trail burst
  if (player.dashTimer >= 0 && player.dashTimer > 0.48) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2
      const px = player.x + Math.cos(a) * orbitR
      const py = player.y + Math.sin(a) * orbitR
      const speed = 60 + Math.random() * 80
      spawnParticle(px, py, Math.cos(a) * speed, Math.sin(a) * speed, 79, 195, 247, 0.3, 5)
    }
  }

  // Beat indicator
  const beatGlow = player.ring.phase > 0.8 ? (player.ring.phase - 0.8) / 0.2 : 0
  if (beatGlow > 0) {
    ctx.beginPath()
    ctx.arc(sx, sy + baseRadius + 10, 3, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${beatGlow})`
    ctx.fill()
  }

  // Reset ghost dash alpha
  if (isGhostDashing) {
    ctx.globalAlpha = 1
  }
}

function drawEnemy(enemy: Enemy, player: Player): void {
  let sx = enemy.x - camX
  let sy = enemy.y - camY
  let r = enemy.radius

  // Hit jitter — random position offset while flash is active
  if (enemy.hitFlash > 0) {
    const jitterStrength = 6 * (enemy.hitFlash / HIT_FLASH_DURATION)
    sx += (Math.random() - 0.5) * 2 * jitterStrength
    sy += (Math.random() - 0.5) * 2 * jitterStrength
  }

  // Death animation
  if (enemy.dying) {
    const dt = enemy.deathTimer
    const deathDur = 0.3
    const t = Math.min(dt / deathDur, 1)

    const hr = enemy.cr, hg = enemy.cg, hb = enemy.cb

    // Death ripples + red hit particles on first frame
    if (dt < 0.02) {
      spawnDeathRipples(enemy.x, enemy.y, r, enemy.color)
    }
    if (dt < 0.02) {
      for (let i = 0; i < 10; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = r * Math.random() * 0.5
        const px = enemy.x + Math.cos(angle) * dist
        const py = enemy.y + Math.sin(angle) * dist
        const speed = 300 + Math.random() * 350
        spawnParticle(px, py, Math.cos(angle) * speed, Math.sin(angle) * speed,
          255, 80 + Math.floor(Math.random() * 50), 70, 0.25 + Math.random() * 0.15, 5 + Math.random() * 3)
      }
    }

    if (dt < deathDur) {
      const count = t < 0.1 ? 15 : 4
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = Math.random() * r
        const px = enemy.x + Math.cos(angle) * dist
        const py = enemy.y + Math.sin(angle) * dist
        const speed = 200 + Math.random() * 300
        const vx = Math.cos(angle) * speed + (Math.random() - 0.5) * 60
        const vy = Math.sin(angle) * speed + (Math.random() - 0.5) * 60 - 20
        const isWhite = Math.random() < 0.3
        spawnParticle(px, py, vx, vy,
          isWhite ? 255 : hr, isWhite ? 255 : hg, isWhite ? 255 : hb,
          0.3 + Math.random() * 0.3, 3 + Math.random() * 3)
      }
    }

    if (r > 1) {
      const dr = r * (1 - t * 0.5)
      const deathAlpha = (1 - t) * (1 - t)
      ctx.globalAlpha = deathAlpha

      // Dark background — gradient
      const dbgGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, dr)
      dbgGrad.addColorStop(0, 'rgba(0, 0, 0, 0.3)')
      dbgGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)')
      ctx.beginPath()
      ctx.arc(sx, sy, dr, 0, Math.PI * 2)
      ctx.fillStyle = dbgGrad
      ctx.fill()

      // Red drain wedge — displayHp is still draining toward 0
      const drainFraction = enemy.displayHp / enemy.maxHp
      if (drainFraction > 0) {
        const drainStart = -Math.PI / 2
        const drainEnd = drainStart + drainFraction * Math.PI * 2
        const dRedGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, dr)
        dRedGrad.addColorStop(0, 'rgba(255, 70, 70, 0.55)')
        dRedGrad.addColorStop(0.7, 'rgba(255, 40, 40, 0.4)')
        dRedGrad.addColorStop(1, 'rgba(140, 20, 20, 0.3)')
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.arc(sx, sy, dr, drainStart, drainEnd)
        ctx.closePath()
        ctx.fillStyle = dRedGrad
        ctx.fill()
      }

      ctx.beginPath()
      ctx.arc(sx, sy, dr, 0, Math.PI * 2)
      ctx.strokeStyle = enemy.color
      ctx.lineWidth = 1.5 * (1 - t)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    return
  }

  // Check if player ring is over this enemy
  const playerRadius = player.attackTimer >= 0 ? getEffectiveRadius(player) * getRingExpansion(player.attackTimer) : 0
  const distToPlayer = Math.sqrt((enemy.x - player.x) ** 2 + (enemy.y - player.y) ** 2)
  const ringOverEnemy = !enemy.summon && playerRadius > 0 && Math.abs(distToPlayer - playerRadius) < r

  const hr = enemy.cr, hg = enemy.cg, hb = enemy.cb
  const isTotem = enemy.totemSpawn !== ''

  const hpFraction = enemy.displayHp / enemy.maxHp
  const damageFraction = player.damage * player.modifiers.damageMult / enemy.maxHp
  const afterHitFraction = Math.max(0, hpFraction - damageFraction)
  const startAngle = -Math.PI / 2
  const endAngle = startAngle + hpFraction * Math.PI * 2
  const afterHitEnd = startAngle + afterHitFraction * Math.PI * 2

  // White flash on hit — drawn under pie so blood/drain show on top
  if (enemy.hitFlash > 0) {
    const flashT = enemy.hitFlash / HIT_FLASH_DURATION
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${0.95 * flashT})`
    ctx.fill()
  }

  // Background — solid fill
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  if (isTotem) {
    ctx.fillStyle = 'rgba(15, 15, 20, 0.75)'  // neutral dark, heavier
  } else {
    ctx.fillStyle = `rgba(${Math.floor(hr * 0.08)}, ${Math.floor(hg * 0.08)}, ${Math.floor(hb * 0.08)}, 0.55)`
  }
  ctx.fill()

  // Hit particles — burst from the pie edge, intensity scales with damage fraction + enemy size
  if (enemy.hitFlash > HIT_FLASH_DURATION - 0.02) {
    const hitFraction = damageFraction  // fraction of maxHp dealt
    const dmgIntensity = Math.min(Math.max(hitFraction / 0.20, 1), 4)  // 1x at <=20%, up to 4x at 80%+
    const sizeBonus = Math.min(r / 44, 3)  // bigger enemies = more blood (up to 3x)
    const intensity = Math.max(dmgIntensity, sizeBonus)
    const count = Math.floor(12 * intensity)
    // Only the fresh bite — from actual HP to where displayHp is (the red drain wedge)
    const damageArcStart = startAngle + (enemy.hp / enemy.maxHp) * Math.PI * 2
    const damageArcEnd = damageArcStart + damageFraction * Math.PI * 2
    const arcSpan = damageArcEnd - damageArcStart
    for (let i = 0; i < count; i++) {
      const angle = damageArcStart + Math.random() * arcSpan
      const dist = Math.random() * r
      const px = enemy.x + Math.cos(angle) * dist
      const py = enemy.y + Math.sin(angle) * dist
      const speed = (228 + Math.random() * 358) * (0.8 + intensity * 0.2)
      const outAngle = Math.atan2(py - enemy.y, px - enemy.x)
      const vx = Math.cos(outAngle) * speed + (Math.random() - 0.5) * speed * 0.2
      const vy = Math.sin(outAngle) * speed + (Math.random() - 0.5) * speed * 0.2
      const sizeScale = Math.min(r / 44, 1)
      const size = (4 + Math.random() * 4) * (0.8 + intensity * 0.2) * sizeScale * sizeScale
      spawnParticle(px, py, vx, vy, 255, 80 + Math.floor(Math.random() * 50), 70, 0.5 + Math.random() * 0.35, size)
    }
    // Blood spray from center — enemy colored
    const sprayCount = Math.floor(6 * intensity)
    for (let i = 0; i < sprayCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 98 + Math.random() * 211 * intensity
      const sizeScale2 = Math.min(r / 44, 1)
      const size = (3.5 + Math.random() * 4) * (0.8 + intensity * 0.2) * sizeScale2 * sizeScale2
      spawnParticle(enemy.x, enemy.y,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        230 + Math.floor(Math.random() * 25), 40 + Math.floor(Math.random() * 40), 40, 0.5 + Math.random() * 0.35, size)
    }
  }

  const actualHpFraction = enemy.hp / enemy.maxHp

  if (enemy.summon) {
    // Phase pie — shows remaining phases like HP, bites on each spawn
    const totalPhases = enemy.summonPhases.length
    if (totalPhases > 0) {
      const phasesRemaining = totalPhases - enemy.summonCurrentPhase
      const phaseFrac = phasesRemaining / totalPhases

      // Dark background
      const sbgGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
      sbgGrad.addColorStop(0, `rgba(${Math.floor(hr * 0.08)}, ${Math.floor(hg * 0.08)}, ${Math.floor(hb * 0.08)}, 0.55)`)
      sbgGrad.addColorStop(1, 'rgba(0, 0, 0, 0.4)')
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = sbgGrad
      ctx.fill()

      // Filled phase wedge
      if (phaseFrac > 0) {
        const phaseEnd = startAngle + phaseFrac * Math.PI * 2
        const phaseGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
        phaseGrad.addColorStop(0, `rgba(${Math.min(255, hr + 80)}, ${Math.min(255, hg + 40)}, ${Math.min(255, hb + 40)}, 0.7)`)
        phaseGrad.addColorStop(0.7, `rgba(${hr}, ${hg}, ${hb}, 0.5)`)
        phaseGrad.addColorStop(1, `rgba(${Math.floor(hr * 0.5)}, ${Math.floor(hg * 0.5)}, ${Math.floor(hb * 0.5)}, 0.4)`)
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.arc(sx, sy, r, startAngle, phaseEnd)
        ctx.closePath()
        ctx.fillStyle = phaseGrad
        ctx.fill()
      }

      // Phase segment dividers — subtle
      if (totalPhases > 1) {
        for (let p = 0; p < totalPhases; p++) {
          const segAngle = startAngle + (p / totalPhases) * Math.PI * 2
          ctx.beginPath()
          ctx.moveTo(sx + Math.cos(segAngle) * r * 0.5, sy + Math.sin(segAngle) * r * 0.5)
          ctx.lineTo(sx + Math.cos(segAngle) * r, sy + Math.sin(segAngle) * r)
          ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.15)`
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }

      // Border stroke
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.5)`
      ctx.lineWidth = 2
      ctx.stroke()
    }
  } else if (isTotem && hpFraction > 0) {
    // Segmented HP — cap visual segments for perf
    const segments = Math.min(enemy.maxHp, 20)
    const hpPerSeg = enemy.maxHp / segments
    const gapAngle = segments > 1 ? 0.06 : 0
    const segAngle = (Math.PI * 2 - gapAngle * segments) / segments

    // Two-tone colors: bright inner, dark outer
    const midR = Math.max(0, r * 0.55)
    const innerFill = `rgba(${Math.min(255, hr + 30)}, ${Math.min(255, hg + 20)}, ${Math.min(255, hb + 20)}, 0.6)`
    const outerFill = `rgba(${Math.floor(hr * 0.75)}, ${Math.floor(hg * 0.75)}, ${Math.floor(hb * 0.75)}, 0.5)`
    const edgeColor = `rgba(${Math.min(255, hr + 80)}, ${Math.min(255, hg + 60)}, ${Math.min(255, hb + 60)}, 0.3)`

    // Helper: draw a two-tone filled segment
    const drawSegFill = (sStart: number, sEnd: number) => {
      // Outer dark portion (full wedge)
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, r, sStart, sEnd)
      ctx.closePath()
      ctx.fillStyle = outerFill
      ctx.fill()
      // Inner bright portion (smaller wedge on top)
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, midR, sStart, sEnd)
      ctx.closePath()
      ctx.fillStyle = innerFill
      ctx.fill()
      // Edge highlight arc
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(0, r - 2), sStart, sEnd)
      ctx.strokeStyle = edgeColor
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    for (let s = 0; s < segments; s++) {
      const segStart = startAngle + s * (segAngle + gapAngle)
      const segEnd = segStart + segAngle
      const segHPMin = s * hpPerSeg
      const segHPMax = (s + 1) * hpPerSeg

      if (enemy.hp >= segHPMax) {
        drawSegFill(segStart, segEnd)
      } else if (enemy.displayHp > segHPMin) {
        const displayInSeg = Math.min(enemy.displayHp - segHPMin, hpPerSeg)
        const actualInSeg = Math.max(0, enemy.hp - segHPMin)
        const displayFrac = displayInSeg / hpPerSeg
        const actualFrac = actualInSeg / hpPerSeg

        // Red drain part
        if (displayFrac > actualFrac) {
          const redStart = segStart + actualFrac * segAngle
          const redEnd = segStart + displayFrac * segAngle
          ctx.beginPath()
          ctx.moveTo(sx, sy)
          ctx.arc(sx, sy, r, redStart, redEnd)
          ctx.closePath()
          ctx.fillStyle = 'rgba(255, 50, 50, 0.4)'
          ctx.fill()
        }

        // Remaining HP — two-tone
        if (actualFrac > 0) {
          drawSegFill(segStart, segStart + actualFrac * segAngle)
        }
      }
    }

    // Structural divider lines
    if (segments > 1) {
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.lineWidth = 1.5
      for (let s = 0; s < segments; s++) {
        const divAngle = startAngle + s * (segAngle + gapAngle) - gapAngle / 2
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(sx + Math.cos(divAngle) * r, sy + Math.sin(divAngle) * r)
        ctx.stroke()
      }
    }

    // Center mark — bright core dot
    ctx.beginPath()
    ctx.arc(sx, sy, 4, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${Math.min(255, hr + 100)}, ${Math.min(255, hg + 80)}, ${Math.min(255, hb + 80)}, 0.7)`
    ctx.fill()
  } else if (hpFraction > 0) {
    // Normal enemy HP pie
    if (hpFraction > actualHpFraction) {
      const actualEnd = startAngle + actualHpFraction * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, r, actualEnd, endAngle)
      ctx.closePath()
      ctx.fillStyle = 'rgba(255, 50, 50, 0.4)'
      ctx.fill()
    }

    const enemyFillFraction = Math.min(hpFraction, actualHpFraction)
    const mainEnd = startAngle + enemyFillFraction * Math.PI * 2
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
    grad.addColorStop(0, `rgba(${hr}, ${hg}, ${hb}, 0.7)`)
    grad.addColorStop(0.7, `rgba(${hr}, ${hg}, ${hb}, 0.5)`)
    grad.addColorStop(1, `rgba(${Math.floor(hr * 0.5)}, ${Math.floor(hg * 0.5)}, ${Math.floor(hb * 0.5)}, 0.4)`)
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, r, startAngle, mainEnd)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()
  }

  // Damage preview
  if (ringOverEnemy && afterHitFraction < hpFraction) {
    if (afterHitFraction <= 0) {
      const t = (performance.now() % 180) / 180
      const pulse = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, r, startAngle, endAngle)
      ctx.closePath()
      ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * pulse})`
      ctx.fill()
    } else {
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, r, afterHitEnd, endAngle)
      ctx.closePath()
      ctx.fillStyle = 'rgba(0, 0, 0, 0.19)'
      ctx.fill()
    }
  }

  // White flash overlay on top — visible over pie fill
  if (enemy.hitFlash > 0) {
    const flashT = enemy.hitFlash / HIT_FLASH_DURATION
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${0.4 * flashT * flashT})`
    ctx.fill()
  }

  // Chill overlay — blue tint (inside circle only)
  if (enemy.chillStacks > 0) {
    const intensity = enemy.chillStacks / 5
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(128, 216, 255, ${0.06 + intensity * 0.14})`
    ctx.fill()
  }

  // Beat ripple — expanding ring when enemy fires
  for (const rs of enemy.rings) {
    if (rs.attackTimer >= 0 && rs.attackTimer < 0.15) {
      const rippleT = rs.attackTimer / 0.15
      const rippleR = r + rippleT * r * 0.35
      const rippleAlpha = 0.3 * (1 - rippleT)
      ctx.beginPath()
      ctx.arc(sx, sy, rippleR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${rippleAlpha})`
      ctx.lineWidth = 2 * (1 - rippleT)
      ctx.stroke()
    }
  }

  // Outline
  if (isTotem) {
    // Totem: glow behind outline + thick border + inner ring
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.12)`
    ctx.lineWidth = 8
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.strokeStyle = ringOverEnemy ? '#FFFFFF' : enemy.color
    ctx.lineWidth = 3
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(sx, sy, Math.max(0, r - 6), 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.25)`
    ctx.lineWidth = 1
    ctx.stroke()
  } else {
    // Normal enemy: crisp thin edge — glow pulse on beat
    if (globalBeatPulse > 0.01 && !ringOverEnemy) {
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${globalBeatPulse * 0.8})`
      ctx.lineWidth = 6
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.strokeStyle = ringOverEnemy ? '#FFFFFF' : enemy.color
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // Punchy hit flash — drawn ON TOP of everything
  if (enemy.hitFlash > 0 && !enemy.summon) {
    const flashT = enemy.hitFlash / HIT_FLASH_DURATION
    if (flashT > 0.6) {
      const hardFlash = (flashT - 0.6) / 0.4
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${hardFlash * 0.45})`
      ctx.fill()
    }
  }

  // Blink phase — telegraph → snap on half-beat → coil back
  if (enemy.blink && enemy.blinkPreview > 0) {
    const totalDur = BEAT_SEC
    const elapsed = totalDur - enemy.blinkPreview
    const halfBeat = totalDur * 0.5
    const phase1 = elapsed < halfBeat  // telegraph

    const fromSx = enemy.blinkFromX - camX
    const fromSy = enemy.blinkFromY - camY
    const toSx = enemy.blinkGhostX - camX
    const toSy = enemy.blinkGhostY - camY
    // Scale ghost count with distance for smooth trail
    const dx = toSx - fromSx, dy = toSy - fromSy
    const blinkDist = Math.sqrt(dx * dx + dy * dy)
    const ghostCount = Math.min(20, Math.max(8, Math.round(blinkDist / 30)))

    // White flash at snap moment — peaks at halfBeat, fades quickly
    const snapProximity = 1 - Math.min(1, Math.abs(elapsed - halfBeat) / 0.08)  // 1 at snap, 0 after 0.08s
    if (snapProximity > 0) {
      const flashAlpha = snapProximity * 0.12
      for (let g = 0; g < ghostCount; g++) {
        const frac = (g + 1) / (ghostCount + 1)
        const gx = fromSx + (toSx - fromSx) * frac
        const gy = fromSy + (toSy - fromSy) * frac
        ctx.beginPath()
        ctx.arc(gx, gy, r * 0.8, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha * (1 - frac * 0.3)})`
        ctx.fill()
      }
    }

    if (phase1) {
      const raw = elapsed / halfBeat
      const reach = 1 - (1 - raw) * (1 - raw)
      for (let g = 0; g < ghostCount; g++) {
        const frac = (g + 1) / (ghostCount + 1)
        if (frac > reach) continue
        const eased = frac * frac
        const gx = fromSx + (toSx - fromSx) * eased
        const gy = fromSy + (toSy - fromSy) * eased
        const ga = 0.09 * (reach - frac) / reach
        const gs = r * (1 - eased * 0.4)
        ctx.beginPath()
        ctx.arc(gx, gy, gs, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${ga})`
        ctx.fill()
      }
    } else {
      // Coil back — ease-in (slow start, accelerates into new position)
      const raw = (elapsed - halfBeat) / halfBeat  // 0→1
      const coil = raw * raw  // ease-in: slow then fast
      for (let g = 0; g < ghostCount; g++) {
        const baseFrac = (g + 1) / (ghostCount + 1)
        const slideFrac = baseFrac * (1 - coil) + coil  // slides toward 1.0 (new pos)
        const gx = fromSx + (toSx - fromSx) * slideFrac
        const gy = fromSy + (toSy - fromSy) * slideFrac
        const ga = 0.07 * (1 - coil)  // fades as it coils in
        const gs = r * (0.6 + coil * 0.4)  // grows as it arrives
        ctx.beginPath()
        ctx.arc(gx, gy, gs, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${ga})`
        ctx.fill()
      }
    }
  }

  // Magnet indicator — multiple inward-flowing rings
  if (enemy.magnet && r > 5) {
    const ringCount = 3
    const cycleLen = 1.2  // seconds per full cycle
    const now = performance.now() / 1000
    for (let i = 0; i < ringCount; i++) {
      const phase = ((now / cycleLen) + i / ringCount) % 1  // staggered 0→1
      const pulseR = r + (enemy.magnetRange - r) * (1 - phase)
      const pulseAlpha = phase * 0.18
      ctx.beginPath()
      ctx.arc(sx, sy, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(80, 180, 255, ${pulseAlpha})`
      ctx.lineWidth = 1 + phase * 1.5
      ctx.stroke()
    }
  }

  // Edge ring point indicators — track ring + sliding active dots
  for (const rs of enemy.rings) {
    if (!rs.edgeMode || r < 5) continue
    const step = (Math.PI * 2) / rs.edgePoints

    // Scale dots with enemy size (baseline 44px)
    const dotScale = Math.max(1, r / 60)

    // Track ring connecting all points
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.12)`
    ctx.lineWidth = 2 + dotScale
    ctx.stroke()

    // Inactive point dots (static positions)
    for (let p = 0; p < rs.edgePoints; p++) {
      const angle = -Math.PI / 2 + p * step
      const px = sx + Math.cos(angle) * r
      const py = sy + Math.sin(angle) * r
      ctx.beginPath()
      ctx.arc(px, py, 2 * dotScale, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.2)`
      ctx.fill()
    }

    // Active dots — use smooth angle, glow
    for (let a = 0; a < rs.edgeActive; a++) {
      const angle = -Math.PI / 2 + rs.edgeAngle + a * step
      const px = sx + Math.cos(angle) * r
      const py = sy + Math.sin(angle) * r

      // Glow
      ctx.beginPath()
      ctx.arc(px, py, 11 * dotScale, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.2)`
      ctx.fill()

      // Core dot
      ctx.beginPath()
      ctx.arc(px, py, 6 * dotScale, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${Math.min(255, hr + 60)}, ${Math.min(255, hg + 40)}, ${Math.min(255, hb + 40)}, 0.9)`
      ctx.fill()
    }
  }

  // Revenge indicator — glowing outward spikes
  if (enemy.revenge && !enemy.dying && r > 8) {
    const spikeCount = Math.min(enemy.revengeRings, 6)
    const pulse = 0.5 + Math.sin(performance.now() * 0.003) * 0.5
    const scale = Math.max(1, r / 44)
    const fireFlash = enemy.hitFlash > HIT_FLASH_DURATION - 0.1 ? (enemy.hitFlash - (HIT_FLASH_DURATION - 0.1)) / 0.1 : 0
    for (let i = 0; i < spikeCount; i++) {
      const angle = enemy.revengeAngle + (i / spikeCount) * Math.PI * 2
      const baseX = sx + Math.cos(angle) * r
      const baseY = sy + Math.sin(angle) * r
      const tipLen = (12 + fireFlash * 16) * scale
      const glowWidth = (10 + fireFlash * 10) * scale
      const coreWidth = (6 + fireFlash * 6.5) * scale
      const tipX = sx + Math.cos(angle) * (r + tipLen)
      const tipY = sy + Math.sin(angle) * (r + tipLen)
      const fR = Math.round(255)
      const fG = Math.round(60 + fireFlash * 195)
      const fB = Math.round(40 + fireFlash * 215)

      // Glow
      ctx.beginPath()
      ctx.moveTo(baseX + Math.cos(angle + Math.PI / 2) * glowWidth, baseY + Math.sin(angle + Math.PI / 2) * glowWidth)
      ctx.lineTo(tipX, tipY)
      ctx.lineTo(baseX + Math.cos(angle - Math.PI / 2) * glowWidth, baseY + Math.sin(angle - Math.PI / 2) * glowWidth)
      ctx.closePath()
      ctx.fillStyle = `rgba(${fR}, ${fG}, ${fB}, ${0.1 + pulse * 0.12 + fireFlash * 0.25})`
      ctx.fill()

      // Core spike
      ctx.beginPath()
      ctx.moveTo(baseX + Math.cos(angle + Math.PI / 2) * coreWidth, baseY + Math.sin(angle + Math.PI / 2) * coreWidth)
      ctx.lineTo(tipX, tipY)
      ctx.lineTo(baseX + Math.cos(angle - Math.PI / 2) * coreWidth, baseY + Math.sin(angle - Math.PI / 2) * coreWidth)
      ctx.closePath()
      ctx.fillStyle = `rgba(${fR}, ${fG}, ${fB}, ${0.25 + pulse * 0.2 + fireFlash * 0.35})`
      ctx.fill()
    }
  }

  // Volatile indicator — pulsing warm inner glow + faint blast range
  if (enemy.volatile && r > 5 && !enemy.dying) {
    // Inner glow — slow pulse
    const vPulse = 0.5 + Math.sin(performance.now() * 0.004) * 0.5
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 100, 0, ${0.12 + vPulse * 0.15})`
    ctx.fill()

    // Faint blast range circle
    ctx.save()
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.arc(sx, sy, enemy.volatileRange, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 120, 0, 0.08)`
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()

    // Ambient fire embers — rising from body edge, scales with enemy size
    const fireScale = Math.min(r / 44, 1.4)
    if (Math.random() < 0.2 + fireScale * 0.1) {
      const a = Math.random() * Math.PI * 2
      const edgeDist = r * (0.7 + Math.random() * 0.3)
      const px = enemy.x + Math.cos(a) * edgeDist
      const py = enemy.y + Math.sin(a) * edgeDist
      const tint = Math.random()
      spawnParticle(px, py,
        (Math.random() - 0.5) * 20, -25 - Math.random() * 35,
        255, Math.floor(60 + tint * 80), Math.floor(tint * 30),
        0.15 + Math.random() * 0.12, (4.95 + Math.random() * 4.14) * fireScale)
    }
  }

  // Consume indicator — rotating arcs inside
  if (enemy.consume && r > 8) {
    const scale = r / 44  // scale with enemy size
    const voidR = r * 0.6
    const spin = performance.now() * 0.002
    const arcCount = 3
    const arcLen = Math.PI * 0.45
    const gap = (Math.PI * 2 - arcLen * arcCount) / arcCount

    for (let a = 0; a < arcCount; a++) {
      const aStart = spin + a * (arcLen + gap)
      const aEnd = aStart + arcLen

      ctx.beginPath()
      ctx.arc(sx, sy, voidR, aStart, aEnd)
      ctx.strokeStyle = 'rgba(230, 60, 70, 0.15)'
      ctx.lineWidth = 12 * scale
      ctx.stroke()

      ctx.beginPath()
      ctx.arc(sx, sy, voidR, aStart, aEnd)
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.5)'
      ctx.lineWidth = 5 * scale
      ctx.stroke()
    }
  }

  // Immovable indicator — glowing anchor brackets
  if (enemy.immovable && r > 5) {
    const scale = r / 44
    const br = r - 2 * scale
    const bLen = r * 0.22
    const anchorPulse = 0.5 + 0.5 * Math.sin(performance.now() / 600)
    const amberR = 255
    const amberG = Math.round(180 + anchorPulse * 40)
    const amberB = Math.round(60 + anchorPulse * 30)

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2
      const cx = sx + Math.cos(a) * br
      const cy = sy + Math.sin(a) * br
      const arm1A = a + Math.PI / 2
      const arm2A = a

      // Dark red outline
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(arm1A) * bLen, cy + Math.sin(arm1A) * bLen)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx - Math.cos(arm2A) * bLen, cy - Math.sin(arm2A) * bLen)
      ctx.strokeStyle = 'rgba(180, 30, 20, 0.6)'
      ctx.lineWidth = 9 * scale
      ctx.stroke()

      // Core bracket
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(arm1A) * bLen, cy + Math.sin(arm1A) * bLen)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx - Math.cos(arm2A) * bLen, cy - Math.sin(arm2A) * bLen)
      ctx.strokeStyle = `rgba(${amberR}, ${amberG}, ${amberB}, ${0.7 + anchorPulse * 0.25})`
      ctx.lineWidth = 6.5 * scale
      ctx.stroke()

      // Anchor dot at corner
      ctx.beginPath()
      ctx.arc(cx, cy, 3 * scale + anchorPulse * 1.5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 240, 180, ${0.8 + anchorPulse * 0.2})`
      ctx.fill()
    }
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
  }

  // Summon — orbiting ritual nodes inside enemy body
  if (enemy.summon && r > 5 && !enemy.dying) {
    const now = gameTimeMs  // pauses with game
    const N = enemy.summonNodes
    const orbitR = r * 0.55  // nodes orbit at 55% of enemy radius
    const nodeR = Math.max(8, r * 0.34)  // node size scales with enemy
    const baseRot = now / 2000  // slow spin
    const activeIdx = enemy.summonBeatCount % N
    const beatFrac = getLoopPosition() % 1

    // Check if current phase is SHOP
    const currentPhase = enemy.summonPhases[enemy.summonCurrentPhase]
    const isShopPhase = currentPhase && currentPhase.spawns.length === 1 && currentPhase.spawns[0]!.enemyName.toUpperCase() === 'SHOP'

    // Colors — gold base for all, cyan/teal when locked
    const baseCr = 255
    const baseCg = 215
    const baseCb = 64
    const lockCr = 0, lockCg = 255, lockCb = isShopPhase ? 200 : 255  // cyan/teal when locked

    const prevActiveIdx = ((enemy.summonBeatCount - 1 + N * 100) % N)

    for (let i = 0; i < N; i++) {
      const angle = baseRot + (i / N) * Math.PI * 2
      const nx = sx + Math.cos(angle) * orbitR
      const ny = sy + Math.sin(angle) * orbitR
      const isActive = i === activeIdx
      const isPrevActive = i === prevActiveIdx && !isActive
      const isLocked = enemy.summonNodeStates[i] === 'locked'
      const cr = isLocked ? lockCr : baseCr
      const cg = isLocked ? lockCg : baseCg
      const cb = isLocked ? lockCb : baseCb

      // Shop phase — plus icon IS the node
      if (isShopPhase) {
        const plusSize = nodeR * 0.6
        const plusW = nodeR * 0.22

        if (isLocked) {
          // Locked — bright cyan/teal plus, energized, bigger than active
          const lockPulse = 0.5 + 0.5 * Math.sin(now / 250)
          const lockSize = plusSize * 1.15 + lockPulse * 1.5
          const lockW = plusW * 1.25 + lockPulse * 0.5
          // Glow circle behind
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR + 3, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.25 + lockPulse * 0.1})`
          ctx.fill()
          // Crisp border ring
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR + 2, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.6 + lockPulse * 0.3})`
          ctx.lineWidth = 3 + lockPulse
          ctx.stroke()
          // Plus — thick, bright, bigger
          ctx.lineCap = 'round'
          ctx.lineWidth = lockW
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.8 + lockPulse * 0.2})`
          ctx.beginPath()
          ctx.moveTo(nx, ny - lockSize)
          ctx.lineTo(nx, ny + lockSize)
          ctx.moveTo(nx - lockSize, ny)
          ctx.lineTo(nx + lockSize, ny)
          ctx.stroke()
          // White inner plus
          ctx.lineWidth = lockW * 0.4
          ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 + lockPulse * 0.3})`
          ctx.beginPath()
          ctx.moveTo(nx, ny - lockSize * 0.75)
          ctx.lineTo(nx, ny + lockSize * 0.75)
          ctx.moveTo(nx - lockSize * 0.75, ny)
          ctx.lineTo(nx + lockSize * 0.75, ny)
          ctx.stroke()
          ctx.lineCap = 'butt'
          // Lock flash
          if (enemy.summonLockFlash[i]! > 0) {
            const f = enemy.summonLockFlash[i]! / 0.3
            ctx.beginPath()
            ctx.arc(nx, ny, nodeR + (1 - f) * 20, 0, Math.PI * 2)
            ctx.fillStyle = `rgba(255, 255, 255, ${f * 0.4})`
            ctx.fill()
            if (enemy.summonLockFlash[i]! > 0.28) {
              const worldNx = enemy.x + Math.cos(angle) * orbitR
              const worldNy = enemy.y + Math.sin(angle) * orbitR
              for (let p = 0; p < 12; p++) {
                const pa = (p / 12) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
                const speed = 400 + Math.random() * 350
                spawnParticle(worldNx, worldNy, Math.cos(pa) * speed, Math.sin(pa) * speed,
                  cr, cg, cb, 0.25 + Math.random() * 0.15, 4 + Math.random() * 3)
              }
            }
          }
        } else if (isActive) {
          // Active — bright pulsing plus with clear hitbox ring
          const flash = Math.max(0, 1 - beatFrac * 2.5)
          // Glow halo
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR + 4 + flash * 5, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.06 + flash * 0.12})`
          ctx.fill()
          // BG circle
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.1 + flash * 0.15})`
          ctx.fill()
          // Hitbox ring
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.4 + flash * 0.4})`
          ctx.lineWidth = 2 + flash
          ctx.stroke()
          // Plus — pulses
          const activeSize = plusSize + flash * 3
          const activeW = plusW + flash * 2
          ctx.lineCap = 'round'
          ctx.lineWidth = activeW
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.6 + flash * 0.35})`
          ctx.beginPath()
          ctx.moveTo(nx, ny - activeSize)
          ctx.lineTo(nx, ny + activeSize)
          ctx.moveTo(nx - activeSize, ny)
          ctx.lineTo(nx + activeSize, ny)
          ctx.stroke()
          // White flash center
          if (flash > 0.3) {
            ctx.lineWidth = activeW * 0.4
            ctx.strokeStyle = `rgba(255, 255, 255, ${flash * 0.5})`
            ctx.beginPath()
            ctx.moveTo(nx, ny - activeSize * 0.7)
            ctx.lineTo(nx, ny + activeSize * 0.7)
            ctx.moveTo(nx - activeSize * 0.7, ny)
            ctx.lineTo(nx + activeSize * 0.7, ny)
            ctx.stroke()
          }
          ctx.lineCap = 'butt'
        } else if (isPrevActive) {
          // Fading out
          const fadeOut = Math.max(0, 1 - beatFrac * 8)
          ctx.lineCap = 'round'
          ctx.lineWidth = plusW
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.15 + fadeOut * 0.35})`
          ctx.beginPath()
          ctx.moveTo(nx, ny - plusSize)
          ctx.lineTo(nx, ny + plusSize)
          ctx.moveTo(nx - plusSize, ny)
          ctx.lineTo(nx + plusSize, ny)
          ctx.stroke()
          ctx.lineCap = 'butt'
        } else {
          // Idle — plus with hitbox ring
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.15)`
          ctx.lineWidth = 1.5
          ctx.stroke()
          // Plus
          ctx.lineCap = 'round'
          ctx.lineWidth = plusW
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.25)`
          ctx.beginPath()
          ctx.moveTo(nx, ny - plusSize)
          ctx.lineTo(nx, ny + plusSize)
          ctx.moveTo(nx - plusSize, ny)
          ctx.lineTo(nx + plusSize, ny)
          ctx.stroke()
          ctx.lineCap = 'butt'
        }
        continue  // skip normal node rendering
      }

      if (isLocked) {
        // Locked — energized cyberpunk core
        const lockPulse = 0.5 + 0.5 * Math.sin(now / 250)
        const lockSpin = now / 400

        // Outer energy ring — breathing
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR + 2, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.5 + lockPulse * 0.3})`
        ctx.lineWidth = 3 + lockPulse
        ctx.stroke()

        // Inner radial glow — solid cyan, covers underlying color
        const lockGrad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nodeR)
        lockGrad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${0.85 + lockPulse * 0.15})`)
        lockGrad.addColorStop(0.4, `rgba(${cr}, ${cg}, ${cb}, 0.6)`)
        lockGrad.addColorStop(0.8, `rgba(${cr}, ${cg}, ${cb}, 0.35)`)
        lockGrad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.2)`)
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
        ctx.fillStyle = lockGrad
        ctx.fill()

        // Counter-rotating arc layers
        drawRitualNodeArcs(nx, ny, nodeR * 0.7, cr, cg, cb, 0.6, 2, lockSpin, 2, 0.35)
        drawRitualNodeArcs(nx, ny, nodeR * 0.45, 255, 255, 255, 0.25, 1.5, -lockSpin * 1.3, 3, 0.3)

        // Bright white core dot
        ctx.beginPath()
        ctx.arc(nx, ny, 3 + lockPulse * 2, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${0.6 + lockPulse * 0.3})`
        ctx.fill()
        // Lock flash + explosion
        if (enemy.summonLockFlash[i]! > 0) {
          const f = enemy.summonLockFlash[i]! / 0.3
          // White flash
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(255, 255, 255, ${f * 0.6})`
          ctx.fill()
          // Double shockwave
          const shR1 = nodeR + (1 - f) * 30
          ctx.beginPath()
          ctx.arc(nx, ny, shR1, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${f * 0.6})`
          ctx.lineWidth = 3 * f
          ctx.stroke()
          const shR2 = nodeR + (1 - f) * 15
          ctx.beginPath()
          ctx.arc(nx, ny, shR2, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(255, 255, 255, ${f * 0.4})`
          ctx.lineWidth = 2 * f
          ctx.stroke()
          // Particle burst on first frame
          if (enemy.summonLockFlash[i]! > 0.28) {
            const worldNx = enemy.x + Math.cos(angle) * orbitR
            const worldNy = enemy.y + Math.sin(angle) * orbitR
            for (let p = 0; p < 14; p++) {
              const pa = (p / 14) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
              const speed = 500 + Math.random() * 400
              spawnParticle(worldNx, worldNy,
                Math.cos(pa) * speed, Math.sin(pa) * speed,
                cr, cg, cb, 0.25 + Math.random() * 0.15, 5 + Math.random() * 3.5)
            }
            for (let p = 0; p < 6; p++) {
              const pa = Math.random() * Math.PI * 2
              const speed = 600 + Math.random() * 400
              spawnParticle(worldNx, worldNy,
                Math.cos(pa) * speed, Math.sin(pa) * speed,
                255, 255, 255, 0.2 + Math.random() * 0.15, 3 + Math.random() * 2.5)
            }
            // Yellow/gold sparks
            for (let p = 0; p < 8; p++) {
              const pa = Math.random() * Math.PI * 2
              const speed = 400 + Math.random() * 350
              spawnParticle(worldNx, worldNy,
                Math.cos(pa) * speed, Math.sin(pa) * speed,
                255, 215 + Math.floor(Math.random() * 40), 40 + Math.floor(Math.random() * 30),
                0.25 + Math.random() * 0.15, 3.5 + Math.random() * 3)
            }
          }
        }
      } else if (isActive) {
        // Active — bright, strong beat flash
        const flash = Math.max(0, 1 - beatFrac * 2.5)
        // Outer glow halo
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR + 6 + flash * 5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.08 + flash * 0.15})`
        ctx.fill()
        // Filled body
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.25 + flash * 0.3})`
        ctx.fill()
        // Bright ring
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.7 + flash * 0.3})`
        ctx.lineWidth = 2.5 + flash * 1.5
        ctx.stroke()
        // Spinning inner arcs — fast
        const activeSpin = now / 400
        drawRitualNodeArcs(nx, ny, nodeR * 0.6, cr, cg, cb, 0.3 + flash * 0.3, 1.5, activeSpin, 3, 0.3)
        // White hot center
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR * 0.35 + flash * 3, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${0.4 + flash * 0.5})`
        ctx.fill()
      } else if (isPrevActive) {
        // Fading out — was just active, decays over first half of beat
        const fadeOut = Math.max(0, 1 - beatFrac * 8)
        // Residual glow
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR + fadeOut * 4, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.06 + fadeOut * 0.2})`
        ctx.fill()
        // Fading ring
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.15 + fadeOut * 0.4})`
        ctx.lineWidth = 1 + fadeOut * 1.5
        ctx.stroke()
        // Fading center dot
        if (fadeOut > 0.1) {
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR * 0.2 + fadeOut * 2, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(255, 255, 255, ${fadeOut * 0.3})`
          ctx.fill()
        }
      } else {
        // Idle — hollow ring + slow faint arcs
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.15)`
        ctx.lineWidth = 1
        ctx.stroke()
        // Slow inner arcs
        const idleSpin = now / 2000 + i * 1.5
        drawRitualNodeArcs(nx, ny, nodeR * 0.55, cr, cg, cb, 0.08, 1, idleSpin, 2, 0.5)
      }
    }

    // Plasma beams between locked nodes
    if (enemy.summonProgress > 0) {
      const beamTime = now / 1000
      const connCount = enemy.summonProgress >= N ? N : enemy.summonProgress
      const beatPulse = Math.max(0, 1 - beatFrac * 2.5)

      for (let j = 0; j < connCount; j++) {
        const fromIdx = (enemy.summonStartOffset + j) % N
        const toIdx = (enemy.summonStartOffset + j + 1) % N
        const fromAngle = baseRot + (fromIdx / N) * Math.PI * 2
        const toAngle = baseRot + (toIdx / N) * Math.PI * 2
        const fx = sx + Math.cos(fromAngle) * orbitR
        const fy = sy + Math.sin(fromAngle) * orbitR
        const tx = sx + Math.cos(toAngle) * orbitR
        const ty = sy + Math.sin(toAngle) * orbitR

        const ldx = tx - fx, ldy = ty - fy
        const lDist = Math.sqrt(ldx * ldx + ldy * ldy)
        if (lDist < 1) continue
        const lpx = -ldy / lDist, lpy = ldx / lDist
        const intensity = 0.5 + beatPulse * 0.5

        // Build flowing sine wave points
        const segs = 16
        const pts: { x: number; y: number }[] = []
        for (let s = 0; s <= segs; s++) {
          const st = s / segs
          const taper = Math.sin(st * Math.PI)
          const w1 = Math.sin(st * Math.PI * 5 - beamTime * 4) * 4 * taper
          const w2 = Math.sin(st * Math.PI * 3 + beamTime * 2.5) * 3 * taper
          const wave = (w1 + w2) * intensity
          pts.push({ x: fx + ldx * st + lpx * wave, y: fy + ldy * st + lpy * wave })
        }

        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        // Glow
        ctx.beginPath()
        for (let s = 0; s < pts.length; s++) {
          if (s === 0) ctx.moveTo(pts[s]!.x, pts[s]!.y)
          else ctx.lineTo(pts[s]!.x, pts[s]!.y)
        }
        ctx.strokeStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${0.12 * intensity})`
        ctx.lineWidth = 28 * intensity
        ctx.stroke()
        // Core
        ctx.beginPath()
        for (let s = 0; s < pts.length; s++) {
          if (s === 0) ctx.moveTo(pts[s]!.x, pts[s]!.y)
          else ctx.lineTo(pts[s]!.x, pts[s]!.y)
        }
        ctx.strokeStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${0.5 * intensity})`
        ctx.lineWidth = 10 * intensity
        ctx.stroke()
        // White center
        ctx.beginPath()
        for (let s = 0; s < pts.length; s++) {
          if (s === 0) ctx.moveTo(pts[s]!.x, pts[s]!.y)
          else ctx.lineTo(pts[s]!.x, pts[s]!.y)
        }
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 * intensity})`
        ctx.lineWidth = 4
        ctx.stroke()
        ctx.lineCap = 'butt'
        ctx.lineJoin = 'miter'
      }
    }

    // Beam from last locked → next target node + pulsing target indicator
    if (enemy.summonProgress > 0 && enemy.summonProgress < N && enemy.summonActivationTimer <= 0) {
      const lastLockedIdx = (enemy.summonStartOffset + enemy.summonProgress - 1) % N
      const nextIdx = (enemy.summonStartOffset + enemy.summonProgress) % N
      const fromAngle = baseRot + (lastLockedIdx / N) * Math.PI * 2
      const toAngle = baseRot + (nextIdx / N) * Math.PI * 2
      const fx = sx + Math.cos(fromAngle) * orbitR
      const fy = sy + Math.sin(fromAngle) * orbitR
      const tx = sx + Math.cos(toAngle) * orbitR
      const ty = sy + Math.sin(toAngle) * orbitR

      // Faint guide beam
      const beamTime = now / 1000
      const bPulse = Math.max(0, 1 - beatFrac * 2.5)
      const ldx = tx - fx, ldy = ty - fy
      const lDist = Math.sqrt(ldx * ldx + ldy * ldy)
      if (lDist > 1) {
        const lpx = -ldy / lDist, lpy = ldx / lDist
        const pts: { x: number; y: number }[] = []
        for (let s = 0; s <= 12; s++) {
          const st = s / 12
          const taper = Math.sin(st * Math.PI)
          const w = Math.sin(st * Math.PI * 4 - beamTime * 3) * 3 * taper
          pts.push({ x: fx + ldx * st + lpx * w, y: fy + ldy * st + lpy * w })
        }
        ctx.lineCap = 'round'
        ctx.beginPath()
        for (let s = 0; s < pts.length; s++) {
          if (s === 0) ctx.moveTo(pts[s]!.x, pts[s]!.y)
          else ctx.lineTo(pts[s]!.x, pts[s]!.y)
        }
        ctx.strokeStyle = `rgba(${baseCr}, ${baseCg}, ${baseCb}, ${0.12 + bPulse * 0.2})`
        ctx.lineWidth = 10
        ctx.stroke()
        ctx.lineCap = 'butt'
      }

      // Target indicator — 4 white arrows breathing inward
      const targetPulse = 0.5 + 0.5 * Math.sin(now / 150)
      const arrowDist = nodeR + 16 + targetPulse * 5
      const arrowLen = 8 + bPulse * 4
      const arrowAlpha = 0.4 + bPulse * 0.4 + targetPulse * 0.15
      ctx.lineCap = 'round'
      ctx.lineWidth = 3.5 + bPulse * 1.5
      ctx.strokeStyle = `rgba(${baseCr}, ${baseCg}, ${baseCb}, ${arrowAlpha})`
      for (let a = 0; a < 4; a++) {
        const dir = a * Math.PI / 2 + Math.PI / 4
        const ax = tx + Math.cos(dir) * arrowDist
        const ay = ty + Math.sin(dir) * arrowDist
        const inX = tx + Math.cos(dir) * (arrowDist - arrowLen)
        const inY = ty + Math.sin(dir) * (arrowDist - arrowLen)
        ctx.beginPath()
        ctx.moveTo(ax, ay)
        ctx.lineTo(inX, inY)
        ctx.stroke()
      }
      ctx.lineCap = 'butt'
    }

    // Activation animation — dissolving energy burst
    if (enemy.summonActivationTimer > 0) {
      const at = enemy.summonActivationTimer / (BEAT_SEC * 0.5)  // 1→0
      const explodeT = 1 - at  // 0→1

      // Nodes dissolve outward — expand and fade
      for (let i = 0; i < N; i++) {
        const a = baseRot + (i / N) * Math.PI * 2
        const dissolveR = orbitR + explodeT * r * 0.2
        const anx = sx + Math.cos(a) * dissolveR
        const any = sy + Math.sin(a) * dissolveR
        const dissolveSize = nodeR * (1 + explodeT * 0.8)
        ctx.beginPath()
        ctx.arc(anx, any, dissolveSize, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${at * at * 0.4})`
        ctx.fill()
      }

      // Double expanding shockwave
      const shock1R = r + explodeT * r * 0.4
      ctx.beginPath()
      ctx.arc(sx, sy, shock1R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${at * 0.6})`
      ctx.lineWidth = 4 * at
      ctx.stroke()

      const shock2R = r + explodeT * r * 0.2
      ctx.beginPath()
      ctx.arc(sx, sy, shock2R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${at * 0.4})`
      ctx.lineWidth = 2 * at
      ctx.stroke()

      // Center energy flash — bright then fades
      const flashAlpha = at > 0.5 ? (1 - at) * 2 : at * 2
      ctx.beginPath()
      ctx.arc(sx, sy, r * (0.3 + explodeT * 0.4), 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha * 0.3})`
      ctx.fill()

      // Radial energy lines shooting outward
      const lineCount = 8
      for (let i = 0; i < lineCount; i++) {
        const la = (i / lineCount) * Math.PI * 2 + explodeT * 0.5
        const innerR = r * 0.3 + explodeT * r * 0.2
        const outerR = r + explodeT * r * 0.5
        ctx.beginPath()
        ctx.moveTo(sx + Math.cos(la) * innerR, sy + Math.sin(la) * innerR)
        ctx.lineTo(sx + Math.cos(la) * outerR, sy + Math.sin(la) * outerR)
        ctx.strokeStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${at * 0.3})`
        ctx.lineWidth = 2 * at
        ctx.stroke()
      }

      // Burst particles on first frame
      if (enemy.summonActivationTimer > BEAT_SEC * 0.5 - 0.02) {
        // Converge from nodes to center
        for (let i = 0; i < N; i++) {
          const a = baseRot + (i / N) * Math.PI * 2
          const pnx = enemy.x + Math.cos(a) * orbitR
          const pny = enemy.y + Math.sin(a) * orbitR
          for (let p = 0; p < 8; p++) {
            const toAngle = Math.atan2(enemy.y - pny, enemy.x - pnx)
            const speed = 120 + Math.random() * 100
            spawnParticle(pnx, pny,
              Math.cos(toAngle) * speed + (Math.random() - 0.5) * 40,
              Math.sin(toAngle) * speed + (Math.random() - 0.5) * 40,
              lockCr, lockCg, lockCb, 0.3 + Math.random() * 0.2, 5 + Math.random() * 4)
          }
        }
        // Outward explosion from center
        for (let p = 0; p < 20; p++) {
          const a = (p / 20) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
          const speed = 200 + Math.random() * 250
          spawnParticle(enemy.x, enemy.y,
            Math.cos(a) * speed, Math.sin(a) * speed,
            255, 255, 255, 0.2 + Math.random() * 0.15, 4 + Math.random() * 3)
        }
      }
    }
  }

  if (enemy.blink && enemy.blinkPreview > 0) ctx.globalAlpha = 1
}

function drawDesignerPreview(player: Player): void {
  const preview = getPreviewEnemy()
  if (!preview) return

  const hr = parseInt(preview.color.slice(1, 3), 16)
  const hg = parseInt(preview.color.slice(3, 5), 16)
  const hb = parseInt(preview.color.slice(5, 7), 16)

  // Orbit at sweet spot of largest ring
  const maxRingR = Math.max(...preview.previewRings.map(r => r.ringRadius), 100)
  const orbitDist = maxRingR * 0.85
  const orbitSpeed = preview.moveSpeed / 200
  const angle = performance.now() / 1000 * orbitSpeed
  const worldX = player.x + Math.cos(angle) * orbitDist
  const worldY = player.y + Math.sin(angle) * orbitDist
  const sx = worldX - camX
  const sy = worldY - camY

  // Draw each preview ring
  for (const pr of preview.previewRings) {
    // Compute origins for edge mode
    const ringOrigins: { x: number; y: number }[] = []
    if (pr.edgeMode) {
      for (let a = 0; a < pr.edgeActive; a++) {
        const angle = -Math.PI / 2 + (a / pr.edgePoints) * Math.PI * 2
        ringOrigins.push({
          x: worldX + Math.cos(angle) * preview.radius,
          y: worldY + Math.sin(angle) * preview.radius,
        })
      }
    } else {
      ringOrigins.push({ x: worldX, y: worldY })
    }

    if (pr.attackTimer >= 0) {
      const expansion = getRingExpansion(pr.attackTimer)
      const currentRadius = pr.ringRadius * expansion
      if (currentRadius > 1) {
        const pExpandTime = pr.expandTime
        const buildup = Math.min(pr.attackTimer / pExpandTime, 1)
        const alpha = getRingAlpha(pr.attackTimer, 0.3 + 0.5 * buildup)

        for (const o of ringOrigins) {
          ctx.beginPath()
          ctx.arc(o.x - camX, o.y - camY, currentRadius, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${alpha})`
          ctx.lineWidth = 2 + 4 * buildup
          ctx.stroke()
        }
      }
    }

    // Max ring range — dashed (from each origin)
    for (const o of ringOrigins) {
      ctx.beginPath()
      ctx.arc(o.x - camX, o.y - camY, pr.ringRadius, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.1)`
      ctx.lineWidth = 1
      ctx.setLineDash([4, 6])
      ctx.stroke()
      ctx.setLineDash([])
    }
  }

  // Ghost body
  ctx.globalAlpha = 0.7
  ctx.beginPath()
  ctx.arc(sx, sy, preview.radius, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.4)`
  ctx.fill()
  ctx.strokeStyle = preview.color
  ctx.lineWidth = 2
  ctx.setLineDash([4, 4])
  ctx.stroke()
  ctx.setLineDash([])

  // Edge point dots on preview
  for (const ring of preview.previewRings) {
    if (!ring.edgeMode) continue
    for (let p = 0; p < ring.edgePoints; p++) {
      const angle = -Math.PI / 2 + (p / ring.edgePoints) * Math.PI * 2
      const px = sx + Math.cos(angle) * preview.radius
      const py = sy + Math.sin(angle) * preview.radius
      const isActive = p < ring.edgeActive
      ctx.beginPath()
      ctx.arc(px, py, isActive ? 4 : 2.5, 0, Math.PI * 2)
      ctx.fillStyle = isActive
        ? `rgba(${hr}, ${hg}, ${hb}, 0.8)`
        : `rgba(${hr}, ${hg}, ${hb}, 0.25)`
      ctx.fill()
    }
  }

  // Tag visuals on preview
  const pr = preview.radius

  // Magnet rings
  if (preview.magnet) {
    const ringCount = 3
    const cycleLen = 1.2
    const now = performance.now() / 1000
    for (let i = 0; i < ringCount; i++) {
      const phase = ((now / cycleLen) + i / ringCount) % 1
      const pulseR = pr + (preview.magnetRange - pr) * (1 - phase)
      ctx.beginPath()
      ctx.arc(sx, sy, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(80, 180, 255, ${phase * 0.18})`
      ctx.lineWidth = 1 + phase * 1.5
      ctx.stroke()
    }
  }

  // Volatile range
  if (preview.volatile) {
    ctx.save()
    ctx.setLineDash([6, 6])
    ctx.beginPath()
    ctx.arc(sx, sy, preview.volatileRange, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255, 120, 0, 0.12)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  // Consume arcs
  if (preview.consume) {
    const scale = pr / 44
    const voidR = pr * 0.6
    const spin = performance.now() * 0.002
    const arcLen = Math.PI * 0.45
    const gap = (Math.PI * 2 - arcLen * 3) / 3
    for (let a = 0; a < 3; a++) {
      const aStart = spin + a * (arcLen + gap)
      const aEnd = aStart + arcLen
      ctx.beginPath()
      ctx.arc(sx, sy, voidR, aStart, aEnd)
      ctx.strokeStyle = 'rgba(230, 60, 70, 0.15)'
      ctx.lineWidth = 12 * scale
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(sx, sy, voidR, aStart, aEnd)
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.5)'
      ctx.lineWidth = 5 * scale
      ctx.stroke()
    }
  }

  // Immovable brackets
  if (preview.immovable) {
    const scale = pr / 44
    const br = pr + 6 * scale
    const bLen = pr * 0.3
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
    ctx.lineWidth = 6 * scale
    ctx.lineCap = 'round'
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2
      const cx = sx + Math.cos(a) * br
      const cy = sy + Math.sin(a) * br
      const arm1A = a + Math.PI / 2
      const arm2A = a
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(arm1A) * bLen, cy + Math.sin(arm1A) * bLen)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx - Math.cos(arm2A) * bLen, cy - Math.sin(arm2A) * bLen)
      ctx.stroke()
    }
    ctx.lineCap = 'butt'
  }

  // Revenge spikes
  if (preview.revenge) {
    const spikeCount = Math.min(preview.revengeRings, 6)
    const pulse = 0.5 + Math.sin(performance.now() * 0.003) * 0.5
    const scale = Math.max(1, pr / 44)
    const rotAngle = performance.now() * 0.0005
    for (let i = 0; i < spikeCount; i++) {
      const a = rotAngle + (i / spikeCount) * Math.PI * 2
      const bx = sx + Math.cos(a) * pr
      const by = sy + Math.sin(a) * pr
      const tx = sx + Math.cos(a) * (pr + 9 * scale)
      const ty = sy + Math.sin(a) * (pr + 9 * scale)
      const gw = 8 * scale
      const cw = 4.5 * scale

      ctx.beginPath()
      ctx.moveTo(bx + Math.cos(a + Math.PI / 2) * gw, by + Math.sin(a + Math.PI / 2) * gw)
      ctx.lineTo(tx, ty)
      ctx.lineTo(bx + Math.cos(a - Math.PI / 2) * gw, by + Math.sin(a - Math.PI / 2) * gw)
      ctx.closePath()
      ctx.fillStyle = `rgba(255, 60, 40, ${0.1 + pulse * 0.12})`
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(bx + Math.cos(a + Math.PI / 2) * cw, by + Math.sin(a + Math.PI / 2) * cw)
      ctx.lineTo(tx, ty)
      ctx.lineTo(bx + Math.cos(a - Math.PI / 2) * cw, by + Math.sin(a - Math.PI / 2) * cw)
      ctx.closePath()
      ctx.fillStyle = `rgba(255, 80, 60, ${0.25 + pulse * 0.2})`
      ctx.fill()
    }

    // Revenge radius range — from each spike point
    ctx.save()
    ctx.setLineDash([4, 6])
    for (let i = 0; i < spikeCount; i++) {
      const a = rotAngle + (i / spikeCount) * Math.PI * 2
      const px = sx + Math.cos(a) * pr
      const py = sy + Math.sin(a) * pr
      ctx.beginPath()
      ctx.arc(px, py, preview.revengeRadius, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.restore()
  }

  // Labels
  ctx.fillStyle = preview.color
  ctx.font = '11px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('PREVIEW', sx, sy - preview.radius - (preview.immovable ? 16 : 8))
  ctx.fillText(preview.name, sx, sy + preview.radius + 14)
  ctx.textAlign = 'left'
  ctx.globalAlpha = 1
}

// ── Ritual Nodes ──
function drawRitualNodeArcs(sx: number, sy: number, r: number, cr: number, cg: number, cb: number, alpha: number, lineW: number, spin: number, arcCount: number, gapRatio: number): void {
  const arcLen = (Math.PI * 2 / arcCount) * (1 - gapRatio)
  const gapLen = (Math.PI * 2 / arcCount) * gapRatio
  for (let a = 0; a < arcCount; a++) {
    const start = spin + a * (arcLen + gapLen)
    ctx.beginPath()
    ctx.arc(sx, sy, r, start, start + arcLen)
    ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`
    ctx.lineWidth = lineW
    ctx.stroke()
  }
}

function drawRitualNodes(): void {
  const groups = getRitualGroups()
  if (groups.length === 0) return
  const now = performance.now()

  for (const group of groups) {
    const activeIdx = getActiveIndex(group)
    const beatFrac = getLoopPosition() % 1

    // Base color: gold for shop, red for spawn
    const baseCr = group.type === 'shop' ? 255 : 255
    const baseCg = group.type === 'shop' ? 215 : 68
    const baseCb = group.type === 'shop' ? 64 : 68
    // Locked color: bright cyan-white
    const lockCr = 0, lockCg = 255, lockCb = 255

    for (let i = 0; i < group.nodes.length; i++) {
      const node = group.nodes[i]!
      const sx = node.x - camX
      const sy = node.y - camY
      const isActive = i === activeIdx && !group.completed
      const isLocked = node.state === 'locked'
      const spin = now / 1500 + i * 2
      const cr = isLocked ? lockCr : baseCr
      const cg = isLocked ? lockCg : baseCg
      const cb = isLocked ? lockCb : baseCb

      // Base fill — dark tinted circle always visible
      const baseAlpha = isLocked ? 0.2 : isActive ? 0.12 : 0.06
      ctx.beginPath()
      ctx.arc(sx, sy, node.radius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${baseAlpha})`
      ctx.fill()
      // Dark border for contrast against any background
      ctx.beginPath()
      ctx.arc(sx, sy, node.radius, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(0, 0, 0, ${isLocked ? 0.4 : 0.25})`
      ctx.lineWidth = isLocked ? 3 : 2
      ctx.stroke()

      if (isLocked) {
        // Locked — pulsing energy core with counter-rotating arcs
        const lockPulse = 0.5 + 0.5 * Math.sin(now / 300)
        const lockSpin = now / 600

        // Outer ring — bright, breathing, thick
        ctx.beginPath()
        ctx.arc(sx, sy, node.radius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.7 + lockPulse * 0.3})`
        ctx.lineWidth = 4.5 + lockPulse * 1.5
        ctx.stroke()

        // Counter-rotating inner arcs
        drawRitualNodeArcs(sx, sy, node.radius * 0.65, cr, cg, cb, 0.4 + lockPulse * 0.2, 2, -lockSpin, 2, 0.4)

        // Inner glow — brighter
        const glowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, node.radius)
        glowGrad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${0.3 + lockPulse * 0.15})`)
        glowGrad.addColorStop(0.6, `rgba(${cr}, ${cg}, ${cb}, 0.1)`)
        glowGrad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`)
        ctx.beginPath()
        ctx.arc(sx, sy, node.radius, 0, Math.PI * 2)
        ctx.fillStyle = glowGrad
        ctx.fill()

        // Bright center dot
        ctx.beginPath()
        ctx.arc(sx, sy, 4 + lockPulse * 2, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + lockPulse * 0.3})`
        ctx.fill()
        // Lock flash + particle burst
        if (node.lockFlash > 0) {
          const f = node.lockFlash / 0.3
          ctx.beginPath()
          ctx.arc(sx, sy, node.radius, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(255, 255, 255, ${f * 0.6})`
          ctx.fill()
          // Expanding shockwave ring — double ring
          const shockR = node.radius + (1 - f) * 50
          ctx.beginPath()
          ctx.arc(sx, sy, shockR, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${f * 0.6})`
          ctx.lineWidth = 4 * f
          ctx.stroke()
          // Second inner shockwave
          const shockR2 = node.radius + (1 - f) * 25
          ctx.beginPath()
          ctx.arc(sx, sy, shockR2, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(255, 255, 255, ${f * 0.4})`
          ctx.lineWidth = 2 * f
          ctx.stroke()
          // Particle burst on first frame
          if (node.lockFlash > 0.28) {
            for (let p = 0; p < 14; p++) {
              const a = (p / 14) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
              const speed = 400 + Math.random() * 350
              spawnParticle(node.x, node.y,
                Math.cos(a) * speed, Math.sin(a) * speed,
                cr, cg, cb, 0.25 + Math.random() * 0.15, 4 + Math.random() * 3)
            }
            // White core sparks
            for (let p = 0; p < 6; p++) {
              const a = Math.random() * Math.PI * 2
              const speed = 500 + Math.random() * 300
              spawnParticle(node.x, node.y,
                Math.cos(a) * speed, Math.sin(a) * speed,
                255, 255, 255, 0.2 + Math.random() * 0.15, 2.5 + Math.random() * 2)
            }
          }
        }
      } else if (isActive) {
        // Active — bright spinning arcs, strong beat flash
        const flash = Math.max(0, 1 - beatFrac * 2.5)
        const activeSpin = now / 800 + i * 2

        // Outer glow halo
        ctx.beginPath()
        ctx.arc(sx, sy, node.radius + 6 + flash * 4, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.04 + flash * 0.08})`
        ctx.fill()

        // Inner glow — bright
        const glowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, node.radius)
        glowGrad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, ${0.2 + flash * 0.3})`)
        glowGrad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`)
        ctx.beginPath()
        ctx.arc(sx, sy, node.radius, 0, Math.PI * 2)
        ctx.fillStyle = glowGrad
        ctx.fill()

        // Spinning arcs — brighter, thicker
        drawRitualNodeArcs(sx, sy, node.radius, cr, cg, cb, 0.6 + flash * 0.4, 4.5 + flash * 2.5, activeSpin, 3, 0.3)

        // Center dot — bigger, brighter
        ctx.beginPath()
        ctx.arc(sx, sy, 4 + flash * 3, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.6 + flash * 0.4})`
        ctx.fill()
        // White hot center on beat
        if (flash > 0.3) {
          ctx.beginPath()
          ctx.arc(sx, sy, 2 + flash * 2, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(255, 255, 255, ${flash * 0.5})`
          ctx.fill()
        }
      } else {
        // Idle — slow spinning arcs
        drawRitualNodeArcs(sx, sy, node.radius, cr, cg, cb, 0.2, 1.5, spin, 3, 0.35)
        // Center dot
        ctx.beginPath()
        ctx.arc(sx, sy, 3, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.2)`
        ctx.fill()
        // Inner ring
        drawRitualNodeArcs(sx, sy, node.radius * 0.5, cr, cg, cb, 0.08, 1, -spin * 0.7, 2, 0.5)
      }
    }

    // Lightning between active→next AND locked connections
    const drawPlasmaBeam = (fx: number, fy: number, tx: number, ty: number, intensity: number, pr = baseCr, pg = baseCg, pb = baseCb) => {
      const ldx = tx - fx, ldy = ty - fy
      const lDist = Math.sqrt(ldx * ldx + ldy * ldy)
      if (lDist < 1) return
      const lpx = -ldy / lDist, lpy = ldx / lDist
      const segs = 24
      const time = now / 1000

      // Build smooth flowing points — two overlapping sine waves
      const pts: { x: number; y: number }[] = []
      for (let s = 0; s <= segs; s++) {
        const st = s / segs
        // Taper wave amplitude at endpoints
        const taper = Math.sin(st * Math.PI)
        const wave1 = Math.sin(st * Math.PI * 5 - time * 4) * 6 * taper
        const wave2 = Math.sin(st * Math.PI * 3 + time * 2.5) * 4 * taper
        const wave = (wave1 + wave2) * intensity
        pts.push({ x: fx + ldx * st + lpx * wave, y: fy + ldy * st + lpy * wave })
      }

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'

      // Wide outer glow
      ctx.beginPath()
      for (let s = 0; s < pts.length; s++) {
        if (s === 0) ctx.moveTo(pts[s]!.x, pts[s]!.y)
        else ctx.lineTo(pts[s]!.x, pts[s]!.y)
      }
      ctx.strokeStyle = `rgba(${pr}, ${pg}, ${pb}, ${0.12 * intensity})`
      ctx.lineWidth = 28 * intensity
      ctx.stroke()

      // Core beam
      ctx.beginPath()
      for (let s = 0; s < pts.length; s++) {
        if (s === 0) ctx.moveTo(pts[s]!.x, pts[s]!.y)
        else ctx.lineTo(pts[s]!.x, pts[s]!.y)
      }
      ctx.strokeStyle = `rgba(${pr}, ${pg}, ${pb}, ${0.45 * intensity})`
      ctx.lineWidth = 9 * intensity
      ctx.stroke()

      // White-hot center
      ctx.beginPath()
      for (let s = 0; s < pts.length; s++) {
        if (s === 0) ctx.moveTo(pts[s]!.x, pts[s]!.y)
        else ctx.lineTo(pts[s]!.x, pts[s]!.y)
      }
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.4 * intensity})`
      ctx.lineWidth = 3
      ctx.stroke()

      ctx.lineCap = 'butt'
      ctx.lineJoin = 'miter'
    }

    // Active → next plasma (only after first hit, pulses on beat)
    if (!group.completed && group.progress > 0) {
      const fromNode = group.nodes[activeIdx]!
      const toNode = group.nodes[(activeIdx + 1) % group.nodes.length]!
      const beatPulse = Math.max(0, 1 - beatFrac * 2.5)
      drawPlasmaBeam(
        fromNode.x - camX, fromNode.y - camY,
        toNode.x - camX, toNode.y - camY,
        0.3 + beatPulse * 0.7
      )
    }

    // Locked connection plasma (pulses on beat too)
    if (group.progress > 0) {
      const beatPulse = Math.max(0, 1 - beatFrac * 2.5)
      const connCount = group.completed ? group.nodes.length : group.progress
      for (let j = 0; j < connCount; j++) {
        const fromIdx2 = (group.startOffset + j) % group.nodes.length
        const toIdx2 = (group.startOffset + j + 1) % group.nodes.length
        const from2 = group.nodes[fromIdx2]!
        const to2 = group.nodes[toIdx2]!
        drawPlasmaBeam(from2.x - camX, from2.y - camY, to2.x - camX, to2.y - camY, 0.6 + beatPulse * 0.4, lockCr, lockCg, lockCb)
      }
    }

    // Completion flash — all nodes bright + converge particles
    if (group.completed && group.completionTimer > 0) {
      const ct = group.completionTimer / 0.5
      // Flash all nodes white
      for (const node of group.nodes) {
        const nsx = node.x - camX
        const nsy = node.y - camY
        ctx.beginPath()
        ctx.arc(nsx, nsy, node.radius + (1 - ct) * 10, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${ct * 0.3})`
        ctx.fill()
      }
      // Converge particles to center on first frame
      if (group.completionTimer > 0.48) {
        const cx = group.nodes.reduce((s, n) => s + n.x, 0) / group.nodes.length
        const cy = group.nodes.reduce((s, n) => s + n.y, 0) / group.nodes.length
        for (const node of group.nodes) {
          const dx = cx - node.x, dy = cy - node.y
          const dist = Math.sqrt(dx * dx + dy * dy)
          const nx = dist > 1 ? dx / dist : 0
          const ny = dist > 1 ? dy / dist : 0
          // Colored converge
          for (let p = 0; p < 18; p++) {
            const speed = 200 + Math.random() * 180
            spawnParticle(node.x, node.y,
              nx * speed + (Math.random() - 0.5) * 50,
              ny * speed + (Math.random() - 0.5) * 50,
              lockCr, lockCg, lockCb, 0.3 + Math.random() * 0.2, 5 + Math.random() * 4)
          }
          // White hot converge
          for (let p = 0; p < 8; p++) {
            const speed = 250 + Math.random() * 200
            spawnParticle(node.x, node.y,
              nx * speed + (Math.random() - 0.5) * 30,
              ny * speed + (Math.random() - 0.5) * 30,
              255, 255, 255, 0.25 + Math.random() * 0.2, 3 + Math.random() * 3)
          }
        }
        // Center burst outward after converge
        for (let p = 0; p < 25; p++) {
          const a = (p / 25) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
          const speed = 150 + Math.random() * 200
          spawnParticle(cx, cy,
            Math.cos(a) * speed, Math.sin(a) * speed,
            255, 255, 255, 0.2 + Math.random() * 0.15, 4 + Math.random() * 3)
        }
      }
    }
  }
}

// Ritual node overlays — spinning arcs on top of enemies so always visible
function drawRitualNodeOverlays(): void {
  const groups = getRitualGroups()
  if (groups.length === 0) return
  const now = performance.now()

  for (const group of groups) {
    const activeIdx = getActiveIndex(group)
    const beatFrac = getLoopPosition() % 1

    const cr = group.type === 'shop' ? 255 : 255
    const cg = group.type === 'shop' ? 215 : 68
    const cb = group.type === 'shop' ? 64 : 68

    for (let i = 0; i < group.nodes.length; i++) {
      const node = group.nodes[i]!
      const sx = node.x - camX
      const sy = node.y - camY
      const isActive = i === activeIdx && !group.completed
      const isLocked = node.state === 'locked'

      if (isLocked) {
        ctx.beginPath()
        ctx.arc(sx, sy, node.radius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.35)`
        ctx.lineWidth = 1.5
        ctx.stroke()
      } else if (isActive) {
        const flash = Math.max(0, 1 - beatFrac * 3)
        const spin = now / 800 + i * 2
        drawRitualNodeArcs(sx, sy, node.radius, cr, cg, cb, 0.2 + flash * 0.3, 1.5, spin, 3, 0.3)
      } else {
        const spin = now / 1500 + i * 2
        drawRitualNodeArcs(sx, sy, node.radius, cr, cg, cb, 0.06, 1, spin, 3, 0.35)
      }
    }
  }
}

// ── Title Screen ──
export function drawTitleScreen(dt: number): void {
  titleTime += dt

  // Beat pulse — fires at ring peak (0.45 into each beat), not beat start
  const now = performance.now() / 1000
  const loopPos = getLoopPosition()
  const beatPhase = loopPos % 1
  const peakPoint = 0.45  // matches ATTACK_EXPAND_TIME
  const currentBeat = Math.floor(loopPos)
  const pastPeakThisBeat = beatPhase >= peakPoint
  const beatId = currentBeat * 2 + (pastPeakThisBeat ? 1 : 0)
  if (beatId !== titleLastBeat && titleLastBeat >= 0 && pastPeakThisBeat) {
    titleBeatPulse = 1
  }
  titleLastBeat = beatId
  titleBeatPulse = Math.max(0, titleBeatPulse - dt * 3)

  // Background
  ctx.fillStyle = COLOR_BG
  ctx.fillRect(0, 0, width, height)

  // Subtle grid
  const gridAlpha = 0.03 + titleBeatPulse * 0.02
  ctx.strokeStyle = `rgba(100, 130, 200, ${gridAlpha})`
  ctx.lineWidth = 0.5
  const gridSize = 40
  for (let x = 0; x < width; x += gridSize) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = 0; y < height; y += gridSize) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }

  // Ring attack animation — matches gameplay ring expand + red flash + particles
  const rcx = width / 2, rcy = height / 2 - 20
  const beatCycle = beatPhase
  const ringMaxR = 220
  const expandTime = 0.45  // matches ATTACK_EXPAND_TIME
  const totalTime = 1.0    // one beat
  const buildup = Math.min(beatCycle / expandTime, 1)
  const expansion = buildup < 1 ? 1 - (1 - buildup) * (1 - buildup) : 1  // ease-out
  const ringR = ringMaxR * expansion
  const pastPeak = beatCycle - expandTime

  if (ringR > 5 && pastPeak < 0.35) {
    // Buildup ring — cyan, thickens, fades after peak
    const fadeAfter = pastPeak > 0 ? Math.max(0, 1 - pastPeak / 0.3) : 1
    const alpha = (0.06 + 0.12 * buildup * buildup) * fadeAfter
    ctx.beginPath()
    ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(0, 255, 255, ${alpha})`
    ctx.lineWidth = 1.5 + 2.5 * buildup
    ctx.stroke()

    // Red flash at peak
    if (pastPeak >= 0 && pastPeak < 0.2) {
      const redT = 1 - pastPeak / 0.2
      // Wide glow
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 100, 100, ${redT * 0.08})`
      ctx.lineWidth = 20
      ctx.stroke()
      // Soft red
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 80, 80, ${redT * 0.18})`
      ctx.lineWidth = 8
      ctx.stroke()
      // Sharp red core
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 80, 80, ${redT * 0.5})`
      ctx.lineWidth = 3
      ctx.stroke()
    }

    // Explosion particles at peak — first frame only
    if (pastPeak >= 0 && pastPeak < 0.02) {
      const worldCx = rcx + camX  // convert screen → world for particle system
      const worldCy = rcy + camY
      const count = 25
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
        const px = worldCx + Math.cos(angle) * ringR
        const py = worldCy + Math.sin(angle) * ringR
        const isWhite = i % 3 === 0
        const sp = (isWhite ? 25 : 18) * (0.5 + Math.random())
        const vx = Math.cos(angle) * sp + (Math.random() - 0.5) * sp * 0.7
        const vy = Math.sin(angle) * sp + (Math.random() - 0.5) * sp * 0.7
        spawnParticle(px, py, vx, vy,
          isWhite ? 255 : 0, isWhite ? 255 : 255, 255,
          (isWhite ? 0.5 : 0.6) * (0.8 + Math.random() * 0.2),
          (isWhite ? 8 : 7) * 1.1)
      }
    }

  }

  // Second ring — magenta, same style as cyan ring, offset by half beat
  const beat2Cycle = (loopPos + 0.5) % 1
  const buildup2 = Math.min(beat2Cycle / expandTime, 1)
  const expansion2 = buildup2 < 1 ? 1 - (1 - buildup2) * (1 - buildup2) : 1
  const ring2MaxR = ringMaxR * 0.75
  const ring2R = ring2MaxR * expansion2
  const pastPeak2 = beat2Cycle - expandTime

  if (ring2R > 5 && pastPeak2 < 0.35) {
    // Buildup ring — fades after peak
    const fadeAfter2 = pastPeak2 > 0 ? Math.max(0, 1 - pastPeak2 / 0.3) : 1
    const alpha2 = (0.08 + 0.15 * buildup2 * buildup2) * fadeAfter2
    ctx.beginPath()
    ctx.arc(rcx, rcy, ring2R, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 50, 200, ${alpha2})`
    ctx.lineWidth = 1.5 + 2.5 * buildup2
    ctx.stroke()

    // Flash at peak
    if (pastPeak2 >= 0 && pastPeak2 < 0.2) {
      const redT2 = 1 - pastPeak2 / 0.2
      ctx.beginPath()
      ctx.arc(rcx, rcy, ring2R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 100, 150, ${redT2 * 0.1})`
      ctx.lineWidth = 18
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ring2R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 80, 150, ${redT2 * 0.2})`
      ctx.lineWidth = 7
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ring2R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 80, 180, ${redT2 * 0.5})`
      ctx.lineWidth = 3
      ctx.stroke()
    }

    // Explosion particles at peak
    if (pastPeak2 >= 0 && pastPeak2 < 0.02) {
      const worldCx2 = rcx + camX
      const worldCy2 = rcy + camY
      for (let i = 0; i < 18; i++) {
        const angle = (i / 18) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
        const px = worldCx2 + Math.cos(angle) * ring2R
        const py = worldCy2 + Math.sin(angle) * ring2R
        const isWhite = i % 4 === 0
        const sp = (isWhite ? 22 : 16) * (0.5 + Math.random())
        const vx = Math.cos(angle) * sp + (Math.random() - 0.5) * sp * 0.7
        const vy = Math.sin(angle) * sp + (Math.random() - 0.5) * sp * 0.7
        spawnParticle(px, py, vx, vy,
          isWhite ? 255 : 255, isWhite ? 255 : 50, isWhite ? 255 : 200,
          (isWhite ? 0.5 : 0.6) * (0.8 + Math.random() * 0.2),
          (isWhite ? 7 : 6) * 1.1)
      }
    }

  }

  // Vignette
  const vigGrad = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 0.8)
  vigGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vigGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)')
  ctx.fillStyle = vigGrad
  ctx.fillRect(0, 0, width, height)

  const cx = width / 2
  const titleY = height * 0.44

  // Title — "BEATBACK"
  const letters = 'BEATBACK'
  const letterSpacing = 76
  const totalW = (letters.length - 1) * letterSpacing
  const startX = cx - totalW / 2

  for (let i = 0; i < letters.length; i++) {
    const lx = startX + i * letterSpacing
    const beatBounce = -titleBeatPulse * 8

    // Letter glow
    const glowPulse = 0.5 + 0.5 * Math.sin(now * 1.2 + i * 0.7)
    const isCyan = i < 4  // BEAT = cyan, BACK = magenta
    const gr = isCyan ? 0 : 255
    const gg = isCyan ? 255 : 50
    const gb = isCyan ? 255 : 200

    // Glow behind letter
    ctx.font = 'bold 96px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = `rgba(${gr}, ${gg}, ${gb}, ${0.15 + glowPulse * 0.1 + titleBeatPulse * 0.15})`
    ctx.fillText(letters[i]!, lx, titleY + beatBounce)

    // Main letter
    ctx.fillStyle = `rgba(${gr}, ${gg}, ${gb}, ${0.85 + titleBeatPulse * 0.15})`
    ctx.fillText(letters[i]!, lx, titleY + beatBounce)

    // White highlight on beat
    if (titleBeatPulse > 0.3) {
      ctx.fillStyle = `rgba(255, 255, 255, ${titleBeatPulse * 0.3})`
      ctx.fillText(letters[i]!, lx, titleY + beatBounce)
    }
  }

  // Start button
  const btnY = height * 0.52
  const btnW = 200
  const btnH = 50
  const btnPulse = 0.5 + 0.5 * Math.sin(now * 3)
  const btnBeat = titleBeatPulse

  // Start button hover
  const startHov = pauseMouseX >= cx - btnW / 2 && pauseMouseX <= cx + btnW / 2 && pauseMouseY >= btnY && pauseMouseY <= btnY + btnH
  const hovB = startHov ? 0.15 : 0

  // Button glow
  ctx.beginPath()
  ctx.roundRect(cx - btnW / 2 - 4, btnY - 4, btnW + 8, btnH + 8, 8)
  ctx.fillStyle = `rgba(0, 255, 255, ${0.03 + btnBeat * 0.06 + hovB})`
  ctx.fill()

  // Button border
  ctx.beginPath()
  ctx.roundRect(cx - btnW / 2, btnY, btnW, btnH, 6)
  ctx.strokeStyle = `rgba(0, 255, 255, ${0.4 + btnPulse * 0.2 + btnBeat * 0.3 + hovB * 2})`
  ctx.lineWidth = 2 + btnBeat + (startHov ? 1 : 0)
  ctx.stroke()

  // Button fill
  ctx.fillStyle = `rgba(0, 255, 255, ${0.06 + btnBeat * 0.08 + hovB})`
  ctx.fill()

  // Button text
  ctx.font = 'bold 26px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = `rgba(0, 255, 255, ${0.7 + btnPulse * 0.15 + btnBeat * 0.15 + hovB})`
  ctx.fillText('S T A R T', cx, btnY + btnH / 2 + 7)

  // Fullscreen button
  const fsY = btnY + btnH + 160
  const fsW = 240
  const fsH = 50
  const fsHov = pauseMouseX >= cx - fsW / 2 && pauseMouseX <= cx + fsW / 2 && pauseMouseY >= fsY && pauseMouseY <= fsY + fsH
  ctx.beginPath()
  ctx.roundRect(cx - fsW / 2, fsY, fsW, fsH, 5)
  ctx.strokeStyle = `rgba(255, 50, 200, ${fsHov ? 0.65 : 0.35})`
  ctx.lineWidth = fsHov ? 2.5 : 1.5
  ctx.stroke()
  ctx.fillStyle = `rgba(255, 50, 200, ${fsHov ? 0.18 : 0.06})`
  ctx.fill()
  ctx.font = 'bold 22px monospace'
  ctx.fillStyle = `rgba(255, 50, 200, ${fsHov ? 0.95 : 0.7})`
  ctx.fillText(document.fullscreenElement ? 'WINDOWED' : 'FULLSCREEN', cx, fsY + fsH / 2 + 7)

  // Volume slider
  const volSliderW = 180
  const volRect = drawVolumeSlider(cx - volSliderW / 2, fsY + fsH + 30, volSliderW)
  volumeSliderRect = volRect

  ctx.textAlign = 'left'

  // Update + draw particles on title screen
  updateParticles(dt)
  drawParticles()
}

// ── Challenge Select Screen ──
let challengeSelectScroll = 0
let victoryScroll = 0
let victoryScrollbarRect: { x: number; y: number; w: number; h: number; thumbH: number; maxScroll: number } | null = null
let victoryScrollDragging = false
let victoryAutoScrolled = false
let lastSubmittedName = ''
let lastSubmittedTime = 0
let lastProjectedRank = 0
let lastDisplayedBeatCount = -1
let timerFlash = 0

// Controls hint — shows at challenge start, fades out
let controlsHintTimer = 0
const CONTROLS_HINT_DURATION = 3.5  // seconds visible
const CONTROLS_HINT_FADE = 1.0      // seconds to fade out

export function showControlsHint(): void {
  controlsHintTimer = CONTROLS_HINT_DURATION + CONTROLS_HINT_FADE
}
let challengeSelectHover = -1

export function getChallengeSelectHover(): number { return challengeSelectHover }
export function getNameEntryText(): string { return nameEntryText }
export function setNameEntryText(t: string): void { nameEntryText = t }
export function resetNameEntry(): void { nameEntryText = '' }
export function scrollVictoryLeaderboard(delta: number): void { victoryScroll += delta }
export function resetVictoryScroll(): void { victoryScroll = 0; victoryAutoScrolled = false; lastSubmittedName = ''; lastSubmittedTime = 0; lastProjectedRank = 0 }
export function setLastSubmittedTime(t: number): void { lastSubmittedTime = t }
export function setLastSubmittedName(name: string): void { lastSubmittedName = name }
export function handleVictoryScrollDragStart(mx: number, my: number): boolean {
  if (!victoryScrollbarRect) return false
  const r = victoryScrollbarRect
  if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) {
    victoryScrollDragging = true
    return true
  }
  return false
}
export function handleVictoryScrollDrag(my: number): void {
  if (!victoryScrollDragging || !victoryScrollbarRect) return
  const r = victoryScrollbarRect
  const trackRange = r.h - r.thumbH
  const relY = Math.max(0, Math.min(my - r.y - r.thumbH / 2, trackRange))
  victoryScroll = (relY / trackRange) * r.maxScroll
}
export function handleVictoryScrollDragEnd(): void { victoryScrollDragging = false }

export function drawChallengeSelect(dt: number): void {
  const now = performance.now() / 1000
  const challenges = getChallenges()

  // Background
  ctx.fillStyle = COLOR_BG
  ctx.fillRect(0, 0, width, height)

  // Subtle grid
  ctx.strokeStyle = 'rgba(100, 130, 200, 0.03)'
  ctx.lineWidth = 0.5
  for (let x = 0; x < width; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke()
  }
  for (let y = 0; y < height; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke()
  }

  // Vignette
  const vigGrad = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 0.8)
  vigGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vigGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)')
  ctx.fillStyle = vigGrad
  ctx.fillRect(0, 0, width, height)

  const cx = width / 2

  // Title
  ctx.font = 'bold 48px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(0, 255, 255, 0.9)'
  ctx.fillText('SELECT CHALLENGE', cx, 70)

  // Back button — top-left
  const backW = 160
  const backH = 56
  const backX = 20
  const backY = 18
  const backHov = pauseMouseX >= backX && pauseMouseX <= backX + backW && pauseMouseY >= backY && pauseMouseY <= backY + backH
  ctx.beginPath()
  ctx.roundRect(backX, backY, backW, backH, 10)
  ctx.strokeStyle = `rgba(0, 255, 255, ${backHov ? 0.7 : 0.35})`
  ctx.lineWidth = backHov ? 2.5 : 1.5
  ctx.stroke()
  ctx.fillStyle = `rgba(0, 255, 255, ${backHov ? 0.15 : 0.06})`
  ctx.fill()
  ctx.font = 'bold 24px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = `rgba(0, 255, 255, ${backHov ? 0.95 : 0.7})`
  ctx.fillText('\u2190 BACK', backX + backW / 2, backY + backH / 2 + 8)

  if (challenges.length === 0) {
    ctx.font = '24px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.fillText('No challenges created yet', cx, height / 2)
    ctx.font = '16px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'
    ctx.fillText('Open Workshop (Tab) to create one', cx, height / 2 + 35)
    ctx.textAlign = 'left'
    return
  }

  // Challenge cards
  const cardW = 560
  const cardH = 228
  const cardGap = 22
  const startY = 120
  const cols = Math.max(1, Math.floor((width - 80) / (cardW + cardGap)))
  const gridW = cols * cardW + (cols - 1) * cardGap
  const gridX = (width - gridW) / 2

  for (let i = 0; i < challenges.length; i++) {
    const ch = challenges[i]!
    const col = i % cols
    const row = Math.floor(i / cols)
    const cardX = gridX + col * (cardW + cardGap)
    const cardY = startY + row * (cardH + cardGap) - challengeSelectScroll
    if (cardY + cardH < 0 || cardY > height) continue

    const isHover = challengeSelectHover === i
    const pulse = isHover ? 0.5 + 0.5 * Math.sin(now * 4) : 0

    // Card bg
    ctx.beginPath()
    ctx.roundRect(cardX, cardY, cardW, cardH, 8)
    ctx.fillStyle = isHover ? 'rgba(0, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.04)'
    ctx.fill()
    ctx.strokeStyle = isHover ? `rgba(0, 255, 255, ${0.4 + pulse * 0.3})` : 'rgba(255, 255, 255, 0.12)'
    ctx.lineWidth = isHover ? 2 : 1
    ctx.stroke()

    // Challenge name
    ctx.font = 'bold 30px monospace'
    ctx.textAlign = 'left'
    ctx.fillStyle = isHover ? 'rgba(0, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.85)'
    ctx.fillText(ch.name, cardX + 24, cardY + 38)

    // Play hint on hover
    if (isHover) {
      ctx.font = 'bold 22px monospace'
      ctx.textAlign = 'right'
      ctx.fillStyle = `rgba(0, 255, 255, ${0.6 + pulse * 0.3})`
      ctx.fillText('PLAY ▶', cardX + cardW - 24, cardY + 36)
      ctx.textAlign = 'left'
    }

    // Top scores header
    ctx.font = 'bold 18px monospace'
    ctx.fillStyle = 'rgba(0, 255, 255, 0.5)'
    ctx.fillText('TOP SCORES', cardX + 24, cardY + 66)

    // Top 5 scores
    const top5 = getScoresForChallenge(ch.name, 5)
    const medalColors = ['rgba(255, 215, 64, 0.75)', 'rgba(120, 220, 255, 0.65)', 'rgba(255, 160, 80, 0.6)']
    for (let s = 0; s < 5; s++) {
      const scoreY = cardY + 94 + s * 24
      if (s < top5.length) {
        const sc = top5[s]!
        ctx.font = 'bold 16px monospace'
        ctx.textAlign = 'left'
        ctx.fillStyle = s < 3 ? medalColors[s]! : 'rgba(255, 255, 255, 0.45)'
        ctx.fillText(`${s + 1}.`, cardX + 24, scoreY)
        ctx.fillText(sc.playerName, cardX + 50, scoreY)
        ctx.textAlign = 'right'
        ctx.fillText(formatTime(sc.time), cardX + cardW - 24, scoreY)
        ctx.textAlign = 'left'
      } else {
        ctx.font = '16px monospace'
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
        ctx.fillText(`${s + 1}.  ---`, cardX + 24, scoreY)
      }
    }
  }

  ctx.textAlign = 'left'
}

export function handleChallengeSelectClick(mx: number, my: number): Challenge | null {
  const challenges = getChallenges()
  const cardW = 560, cardH = 180, cardGap = 22, startY = 120
  const cols = Math.max(1, Math.floor((width - 80) / (cardW + cardGap)))
  const gridW = cols * cardW + (cols - 1) * cardGap
  const gridX = (width - gridW) / 2

  for (let i = 0; i < challenges.length; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cardX = gridX + col * (cardW + cardGap)
    const cardY = startY + row * (cardH + cardGap) - challengeSelectScroll
    if (mx >= cardX && mx <= cardX + cardW && my >= cardY && my <= cardY + cardH) {
      return challenges[i]!
    }
  }
  return null
}

export function handleChallengeSelectHover(mx: number, my: number): void {
  const challenges = getChallenges()
  const cardW = 560, cardH = 180, cardGap = 22, startY = 120
  const cols = Math.max(1, Math.floor((width - 80) / (cardW + cardGap)))
  const gridW = cols * cardW + (cols - 1) * cardGap
  const gridX = (width - gridW) / 2

  challengeSelectHover = -1
  for (let i = 0; i < challenges.length; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cardX = gridX + col * (cardW + cardGap)
    const cardY = startY + row * (cardH + cardGap) - challengeSelectScroll
    if (mx >= cardX && mx <= cardX + cardW && my >= cardY && my <= cardY + cardH) {
      challengeSelectHover = i
      break
    }
  }
}

// Store panel button rects for click detection
const spawnPanelRects: { x: number; y: number; w: number; h: number; typeIndex: number }[] = []

export function getSpawnPanelClick(mx: number, my: number): number {
  for (const rect of spawnPanelRects) {
    if (mx >= rect.x && mx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h) {
      return rect.typeIndex
    }
  }
  return -1
}

function drawSpawnPanel(): void {
  const panelX = 10
  const panelY = 10
  const boxW = 140
  const boxH = 32
  const gap = 4

  spawnPanelRects.length = 0

  ctx.fillStyle = 'rgba(13, 10, 26, 0.85)'
  ctx.fillRect(panelX - 4, panelY - 4, boxW + 8, (boxH + gap) * ENEMY_TYPES.length + 8)

  ctx.font = '11px monospace'
  for (let i = 0; i < ENEMY_TYPES.length; i++) {
    const t = ENEMY_TYPES[i]!
    const y = panelY + i * (boxH + gap)

    spawnPanelRects.push({ x: panelX, y, w: boxW, h: boxH, typeIndex: i })

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
    ctx.fillRect(panelX, y, boxW, boxH)

    ctx.fillStyle = t.color
    ctx.fillRect(panelX, y, 4, boxH)

    ctx.fillStyle = t.color
    ctx.globalAlpha = 0.8
    ctx.fillRect(panelX + 8, y + 6, 20, 20)
    ctx.globalAlpha = 1.0
    ctx.fillStyle = '#0D0A1A'
    ctx.font = 'bold 13px monospace'
    ctx.fillText(t.key, panelX + 14, y + 21)

    ctx.fillStyle = t.color
    ctx.font = '11px monospace'
    ctx.fillText(`${t.name}`, panelX + 34, y + 15)
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '10px monospace'
    ctx.fillText(t.role, panelX + 34, y + 27)
  }
}

function drawChallengePlacements(): void {
  if (!isPlaceMode()) return
  const placements = getPlacingEnemies()
  const selected = getSelectedPlacement()
  for (let i = 0; i < placements.length; i++) {
    const e = placements[i]!
    const type = ENEMY_TYPES.find(t => t.name === e.typeName)
    const r = type?.radius ?? 40
    const sx = e.x - camX
    const sy = e.y - camY
    const isSelected = i === selected
    const hr = parseInt((type?.color ?? '#888888').slice(1, 3), 16)
    const hg = parseInt((type?.color ?? '#888888').slice(3, 5), 16)
    const hb = parseInt((type?.color ?? '#888888').slice(5, 7), 16)

    // Ghost body
    ctx.globalAlpha = 0.5
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.3)`
    ctx.fill()
    ctx.strokeStyle = isSelected ? '#FFD740' : `rgba(${hr}, ${hg}, ${hb}, 0.6)`
    ctx.lineWidth = isSelected ? 3 : 2
    ctx.setLineDash(isSelected ? [] : [4, 4])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // Name label
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = isSelected ? '#FFD740' : 'rgba(255,255,255,0.5)'
    ctx.fillText(e.typeName, sx, sy + r + 12)
    ctx.textAlign = 'left'
  }
}

function drawHUD(player: Player, enemies: Enemy[], fps: number): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
  ctx.font = '12px monospace'
  const x = width - 200
  const pat = getPattern()
  const loopPos = getLoopPosition()
  const loopLen = getLoopLength()
  if (__DEV__) {
    ctx.fillText(`FPS: ${fps}`, x, 20)
    ctx.fillText(`HP: ${player.hp}/${player.maxHp}`, x, 36)
    ctx.fillText(`Enemies: ${enemies.filter(e => e.alive).length}`, x, 52)
    ctx.fillText(`XP: ${player.xp}`, x, 68)
    ctx.fillText(`Beat: ${getBeatName()} | Song: ${pat?.name ?? 'none'} [${loopPos.toFixed(1)}/${loopLen}]`, x - 80, 84)
    ctx.fillText(`WASD=move  LMB=dash  Tab=designer  F1-F11=beats`, 10, height - 12)
    ctx.fillText(`1-5=spawn  0=spawn 100`, 10, height - 28)
  }

  // Run timer — top center
  if (isRunTimerActive() || isRunComplete()) {
    const total = isRunComplete() ? Math.ceil(getRunFinalTime()) : getRunBeatCount()
    // Detect beat change for hard flash
    if (total !== lastDisplayedBeatCount && lastDisplayedBeatCount >= 0) {
      timerFlash = 1
    }
    lastDisplayedBeatCount = total
    timerFlash = Math.max(0, timerFlash - frameDt * 5)

    const mins = Math.floor(total / 60)
    const secs = total % 60
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`
    const timerSize = 56 + timerFlash * 16
    ctx.font = `bold ${Math.round(timerSize)}px monospace`
    ctx.textAlign = 'center'
    const pulseAlpha = isRunComplete() ? 0.95 : 0.6 + timerFlash * 0.4
    ctx.fillStyle = isRunComplete() ? `rgba(100, 255, 160, ${pulseAlpha})` : `rgba(0, 255, 255, ${pulseAlpha})`
    ctx.fillText(timeStr, width / 2, 70)
    // Bright flash overlay on beat
    if (timerFlash > 0.5) {
      ctx.fillStyle = `rgba(255, 255, 255, ${(timerFlash - 0.5) * 0.5})`
      ctx.fillText(timeStr, width / 2, 70)
    }
    ctx.textAlign = 'left'
  }

  // Controls hint
  if (controlsHintTimer > 0) {
    controlsHintTimer -= frameDt
    const alpha = controlsHintTimer <= CONTROLS_HINT_FADE
      ? Math.max(0, controlsHintTimer / CONTROLS_HINT_FADE)
      : 1
    ctx.save()
    const cx = width / 2
    const a = alpha

    if (isTouchMode()) {
      // Touch controls hint — joystick graphic + tap instruction
      const hintY = height / 2 + 160

      // Joystick icon — small circle with inner dot
      const joyR = 30
      ctx.beginPath()
      ctx.arc(cx, hintY, joyR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(0, 255, 255, ${(0.4 * a).toFixed(3)})`
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.2 * a).toFixed(3)})`
      ctx.fill()
      // Inner knob offset to show movement
      ctx.beginPath()
      ctx.arc(cx + 8, hintY - 5, 10, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.4 * a).toFixed(3)})`
      ctx.fill()

      // "DRAG TO MOVE" label
      ctx.font = 'bold 20px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.7 * a).toFixed(3)})`
      ctx.fillText('DRAG TO MOVE', cx, hintY + joyR + 28)

      // "TAP 2ND FINGER TO DASH" label
      ctx.font = 'bold 18px monospace'
      ctx.fillStyle = `rgba(255, 50, 200, ${(0.6 * a).toFixed(3)})`
      ctx.fillText('TAP 2ND FINGER = DASH', cx, hintY + joyR + 58)
    } else {
      // Keyboard controls hint — arrow keys + spacebar
      const keySize = 48
      const gap = 5
      const baseY = height / 2 + 200
      const keyColor = `rgba(255, 255, 255, ${(0.12 * a).toFixed(3)})`
      const borderColor = `rgba(0, 255, 255, ${(0.4 * a).toFixed(3)})`
      const arrowColor = `rgba(0, 255, 255, ${(0.85 * a).toFixed(3)})`

      const keys = [
        { x: cx, y: baseY - keySize - gap, arrow: '\u25B2' },
        { x: cx - keySize - gap, y: baseY, arrow: '\u25C0' },
        { x: cx, y: baseY, arrow: '\u25BC' },
        { x: cx + keySize + gap, y: baseY, arrow: '\u25B6' },
      ]

      ctx.font = 'bold 22px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const k of keys) {
        const kx = k.x - keySize / 2
        const ky = k.y - keySize / 2
        ctx.fillStyle = keyColor
        ctx.beginPath()
        ctx.roundRect(kx, ky, keySize, keySize, 6)
        ctx.fill()
        ctx.strokeStyle = borderColor
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.roundRect(kx, ky, keySize, keySize, 6)
        ctx.stroke()
        ctx.fillStyle = arrowColor
        ctx.fillText(k.arrow, k.x, k.y)
      }

      // Spacebar key
      const spaceY = baseY + keySize / 2 + gap + 18
      const spaceW = keySize * 3 + gap * 2 + 80
      const spaceH = 46
      const spaceX = cx - spaceW / 2
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.1 * a).toFixed(3)})`
      ctx.beginPath()
      ctx.roundRect(spaceX, spaceY, spaceW, spaceH, 6)
      ctx.fill()
      ctx.strokeStyle = `rgba(0, 255, 255, ${(0.45 * a).toFixed(3)})`
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(spaceX, spaceY, spaceW, spaceH, 6)
      ctx.stroke()
      ctx.font = 'bold 24px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.7 * a).toFixed(3)})`
      ctx.fillText('SPACE = DASH', cx, spaceY + spaceH / 2)
    }

    ctx.restore()
  }

  // Touch pause button — top-left, always visible in touch mode during gameplay
  if (isTouchMode() && getPhase() === 'playing' && !isRunComplete()) {
    const pbX = 14
    const pbY = 14
    const pbSize = 78
    ctx.beginPath()
    ctx.roundRect(pbX, pbY, pbSize, pbSize, 12)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 215, 64, 0.4)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    // Subtle yellow glow
    const pbCx = pbX + pbSize / 2
    const pbCy = pbY + pbSize / 2
    const pbGlow = ctx.createRadialGradient(pbCx, pbCy, pbSize * 0.3, pbCx, pbCy, pbSize * 0.8)
    pbGlow.addColorStop(0, 'rgba(255, 215, 64, 0.08)')
    pbGlow.addColorStop(1, 'rgba(255, 215, 64, 0)')
    ctx.beginPath()
    ctx.roundRect(pbX, pbY, pbSize, pbSize, 12)
    ctx.fillStyle = pbGlow
    ctx.fill()
    // Pause bars ‖
    const barW = 8
    const barH = 34
    const barGap = 11
    const barY = pbY + (pbSize - barH) / 2
    const barX = pbX + (pbSize - barW * 2 - barGap) / 2
    ctx.fillStyle = 'rgba(255, 215, 64, 0.7)'
    ctx.fillRect(barX, barY, barW, barH)
    ctx.fillRect(barX + barW + barGap, barY, barW, barH)
  }

  // Touch joystick overlay
  if (isTouchMode() && getPhase() === 'playing' && !isRunComplete()) {
    const js = getJoystickState()
    if (js.active) {
      const baseR = js.maxRadius
      const knobR = 41
      const dx = js.currentX - js.originX
      const dy = js.currentY - js.originY
      const dist = Math.sqrt(dx * dx + dy * dy)
      const clampedDist = Math.min(dist, baseR)
      const knobX = dist > 0 ? js.originX + (dx / dist) * clampedDist : js.originX
      const knobY = dist > 0 ? js.originY + (dy / dist) * clampedDist : js.originY

      const ox = js.originX
      const oy = js.originY
      const intensity = Math.min(dist / baseR, 1)  // 0 at center, 1 at edge

      // Outer base — dark filled circle with defined edge
      ctx.beginPath()
      ctx.arc(ox, oy, baseR, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'
      ctx.fill()

      // Outer ring — double stroke for definition
      ctx.beginPath()
      ctx.arc(ox, oy, baseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(0, 255, 255, ${0.15 + intensity * 0.15})`
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(ox, oy, baseR + 2, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(0, 255, 255, ${0.06 + intensity * 0.06})`
      ctx.lineWidth = 5
      ctx.stroke()

      // Tick marks around base ring — 8 notches at 45° intervals
      for (let i = 0; i < 8; i++) {
        const ta = (i / 8) * Math.PI * 2
        const isMajor = i % 2 === 0  // cardinal = longer
        const tickInner = baseR - (isMajor ? 8 : 5)
        const tickOuter = baseR + (isMajor ? 3 : 1)
        ctx.beginPath()
        ctx.moveTo(ox + Math.cos(ta) * tickInner, oy + Math.sin(ta) * tickInner)
        ctx.lineTo(ox + Math.cos(ta) * tickOuter, oy + Math.sin(ta) * tickOuter)
        ctx.strokeStyle = `rgba(0, 255, 255, ${isMajor ? 0.3 : 0.15})`
        ctx.lineWidth = isMajor ? 2 : 1
        ctx.stroke()
      }

      // Crosshair lines at center — subtle cardinal markers
      const crossLen = 8
      const crossGap = 4
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.12)'
      ctx.lineWidth = 1
      for (let i = 0; i < 4; i++) {
        const ca = (i / 4) * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(ox + Math.cos(ca) * crossGap, oy + Math.sin(ca) * crossGap)
        ctx.lineTo(ox + Math.cos(ca) * (crossGap + crossLen), oy + Math.sin(ca) * (crossGap + crossLen))
        ctx.stroke()
      }

      // Direction arrow on outer edge — points in movement direction
      if (dist > 12) {
        const dirAngle = Math.atan2(dy, dx)
        const arrowDist = baseR + 10
        const arrowTipX = ox + Math.cos(dirAngle) * (arrowDist + 8)
        const arrowTipY = oy + Math.sin(dirAngle) * (arrowDist + 8)
        const arrowSize = 7
        const arrowL = dirAngle + Math.PI * 0.75
        const arrowR = dirAngle - Math.PI * 0.75
        ctx.beginPath()
        ctx.moveTo(arrowTipX, arrowTipY)
        ctx.lineTo(arrowTipX + Math.cos(arrowL) * arrowSize, arrowTipY + Math.sin(arrowL) * arrowSize)
        ctx.lineTo(arrowTipX + Math.cos(arrowR) * arrowSize, arrowTipY + Math.sin(arrowR) * arrowSize)
        ctx.closePath()
        ctx.fillStyle = `rgba(0, 255, 255, ${0.3 + intensity * 0.5})`
        ctx.fill()
      }

      // Direction trail — glowing pink beam from origin to knob
      if (dist > 12) {
        // Outer glow
        const glowGrad = ctx.createLinearGradient(ox, oy, knobX, knobY)
        glowGrad.addColorStop(0, 'rgba(255, 50, 200, 0)')
        glowGrad.addColorStop(0.3, `rgba(255, 50, 200, ${0.1 + intensity * 0.15})`)
        glowGrad.addColorStop(1, `rgba(255, 80, 220, ${0.2 + intensity * 0.25})`)
        ctx.beginPath()
        ctx.moveTo(ox, oy)
        ctx.lineTo(knobX, knobY)
        ctx.strokeStyle = glowGrad
        ctx.lineWidth = 8 + intensity * 4
        ctx.lineCap = 'round'
        ctx.stroke()

        // Core bright line
        const coreGrad = ctx.createLinearGradient(ox, oy, knobX, knobY)
        coreGrad.addColorStop(0, 'rgba(255, 150, 240, 0)')
        coreGrad.addColorStop(0.3, `rgba(255, 150, 240, ${0.3 + intensity * 0.3})`)
        coreGrad.addColorStop(1, `rgba(255, 200, 255, ${0.5 + intensity * 0.4})`)
        ctx.beginPath()
        ctx.moveTo(ox, oy)
        ctx.lineTo(knobX, knobY)
        ctx.strokeStyle = coreGrad
        ctx.lineWidth = 3 + intensity * 2
        ctx.stroke()
        ctx.lineCap = 'butt'
      }

      // Knob outer glow — intensifies as you push further
      const knobGlow = ctx.createRadialGradient(knobX, knobY, 0, knobX, knobY, knobR + 12)
      knobGlow.addColorStop(0, `rgba(0, 255, 255, ${0.15 + intensity * 0.2})`)
      knobGlow.addColorStop(0.5, `rgba(0, 255, 255, ${0.04 + intensity * 0.08})`)
      knobGlow.addColorStop(1, 'rgba(0, 255, 255, 0)')
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR + 12, 0, Math.PI * 2)
      ctx.fillStyle = knobGlow
      ctx.fill()

      // Knob body — gradient fill
      const knobFill = ctx.createRadialGradient(knobX, knobY, 0, knobX, knobY, knobR)
      knobFill.addColorStop(0, `rgba(0, 255, 255, ${0.4 + intensity * 0.2})`)
      knobFill.addColorStop(0.7, `rgba(0, 200, 220, ${0.25 + intensity * 0.15})`)
      knobFill.addColorStop(1, `rgba(0, 150, 180, ${0.15 + intensity * 0.1})`)
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.fillStyle = knobFill
      ctx.fill()

      // Knob edge ring — crisp border
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(0, 255, 255, ${0.5 + intensity * 0.3})`
      ctx.lineWidth = 2
      ctx.stroke()

      // Knob center dot — bright
      ctx.beginPath()
      ctx.arc(knobX, knobY, 3, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(0, 255, 255, ${0.6 + intensity * 0.3})`
      ctx.fill()
    }
  }

  // Victory screen overlay
  if (isRunComplete()) {
    const time = getRunFinalTime()
    const timeStr = formatTime(time)

    // Dark overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)'
    ctx.fillRect(0, 0, width, height)

    const vcx = width / 2
    const ch = getActiveChallenge()
    const topScores = ch ? getScoresForChallenge(ch.name, 100) : []
    // Find my entry by exact name + time match
    let myRank = 0
    if (lastSubmittedName && lastSubmittedTime > 0) {
      for (let i = 0; i < topScores.length; i++) {
        if (topScores[i]!.playerName === lastSubmittedName && topScores[i]!.time === lastSubmittedTime) {
          myRank = i + 1
          break
        }
      }
    }

    // === Top section: Your result ===
    const topY = 40

    // "VICTORY" title
    ctx.font = 'bold 64px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(100, 255, 160, 0.95)'
    ctx.fillText('VICTORY', vcx, topY + 60)

    // Your time — BIG
    ctx.font = 'bold 56px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.fillText(timeStr, vcx, topY + 125)

    // Your rank
    if (myRank > 0) {
      const rankColors = ['rgba(255, 215, 64, 0.95)', 'rgba(120, 220, 255, 0.9)', 'rgba(255, 160, 80, 0.9)']
      const rankColor = myRank <= 3 ? rankColors[myRank - 1]! : 'rgba(0, 255, 255, 0.8)'
      ctx.font = 'bold 36px monospace'
      ctx.fillStyle = rankColor
      ctx.fillText(`#${myRank}`, vcx, topY + 170)

      if (ch) {
        const best = getBestTime(ch.name)
        if (best !== null && time <= best) {
          ctx.font = 'bold 22px monospace'
          ctx.fillStyle = 'rgba(255, 215, 64, 0.9)'
          ctx.fillText('NEW BEST!', vcx, topY + 200)
        }
      }
    }

    // === Leaderboard section ===
    if (topScores.length > 0) {
      const listTop = topY + 225
      const listW = 520
      const listX = vcx - listW / 2

      // Header — Global or Local
      const isGlobal = ch ? hasOnlineScores(ch.name) : false
      ctx.font = 'bold 28px monospace'
      ctx.fillStyle = 'rgba(0, 255, 255, 0.7)'
      ctx.fillText(isGlobal ? 'GLOBAL LEADERBOARD' : 'LOCAL LEADERBOARD', vcx, listTop)

      // Separator line
      ctx.beginPath()
      ctx.moveTo(listX, listTop + 12)
      ctx.lineTo(listX + listW, listTop + 12)
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.15)'
      ctx.lineWidth = 1
      ctx.stroke()

      const rowH = 38
      const listStartY = listTop + 36
      const visibleHeight = height - listStartY - 90
      const totalHeight = topScores.length * rowH
      const maxScroll = Math.max(0, totalHeight - visibleHeight)
      victoryScroll = Math.max(0, Math.min(victoryScroll, maxScroll))

      // Auto-scroll to user's score — once only
      if (!victoryAutoScrolled && myRank > 0) {
        victoryAutoScrolled = true
        const myRowTop = (myRank - 1) * rowH
        if (myRowTop > visibleHeight - rowH) {
          victoryScroll = Math.min(myRowTop - visibleHeight / 2, maxScroll)
        }
      }

      // Clip so rows don't scroll over the header
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, listStartY - 22, width, height - listStartY - 65)
      ctx.clip()

      for (let i = 0; i < topScores.length; i++) {
        const s = topScores[i]!
        const rowY = listStartY + i * rowH - victoryScroll
        if (rowY < listStartY - rowH || rowY > height - 90) continue
        const isMe = i === myRank - 1
        const isTop3 = i < 3

        // Highlight row for current player
        if (isMe) {
          ctx.beginPath()
          ctx.roundRect(listX, rowY - 20, listW, rowH - 2, 4)
          ctx.fillStyle = 'rgba(0, 255, 255, 0.08)'
          ctx.fill()
          ctx.strokeStyle = 'rgba(0, 255, 255, 0.25)'
          ctx.lineWidth = 1
          ctx.stroke()
        }

        // Medal / rank colors — gold, cyan-silver, warm bronze
        const medalColors = ['rgba(255, 215, 64, 0.95)', 'rgba(120, 220, 255, 0.9)', 'rgba(255, 160, 80, 0.85)']
        const rankColor = isTop3 ? medalColors[i]! : isMe ? 'rgba(0, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.35)'
        const nameColor = isTop3 ? medalColors[i]! : isMe ? 'rgba(0, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.65)'
        const timeColor = isTop3 ? medalColors[i]! : isMe ? 'rgba(0, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.75)'

        // Rank
        ctx.font = 'bold 22px monospace'
        ctx.textAlign = 'right'
        ctx.fillStyle = rankColor
        ctx.fillText(`${i + 1}`, listX + 30, rowY)

        // Name
        ctx.font = `${isMe ? 'bold ' : ''}20px monospace`
        ctx.textAlign = 'left'
        ctx.fillStyle = nameColor
        ctx.fillText(s.playerName, listX + 45, rowY)

        // Time
        ctx.font = `${isMe ? 'bold ' : ''}20px monospace`
        ctx.textAlign = 'right'
        ctx.fillStyle = timeColor
        ctx.fillText(formatTime(s.time), listX + listW - 80, rowY)

        // Time delta relative to your run
        if (!isMe) {
          const delta = s.time - time
          const deltaStr = delta > 0 ? `+${Math.round(delta)}` : `${Math.round(delta)}`
          ctx.font = '14px monospace'
          ctx.textAlign = 'right'
          ctx.fillStyle = delta < 0 ? 'rgba(255, 80, 80, 0.5)' : delta > 0 ? 'rgba(100, 255, 160, 0.5)' : 'rgba(255, 255, 255, 0.3)'
          ctx.fillText(deltaStr, listX + listW - 10, rowY)
        }
      }

      // Scrollbar
      if (maxScroll > 0) {
        const sbX = listX + listW + 8
        const sbW = 6
        const sbTrackH = visibleHeight
        const sbThumbH = Math.max(30, (visibleHeight / totalHeight) * sbTrackH)
        const sbThumbY = listStartY + (victoryScroll / maxScroll) * (sbTrackH - sbThumbH)

        // Track
        ctx.beginPath()
        ctx.roundRect(sbX, listStartY, sbW, sbTrackH, 3)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)'
        ctx.fill()

        // Thumb
        ctx.beginPath()
        ctx.roundRect(sbX, sbThumbY, sbW, sbThumbH, 3)
        ctx.fillStyle = 'rgba(0, 255, 255, 0.3)'
        ctx.fill()

        // Store scrollbar rect for mouse drag
        victoryScrollbarRect = { x: sbX - 4, y: listStartY, w: sbW + 8, h: sbTrackH, thumbH: sbThumbH, maxScroll }
      } else {
        victoryScrollbarRect = null
      }
      ctx.restore()  // end list clip
    }

    // Celebration fireworks for top 10
    if (myRank > 0 && myRank <= 10) {
      const intensity = myRank <= 3 ? 0.12 : 0.06  // top 3 = more frequent
      // Both sides simultaneously
      for (let side = 0; side < 2; side++) {
        if (Math.random() < intensity) {
          const sx = side === 0 ? width * 0.15 + Math.random() * width * 0.1 : width * 0.75 + Math.random() * width * 0.1
          const sy = height * (0.25 + Math.random() * 0.4)
          const count = myRank <= 3 ? 20 : 12
          // Pick a random burst color
          const colorSet = [
            [255, 215, 64],   // gold
            [0, 255, 255],    // cyan
            [255, 50, 200],   // magenta
            [100, 255, 160],  // green
            [255, 160, 80],   // orange
            [120, 220, 255],  // light blue
          ]
          const baseColor = colorSet[Math.floor(Math.random() * colorSet.length)]!
          for (let p = 0; p < count; p++) {
            const angle = Math.random() * Math.PI * 2
            const speed = 100 + Math.random() * 180
            const pr = Math.min(255, baseColor[0]! + Math.floor((Math.random() - 0.5) * 50))
            const pg = Math.min(255, baseColor[1]! + Math.floor((Math.random() - 0.5) * 50))
            const pb = Math.min(255, baseColor[2]! + Math.floor((Math.random() - 0.5) * 50))
            spawnParticle(
              sx + camX, sy + camY,
              Math.cos(angle) * speed,
              Math.sin(angle) * speed - 40,
              pr, pg, pb,
              0.6 + Math.random() * 0.5, 5 + Math.random() * 5)
          }
          // White core sparks
          for (let p = 0; p < 6; p++) {
            const angle = Math.random() * Math.PI * 2
            const speed = 60 + Math.random() * 100
            spawnParticle(
              sx + camX, sy + camY,
              Math.cos(angle) * speed,
              Math.sin(angle) * speed - 30,
              255, 255, 255,
              0.3 + Math.random() * 0.2, 3 + Math.random() * 3)
          }
        }
      }
    }

    // Buttons at bottom
    const vBtnW = 180
    const vBtnH = 44
    const vBtnGap = 14
    const vBtnY = height - 80
    const retryX = vcx - vBtnW - vBtnGap / 2
    const menuX = vcx + vBtnGap / 2

    // Try Again
    const vRetryHov = pauseMouseX >= retryX && pauseMouseX <= retryX + vBtnW && pauseMouseY >= vBtnY && pauseMouseY <= vBtnY + vBtnH
    ctx.beginPath()
    ctx.roundRect(retryX, vBtnY, vBtnW, vBtnH, 6)
    ctx.strokeStyle = `rgba(0, 255, 255, ${vRetryHov ? 0.8 : 0.5})`
    ctx.lineWidth = vRetryHov ? 2.5 : 2
    ctx.stroke()
    ctx.fillStyle = `rgba(0, 255, 255, ${vRetryHov ? 0.2 : 0.08})`
    ctx.fill()
    ctx.font = 'bold 18px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = `rgba(0, 255, 255, ${vRetryHov ? 1 : 0.8})`
    ctx.fillText('TRY AGAIN', retryX + vBtnW / 2, vBtnY + vBtnH / 2 + 6)

    // Menu
    const vMenuHov = pauseMouseX >= menuX && pauseMouseX <= menuX + vBtnW && pauseMouseY >= vBtnY && pauseMouseY <= vBtnY + vBtnH
    ctx.beginPath()
    ctx.roundRect(menuX, vBtnY, vBtnW, vBtnH, 6)
    ctx.strokeStyle = `rgba(255, 255, 255, ${vMenuHov ? 0.6 : 0.3})`
    ctx.lineWidth = vMenuHov ? 2.5 : 1.5
    ctx.stroke()
    ctx.fillStyle = `rgba(255, 255, 255, ${vMenuHov ? 0.15 : 0.05})`
    ctx.fill()
    ctx.font = 'bold 16px monospace'
    ctx.fillStyle = `rgba(255, 255, 255, ${vMenuHov ? 0.9 : 0.6})`
    ctx.fillText('MENU', menuX + vBtnW / 2, vBtnY + vBtnH / 2 + 6)

    ctx.textAlign = 'left'
  }

  // Name entry screen
  if (getPhase() === 'entering_name') {
    ctx.fillStyle = COLOR_BG
    ctx.fillRect(0, 0, width, height)

    const ncx = width / 2
    const ncy = height * 0.2

    const time = getRunFinalTime()
    const timeStr = formatTime(time)

    ctx.font = 'bold 64px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(100, 255, 160, 0.95)'
    ctx.fillText('VICTORY', ncx, ncy)

    ctx.font = 'bold 56px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.fillText(timeStr, ncx, ncy + 70)

    // Compute projected rank
    const ch = getActiveChallenge()
    const projectedScores = ch ? getScoresForChallenge(ch.name, 100) : []
    const roundedTime = Math.ceil(time)
    // Project where this score lands — one entry per player, so count unique positions
    let projectedRank = projectedScores.length + 1
    for (let i = 0; i < projectedScores.length; i++) {
      if (roundedTime < projectedScores[i]!.time) { projectedRank = i + 1; break }
    }
    // If tied, go after all ties
    while (projectedRank <= projectedScores.length && projectedScores[projectedRank - 1]!.time === roundedTime) {
      projectedRank++
    }
    lastProjectedRank = projectedRank
    const pRankColors = ['rgba(255, 215, 64, 0.95)', 'rgba(120, 220, 255, 0.9)', 'rgba(255, 160, 80, 0.9)']
    const pRankColor = projectedRank <= 3 ? pRankColors[projectedRank - 1]! : 'rgba(0, 255, 255, 0.8)'

    ctx.font = 'bold 40px monospace'
    ctx.fillStyle = pRankColor
    ctx.fillText(`RANK #${projectedRank}`, ncx, ncy + 130)

    ctx.font = 'bold 28px monospace'
    ctx.fillStyle = 'rgba(255, 215, 64, 0.9)'
    ctx.fillText('NEW BEST TIME!', ncx, ncy + 175)

    ctx.font = '24px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
    ctx.fillText('Enter your name:', ncx, ncy + 230)

    // Name input box
    const boxW = 400
    const boxH = 60
    const boxX = ncx - boxW / 2
    const boxY = ncy + 245
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, boxW, boxH, 6)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)'
    ctx.lineWidth = 2
    ctx.stroke()

    // Name text + cursor
    ctx.font = 'bold 34px monospace'
    ctx.fillStyle = 'rgba(0, 255, 255, 0.9)'
    const cursor = Math.floor(performance.now() / 500) % 2 === 0 ? '|' : ''
    ctx.fillText(nameEntryText + cursor, ncx, boxY + boxH / 2 + 10)

    // Submit button — always visible, essential for mobile
    const subW = 200
    const subH = 50
    const subX = ncx - subW / 2
    const subY = boxY + boxH + 16
    const subHov = pauseMouseX >= subX && pauseMouseX <= subX + subW && pauseMouseY >= subY && pauseMouseY <= subY + subH
    ctx.beginPath()
    ctx.roundRect(subX, subY, subW, subH, 8)
    ctx.strokeStyle = `rgba(100, 255, 160, ${subHov ? 0.8 : 0.5})`
    ctx.lineWidth = subHov ? 2.5 : 1.5
    ctx.stroke()
    ctx.fillStyle = `rgba(100, 255, 160, ${subHov ? 0.2 : 0.08})`
    ctx.fill()
    ctx.font = 'bold 24px monospace'
    ctx.fillStyle = `rgba(100, 255, 160, ${subHov ? 1 : 0.8})`
    ctx.fillText('S U B M I T', ncx, subY + subH / 2 + 8)

    // Rank flavor text
    const rankMessages: Record<string, string[]> = {
      '1': [
        'You are the fastest. For now.',
        'Nobody\'s touching this.',
        'The top. Where you belong.',
        'They\'ll all be chasing your ghost.',
        'Screenshot this before someone takes it.',
        'Crown fits nice, doesn\'t it?',
      ],
      '2': [
        'So close. The throne is right there.',
        'Second place. First loser.',
        'One run away from glory.',
        'You can taste first place from here.',
        'The gap is smaller than you think.',
        'Almost had it. Almost.',
      ],
      '3': [
        'Podium. Not bad.',
        'Bronze hits different when you earned it.',
        'Third. Two people were faster. For now.',
        'Close enough to smell the gold.',
        'Top 3 is top 3.',
        'The podium accepts you.',
      ],
      '4-10': [
        'Top 10. Respect.',
        'The leaderboard notices you.',
        'Dangerous territory. Keep going.',
        'You belong up here.',
        'The top 3 should be worried.',
        'One good run from the podium.',
        'You\'re warming up, aren\'t you?',
      ],
      '11-25': [
        'Solid. Keep pushing.',
        'Getting warm.',
        'Not bad. Not great. Not done.',
        'You can see the top from here.',
        'The board respects a grinder.',
        'Halfway to something special.',
        'Your fingers know the way. Trust them.',
      ],
      '26-50': [
        'You know you\'re better than this.',
        'Average. Prove me wrong.',
        'Middle of the pack. For now.',
        'Decent run. Forgettable, but decent.',
        'The leaderboard has seen worse.',
        'One of many. Be one of few.',
        'Your rival just beat this time. Probably.',
      ],
      '51-75': [
        'Hey, you finished.',
        'It\'s a start. A slow start.',
        'At least you\'re on the board.',
        'Technically a score.',
        'The game felt that one.',
        'There\'s levels to this. You found the bottom ones.',
        'You looked cool doing it though. Maybe.',
      ],
      '76-90': [
        'Well... you tried.',
        'Participation trophy unlocked.',
        'Your keyboard works, at least.',
        'Did you play with your eyes closed?',
        'The enemies felt bad for you.',
        'Bold of you to submit this.',
        'Somewhere, a speedrunner just cringed.',
      ],
      '91-100': [
        'Made the board. Barely.',
        'Scraping the bottom here.',
        'Nowhere to go but up.',
        'Rock bottom has a nice view.',
        'You\'re basically the tutorial.',
        'At least 101st place isn\'t a thing.',
        'This is your villain origin story.',
      ],
    }
    let msgKey = '91-100'
    if (projectedRank === 1) msgKey = '1'
    else if (projectedRank === 2) msgKey = '2'
    else if (projectedRank === 3) msgKey = '3'
    else if (projectedRank <= 10) msgKey = '4-10'
    else if (projectedRank <= 25) msgKey = '11-25'
    else if (projectedRank <= 50) msgKey = '26-50'
    else if (projectedRank <= 75) msgKey = '51-75'
    else if (projectedRank <= 90) msgKey = '76-90'
    const msgs = rankMessages[msgKey]!
    // Seed from rank + time so it's stable per run
    const msgIdx = Math.floor((time * 7 + projectedRank * 13) % msgs.length)
    ctx.font = 'bold 26px monospace'
    ctx.fillStyle = projectedRank <= 3 ? 'rgba(255, 215, 64, 0.9)' : projectedRank <= 10 ? 'rgba(0, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.6)'
    ctx.fillText(msgs[msgIdx]!, ncx, boxY + boxH + 45)

    ctx.font = '16px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'
    ctx.fillText('Press Enter to confirm', ncx, boxY + boxH + 75)

    // Celebration fireworks during name entry — top 10 only
    if (projectedRank <= 10) for (let side = 0; side < 2; side++) {
      if (Math.random() < 0.1) {
        const sx = side === 0 ? width * 0.15 + Math.random() * width * 0.1 : width * 0.75 + Math.random() * width * 0.1
        const sy = height * (0.25 + Math.random() * 0.4)
        const colorSet = [[255, 215, 64], [0, 255, 255], [255, 50, 200], [100, 255, 160], [255, 160, 80], [120, 220, 255]]
        const baseColor = colorSet[Math.floor(Math.random() * colorSet.length)]!
        for (let p = 0; p < 18; p++) {
          const angle = Math.random() * Math.PI * 2
          const speed = 100 + Math.random() * 180
          spawnParticle(sx + camX, sy + camY,
            Math.cos(angle) * speed, Math.sin(angle) * speed - 40,
            Math.min(255, baseColor[0]! + Math.floor((Math.random() - 0.5) * 50)),
            Math.min(255, baseColor[1]! + Math.floor((Math.random() - 0.5) * 50)),
            Math.min(255, baseColor[2]! + Math.floor((Math.random() - 0.5) * 50)),
            0.6 + Math.random() * 0.5, 5 + Math.random() * 5)
        }
        for (let p = 0; p < 5; p++) {
          const angle = Math.random() * Math.PI * 2
          const speed = 60 + Math.random() * 100
          spawnParticle(sx + camX, sy + camY,
            Math.cos(angle) * speed, Math.sin(angle) * speed - 30,
            255, 255, 255, 0.3 + Math.random() * 0.2, 3 + Math.random() * 3)
        }
      }
    }

    ctx.textAlign = 'left'
    updateParticles(lastDt)
    drawParticles()
  }

  // Pause screen
  if (getPhase() === 'paused') {
    // Dim overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fillRect(0, 0, width, height)

    const pcx = width / 2
    const btnW = 280
    const btnH = 64
    const btnGap = 18

    // Panel dimensions
    const panelW = btnW + 80
    const titleH = 60
    const volH = 60
    const panelPad = 30
    const panelContentH = titleH + (btnH + btnGap) * 4 + volH + panelPad
    const panelX = pcx - panelW / 2
    const panelY = (height - panelContentH) / 2

    // Dark panel background
    ctx.beginPath()
    ctx.roundRect(panelX, panelY, panelW, panelContentH, 14)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)'
    ctx.fill()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 1
    ctx.stroke()

    // Title
    const titleY = panelY + 45
    ctx.font = 'bold 42px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.fillText('PAUSED', pcx, titleY)

    // Button positions inside panel
    const resumeY = titleY + 30
    const restartBtnY = resumeY + btnH + btnGap
    const menuBtnY = restartBtnY + btnH + btnGap
    const fsBtnY = menuBtnY + btnH + btnGap

    // Hover detection helper
    const isHovered = (by: number) =>
      pauseMouseX >= pcx - btnW / 2 && pauseMouseX <= pcx + btnW / 2 &&
      pauseMouseY >= by && pauseMouseY <= by + btnH

    // Draw button helper
    const drawPauseBtn = (y: number, label: string, r: number, g: number, b: number) => {
      const hov = isHovered(y)
      const hovBoost = hov ? 0.15 : 0
      ctx.beginPath()
      ctx.roundRect(pcx - btnW / 2, y, btnW, btnH, 10)
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.4 + hovBoost * 2})`
      ctx.lineWidth = hov ? 2.5 : 1.5
      ctx.stroke()
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.06 + hovBoost})`
      ctx.fill()
      ctx.font = 'bold 24px monospace'
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.7 + hovBoost * 1.5})`
      ctx.fillText(label, pcx, y + btnH / 2 + 8)
    }

    drawPauseBtn(resumeY, 'R E S U M E', 0, 255, 255)
    drawPauseBtn(restartBtnY, 'R E S T A R T', 255, 215, 64)
    drawPauseBtn(menuBtnY, 'M E N U', 255, 255, 255)
    const isFS = !!document.fullscreenElement
    drawPauseBtn(fsBtnY, isFS ? 'W I N D O W E D' : 'F U L L S C R E E N', 180, 130, 255)

    // Volume slider
    const pauseVolW = 200
    const pauseVolRect = drawVolumeSlider(pcx - pauseVolW / 2, fsBtnY + btnH + 24, pauseVolW)
    volumeSliderRect = pauseVolRect

    ctx.textAlign = 'left'
  }

  // Death screen
  if (getPhase() === 'dead') {
    const time = getRunTimer()
    const total = Math.ceil(time)
    const mins = Math.floor(total / 60)
    const secs = total % 60
    const timeStr = `${mins}:${secs.toString().padStart(2, '0')}`

    // Dark overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
    ctx.fillRect(0, 0, width, height)

    // Red vignette
    const deathVig = ctx.createRadialGradient(width / 2, height / 2, height * 0.2, width / 2, height / 2, height * 0.7)
    deathVig.addColorStop(0, 'rgba(0, 0, 0, 0)')
    deathVig.addColorStop(1, 'rgba(180, 20, 20, 0.3)')
    ctx.fillStyle = deathVig
    ctx.fillRect(0, 0, width, height)

    const dcx = width / 2

    // Title + time at top
    ctx.font = 'bold 52px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(255, 60, 60, 0.95)'
    ctx.fillText('DEFEATED', dcx, 60)

    ctx.font = 'bold 42px monospace'
    ctx.fillStyle = 'rgba(255, 100, 100, 0.95)'
    ctx.fillText(timeStr, dcx, 110)

    // Leaderboard
    const ch = getActiveChallenge()
    if (ch) {
      const topScores = getScoresForChallenge(ch.name, 10)
      if (topScores.length > 0) {
        const listTop = 140
        const listW = 520
        const listX = dcx - listW / 2

        const isGlobal = hasOnlineScores(ch.name)
        ctx.font = 'bold 28px monospace'
        ctx.fillStyle = 'rgba(255, 80, 80, 0.7)'
        ctx.fillText(isGlobal ? 'GLOBAL LEADERBOARD' : 'LOCAL LEADERBOARD', dcx, listTop)

        ctx.beginPath()
        ctx.moveTo(listX, listTop + 12)
        ctx.lineTo(listX + listW, listTop + 12)
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.15)'
        ctx.lineWidth = 1
        ctx.stroke()

        const rowH = 38
        const listStartY = listTop + 36
        const maxVisible = Math.min(topScores.length, Math.floor((height - listStartY - 90) / rowH))

        for (let i = 0; i < maxVisible; i++) {
          const s = topScores[i]!
          const rowY = listStartY + i * rowH
          const isTop3 = i < 3
          const medalColors = ['rgba(255, 215, 64, 0.95)', 'rgba(120, 220, 255, 0.9)', 'rgba(255, 160, 80, 0.85)']
          const rankColor = isTop3 ? medalColors[i]! : 'rgba(255, 255, 255, 0.35)'
          const nameColor = isTop3 ? medalColors[i]! : 'rgba(255, 255, 255, 0.65)'
          const timeColor = isTop3 ? medalColors[i]! : 'rgba(255, 255, 255, 0.75)'

          ctx.font = 'bold 22px monospace'
          ctx.textAlign = 'right'
          ctx.fillStyle = rankColor
          ctx.fillText(`${i + 1}`, listX + 30, rowY)

          ctx.font = '20px monospace'
          ctx.textAlign = 'left'
          ctx.fillStyle = nameColor
          ctx.fillText(s.playerName, listX + 45, rowY)

          ctx.textAlign = 'right'
          ctx.fillStyle = timeColor
          ctx.fillText(formatTime(s.time), listX + listW - 10, rowY)
        }
      }
    }

    // Buttons at bottom
    const btnW = 220
    const btnH = 52
    const btnGap = 16
    const btnBaseY = height - 180
    const retryX = dcx - btnW - btnGap / 2
    const menuX = dcx + btnGap / 2

    const dRetryHov = pauseMouseX >= retryX && pauseMouseX <= retryX + btnW && pauseMouseY >= btnBaseY && pauseMouseY <= btnBaseY + btnH
    ctx.beginPath()
    ctx.roundRect(retryX, btnBaseY, btnW, btnH, 8)
    ctx.strokeStyle = `rgba(0, 255, 255, ${dRetryHov ? 0.8 : 0.5})`
    ctx.lineWidth = dRetryHov ? 2.5 : 2
    ctx.stroke()
    ctx.fillStyle = `rgba(0, 255, 255, ${dRetryHov ? 0.2 : 0.08})`
    ctx.fill()
    ctx.font = 'bold 22px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = `rgba(0, 255, 255, ${dRetryHov ? 1 : 0.8})`
    ctx.fillText('TRY AGAIN', retryX + btnW / 2, btnBaseY + btnH / 2 + 8)

    const dMenuHov = pauseMouseX >= menuX && pauseMouseX <= menuX + btnW && pauseMouseY >= btnBaseY && pauseMouseY <= btnBaseY + btnH
    ctx.beginPath()
    ctx.roundRect(menuX, btnBaseY, btnW, btnH, 8)
    ctx.strokeStyle = `rgba(255, 255, 255, ${dMenuHov ? 0.6 : 0.3})`
    ctx.lineWidth = dMenuHov ? 2.5 : 1.5
    ctx.stroke()
    ctx.fillStyle = `rgba(255, 255, 255, ${dMenuHov ? 0.15 : 0.05})`
    ctx.fill()
    ctx.font = 'bold 22px monospace'
    ctx.fillStyle = `rgba(255, 255, 255, ${dMenuHov ? 0.9 : 0.6})`
    ctx.fillText('MENU', menuX + btnW / 2, btnBaseY + btnH / 2 + 8)

    ctx.textAlign = 'left'
  }

  // "Add to Home Screen" instructions — shown when fullscreen API unavailable (iOS)
  if (addToHomeTimer > 0) {
    addToHomeTimer -= frameDt
    const msgAlpha = Math.min(1, addToHomeTimer / 0.5)  // fade in over 0.5s
    const fadeOut = addToHomeTimer < 1 ? addToHomeTimer : 1
    const a = Math.min(msgAlpha, fadeOut)
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'

    // Dark overlay behind panel
    ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * a})`
    ctx.fillRect(0, 0, width, height)

    // Panel
    const msgW = 650
    const msgH = 200
    const msgX = width / 2 - msgW / 2
    const msgY = height / 2 - msgH / 2
    ctx.fillStyle = `rgba(0, 0, 0, ${0.85 * a})`
    ctx.beginPath()
    ctx.roundRect(msgX, msgY, msgW, msgH, 14)
    ctx.fill()
    ctx.strokeStyle = `rgba(0, 255, 255, ${0.3 * a})`
    ctx.lineWidth = 1.5
    ctx.stroke()

    const cx = width / 2
    let ly = msgY + 40

    // Title
    ctx.font = 'bold 28px monospace'
    ctx.fillStyle = `rgba(0, 255, 255, ${0.9 * a})`
    ctx.fillText('FULLSCREEN ON iPHONE', cx, ly)
    ly += 44

    // Steps
    ctx.font = '20px monospace'
    ctx.fillStyle = `rgba(255, 255, 255, ${0.75 * a})`
    ctx.fillText('1. Tap the Share button (\u2191) in Safari', cx, ly)
    ly += 32
    ctx.fillText('2. Tap "Add to Home Screen"', cx, ly)
    ly += 32
    ctx.fillText('3. Open it from Home Screen like an app', cx, ly)
    ly += 32

    // Dismiss hint
    ctx.font = '12px monospace'
    ctx.fillStyle = `rgba(255, 255, 255, ${0.35 * a})`
    ctx.fillText('tap anywhere to dismiss', cx, ly)

    ctx.restore()
  }
}

// Volume slider — returns the track rect for click handling
export function drawVolumeSlider(x: number, y: number, sliderW = 200): { x: number; y: number; w: number; h: number } {
  const vol = getVolume()
  const trackH = 6
  const thumbR = 10
  const trackY = y + thumbR

  // Label
  ctx.font = 'bold 16px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(0, 255, 255, 0.7)'
  ctx.fillText('V O L U M E', x + sliderW / 2, y - 6)

  // Track background
  ctx.beginPath()
  ctx.roundRect(x, trackY - trackH / 2, sliderW, trackH, 3)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.fill()

  // Filled portion
  const fillW = sliderW * vol
  if (fillW > 0) {
    ctx.beginPath()
    ctx.roundRect(x, trackY - trackH / 2, fillW, trackH, 3)
    ctx.fillStyle = 'rgba(0, 255, 255, 0.3)'
    ctx.fill()
  }

  // Thumb
  const thumbX = x + fillW
  ctx.beginPath()
  ctx.arc(thumbX, trackY, thumbR, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 255, 255, 0.8)'
  ctx.fill()


  return { x, y: trackY - thumbR, w: sliderW, h: thumbR * 2 }
}

let volumeSliderRect: { x: number; y: number; w: number; h: number } | null = null
let volumeDragging = false

export function getVolumeSliderRect(): typeof volumeSliderRect { return volumeSliderRect }
export function setVolumeSliderRect(r: typeof volumeSliderRect): void { volumeSliderRect = r }
export function isVolumeDragging(): boolean { return volumeDragging }
export function startVolumeDrag(mx: number, my: number): boolean {
  if (!volumeSliderRect) return false
  const r = volumeSliderRect
  if (mx >= r.x - 5 && mx <= r.x + r.w + 5 && my >= r.y - 5 && my <= r.y + r.h + 5) {
    volumeDragging = true
    return true
  }
  return false
}
export function updateVolumeDrag(mx: number): number | null {
  if (!volumeDragging || !volumeSliderRect) return null
  const r = volumeSliderRect
  const vol = Math.max(0, Math.min(1, (mx - r.x) / r.w))
  return vol
}
export function stopVolumeDrag(): void { volumeDragging = false }

export function getScreenWidth(): number { return width }
export function getScreenHeight(): number { return height }

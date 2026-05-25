import type { Player } from '../entities/Player.ts'
import { getEffectiveRadius, getBodyRadius } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { getRingOrigins } from '../entities/Enemy.ts'
import type { Ring } from '../entities/Ring.ts'
import { getRingExpansion, getRingAlpha, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { ENEMY_TYPES, getEnemyType } from '../entities/EnemyTypes.ts'
import { complementColor } from '../utils/math.ts'
import { getPattern, getLoopPosition, getLoopLength, getAbsoluteBeats } from '../audio/PatternClock.ts'
import { getPreviewEnemy } from '../game/EnemyDesigner.ts'
import type { Camera, Wall } from '../game/Arena.ts'
import { ARENA_W, ARENA_H, ARENA_RADIUS, ARENA_CX, ARENA_CY, PILL_R, PILL_HALF_W, CROSS_HW, CROSS_HE, getArenaShape, getHexVertices, getCrossVertices, getWalls, computeWallArc, resetWallsToRest, getWallSnapPoints } from '../game/Arena.ts'
import { getBlockedArcs } from '../game/RingOcclusion.ts'
import { getRitualGroups, getActiveIndex } from '../game/RitualNodes.ts'
import { isPlaceMode, getPlacingEnemies, getSelectedPlacement, getChallenges, getActiveChallenge, getWallDrag, getWallThickness, getPlaceTool, getHoveredWallIdx, getHoveredEnemyIdx, getSelectedWallIdx, getEndpointDrag, getWallCurveHandle, getPlacingPrefab, getPrefabCursor, getPrefabRotation, getSelectedWallPivotWorld, isPivotSetMode } from '../game/ChallengeBuilder.ts'
import { getBestTime, getScoresForChallenge, formatTime, hasOnlineScores } from '../game/HighScores.ts'
import type { Challenge } from '../game/ChallengeBuilder.ts'
import type { BlockedArc } from '../game/RingOcclusion.ts'
import { getEnemies, getRunTimer, isRunTimerActive, isRunComplete, getRunFinalTime, getPhase, getRunBeatCount } from '../core/GameState.ts'
import { hasBonus } from '../game/UpgradeManager.ts'
import { getOrbs } from '../entities/XPOrb.ts'
import { getBeatName, getVolume, playDashReady, playIrisOpen, playUIHover, playUIClick } from '../audio/AudioEngine.ts'
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
  HP_DRAIN_SPEED,
} from '../utils/constants.ts'

let canvas: HTMLCanvasElement
let ctx: CanvasRenderingContext2D
let width = 0
let height = 0
let camX = 0
let camY = 0
// Designer zoom-out toggle — Z key. Lets the author see the whole arena at once, centered
// on the arena center (not the player). When enabled, wall motion is frozen (see
// GameManager.updateDesigner) so the designer can position elements against static walls.
const DESIGNER_ZOOM = 0.4
let designerZoomedOut = false
export function isDesignerZoomedOut(): boolean { return designerZoomedOut }
/** Current zoom factor for designer view — 1 normally, DESIGNER_ZOOM when zoomed out. Used
 * by ChallengeBuilder's screenToWorld so clicks map to the right world point. */
export function getDesignerZoomFactor(): number {
  return (designerZoomedOut && getPhase() === 'designer') ? DESIGNER_ZOOM : 1
}
export function toggleDesignerZoomOut(): void {
  designerZoomedOut = !designerZoomedOut
  if (designerZoomedOut) {
    // Snap walls back to their authored rest positions so the designer view always matches the JSON
    resetWallsToRest()
  }
}

// ── Particle system ──
interface Particle {
  x: number; y: number
  vx: number; vy: number
  r: number; g: number; b: number
  life: number
  lifetime: number
  size: number
  spinRate: number  // radians per second, 0 = default behavior
  tintR: number     // -1 = no tint; otherwise blend target after 0.04s delay
  tintG: number
  tintB: number
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
let nameEntryStarted = false
const nameFireworks: { x: number; y: number; vx: number; vy: number; r: number; g: number; b: number; life: number; maxLife: number; size: number }[] = []
let pauseMouseX = 0
let pauseMouseY = 0
let lastHoveredBtn = ''  // tracks which button is hovered for hover SFX

let hoverCheckedThisFrame = false
let pauseAnimTimer = 0
let wasPaused = false
let anyHoverThisFrame = false

function checkHover(id: string, hovered: boolean): boolean {
  if (!hoverCheckedThisFrame) {
    hoverCheckedThisFrame = true
    anyHoverThisFrame = false
  }
  if (hovered) {
    anyHoverThisFrame = true
    if (lastHoveredBtn !== id) {
      lastHoveredBtn = id
      playUIHover()
    }
  }
  return hovered
}

function finalizeHoverCheck(): void {
  if (hoverCheckedThisFrame && !anyHoverThisFrame) {
    lastHoveredBtn = ''  // nothing hovered — reset so re-entering plays sound
  }
  hoverCheckedThisFrame = false
}

export function updatePauseMouse(x: number, y: number): void {
  pauseMouseX = x
  pauseMouseY = y
  // Reset hover if mouse moves but nothing is hovered (checked each frame in draw functions)
}
export function clearHoverState(): void { lastHoveredBtn = '' }
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
let dashReadyFlash: { slotIndex: number; timer: number; duration: number }[] = []
let dashSweepIntensity = 0
let beatDashFlash = 0       // countdown for beat dash shockwave visual
let dashFailFlash = 0       // >0 = brief red flash on the recharging pies when dash attempted with no charge
export function triggerDashFailFlash(): void { dashFailFlash = 0.25 }
let beatDashX = 0
let beatDashY = 0
let beatDashRadius = 0
let dashSweepRadius = 0
let ringPeakX = 0  // player position at ring peak — for aligned post-peak effects
let ringPeakY = 0
let dashSweepPath: { x: number; y: number }[] = []
let prevShieldCharges = -1  // track for restore particle trigger
let shieldRestoreAnim = 0   // countdown for restore converge effect
let shieldActivateSweep = 0 // countdown for top-to-bottom pink sweep
let shieldPulsePhase = 0    // accumulated phase for smooth shield fuse pulse
let shieldFuseCompletionFlash = 0  // flash at 12 o'clock when fuse completes
let shieldDisplayProgress = 0  // smoothed recharge progress for retreat animation

// Iris transition
let irisActive = false
let irisTimer = 0
const IRIS_DURATION = 0.7
let irisCx = 0
let irisCy = 0
let irisCallback: (() => void) | null = null

let irisPhase: 'closing' | 'opening' = 'closing'
let irisCardBurst = false
let irisBurstParticles: { x: number; y: number; vx: number; vy: number; r: number; g: number; b: number; life: number; maxLife: number; size: number }[] = []

export function isIrisActive(): boolean { return irisActive }

export function startIrisOpen(): void {
  irisActive = true
  irisTimer = 0
  irisPhase = 'opening'
  irisCx = width / 2
  irisCy = height / 2
  irisCallback = null
}

export function startIrisTransition(cx: number, cy: number, onComplete: () => void): void {
  irisCardBurst = true
  irisActive = true
  irisTimer = 0
  irisPhase = 'closing'
  irisCx = cx
  irisCy = cy
  irisCallback = onComplete
}

export function drawIrisTransition(dt: number): boolean {
  if (!irisActive) return false
  irisTimer += dt

  const maxR = Math.sqrt(
    Math.max(irisCx, width - irisCx) ** 2 +
    Math.max(irisCy, height - irisCy) ** 2
  )

  if (irisPhase === 'closing') {
    const t = Math.min(irisTimer / IRIS_DURATION, 1)
    const edgeR = Math.max(0, maxR * (1 - t * t))  // ease-in shrink

    // Black mask outside the circle
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
    ctx.arc(irisCx, irisCy, edgeR, 0, Math.PI * 2, true)
    ctx.fillStyle = '#0D0A1A'
    ctx.fill()

    ctx.restore()

    // Card explosion — spawn screen-space burst particles on first frame
    if (irisCardBurst) {
      irisCardBurst = false
      irisBurstParticles.length = 0
      // Cyan burst
      for (let p = 0; p < 70; p++) {
        const a = (p / 70) * Math.PI * 2
        const speed = 750 + Math.random() * 900
        irisBurstParticles.push({ x: irisCx, y: irisCy,
          vx: Math.cos(a) * speed + (Math.random() - 0.5) * 120,
          vy: Math.sin(a) * speed + (Math.random() - 0.5) * 120,
          r: 0, g: 255, b: 255, life: 0, maxLife: 0.4 + Math.random() * 0.25, size: 7.5 + Math.random() * 9 })
      }
      // Pink burst
      for (let p = 0; p < 50; p++) {
        const a = (p / 50) * Math.PI * 2 + 0.1
        const speed = 600 + Math.random() * 750
        irisBurstParticles.push({ x: irisCx, y: irisCy,
          vx: Math.cos(a) * speed + (Math.random() - 0.5) * 150,
          vy: Math.sin(a) * speed + (Math.random() - 0.5) * 150,
          r: 255, g: 50, b: 200, life: 0, maxLife: 0.35 + Math.random() * 0.25, size: 6 + Math.random() * 7.5 })
      }
      // White sparks
      for (let p = 0; p < 40; p++) {
        const a = Math.random() * Math.PI * 2
        const speed = 900 + Math.random() * 900
        irisBurstParticles.push({ x: irisCx, y: irisCy,
          vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
          r: 255, g: 255, b: 255, life: 0, maxLife: 0.25 + Math.random() * 0.2, size: 4.5 + Math.random() * 6 })
      }
    }

    // Draw + update burst particles in screen space — diamond streaks like main particles
    for (let i = irisBurstParticles.length - 1; i >= 0; i--) {
      const bp = irisBurstParticles[i]!
      bp.life += dt
      if (bp.life >= bp.maxLife) { irisBurstParticles.splice(i, 1); continue }
      bp.x += bp.vx * dt
      bp.y += bp.vy * dt
      bp.vx *= 0.99
      bp.vy *= 0.99
      const ft = 1 - bp.life / bp.maxLife
      const shrink = 0.65 + ft * 0.35
      const hs = bp.size * shrink / 2
      const spd = Math.sqrt(bp.vx * bp.vx + bp.vy * bp.vy)
      ctx.fillStyle = `rgba(${bp.r}, ${bp.g}, ${bp.b}, ${ft * 0.8})`
      if (spd > 60) {
        const nx = bp.vx / spd, ny = bp.vy / spd
        const stretch = Math.min(spd / 150, 3.5)
        const frontLen = hs * (1 + stretch * 1.2)
        const backLen = hs * 0.6
        const sideW = hs * (0.5 + stretch * 0.15)
        ctx.beginPath()
        ctx.moveTo(bp.x + nx * frontLen, bp.y + ny * frontLen)
        ctx.lineTo(bp.x - ny * sideW, bp.y + nx * sideW)
        ctx.lineTo(bp.x - nx * backLen, bp.y - ny * backLen)
        ctx.lineTo(bp.x + ny * sideW, bp.y - nx * sideW)
        ctx.closePath()
        ctx.fill()
      } else {
        ctx.beginPath()
        ctx.arc(bp.x, bp.y, hs, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // White flash at click point — first frame only
    if (t < 0.05) {
      ctx.beginPath()
      ctx.arc(irisCx, irisCy, 80, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.6 * (1 - t / 0.05)})`
      ctx.fill()
      ctx.beginPath()
      ctx.arc(irisCx, irisCy, 40, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.8 * (1 - t / 0.05)})`
      ctx.fill()
    }

    // 4 symmetrical spiral arms along the closing edge
    if (edgeR > 5) {
      for (let arm = 0; arm < 4; arm++) {
        const armDir = arm % 2 === 0 ? 1 : -1
        const armOffset = (arm / 4) * Math.PI * 2
        const trailCount = 50
        for (let p = 0; p < trailCount; p++) {
          const trailT = p / trailCount
          const spiralAngle = armOffset + t * Math.PI * 5 * armDir + trailT * Math.PI * 3 * armDir
          const spiralR = edgeR - trailT * edgeR * 0.7
          if (spiralR < 3) continue
          const px = irisCx + Math.cos(spiralAngle) * spiralR
          const py = irisCy + Math.sin(spiralAngle) * spiralR
          const size = (1.5 + (1 - trailT) * 3) * (0.6 + t * 0.4)
          const alpha = (1 - trailT * trailT) * (0.4 + t * 0.4)
          const colorIdx = arm % 3
          const cr = colorIdx === 0 ? 0 : colorIdx === 1 ? 255 : 255
          const cg = colorIdx === 0 ? 255 : colorIdx === 1 ? 50 : 255
          const cb = colorIdx === 0 ? 255 : colorIdx === 1 ? 200 : 255
          ctx.beginPath()
          ctx.arc(px, py, size, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`
          ctx.fill()
        }
      }
    }

    // Close complete — launch game, start opening
    if (t >= 1) {
      if (irisCallback) {
        irisCallback()
        irisCallback = null
      }
      irisPhase = 'opening'
      irisTimer = 0
      irisCx = width / 2
      irisCy = height / 2
      playIrisOpen()
    }
  } else {
    // Opening phase — circle expands from center to reveal the game
    const openDur = 0.5
    const t = Math.min(irisTimer / openDur, 1)
    const edgeR = t * t * maxR  // ease-in expand

    // Black mask outside the expanding circle
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
    ctx.arc(irisCx, irisCy, edgeR, 0, Math.PI * 2, true)
    ctx.fillStyle = '#0D0A1A'
    ctx.fill()

    ctx.restore()

    // 4 symmetrical spiral arms along the opening edge
    if (edgeR > 5 && edgeR < maxR - 10) {
      for (let arm = 0; arm < 4; arm++) {
        const armDir = arm % 2 === 0 ? 1 : -1
        const armOffset = (arm / 4) * Math.PI * 2
        const trailCount = 40
        for (let p = 0; p < trailCount; p++) {
          const trailT = p / trailCount
          const spiralAngle = armOffset + t * Math.PI * 4 * armDir + trailT * Math.PI * 3 * armDir
          const spiralR = edgeR + trailT * 120
          const px = irisCx + Math.cos(spiralAngle) * spiralR
          const py = irisCy + Math.sin(spiralAngle) * spiralR
          const size = (2.25 + (1 - trailT) * 3.75) * (1 - t * 0.6)
          const alpha = (1 - trailT * trailT) * (0.4 - t * 0.3)
          if (alpha <= 0 || size <= 0) continue
          const colorIdx = arm % 3
          const cr = colorIdx === 0 ? 0 : colorIdx === 1 ? 255 : 255
          const cg = colorIdx === 0 ? 255 : colorIdx === 1 ? 50 : 255
          const cb = colorIdx === 0 ? 255 : colorIdx === 1 ? 200 : 255
          ctx.beginPath()
          ctx.arc(px, py, size, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`
          ctx.fill()
        }
      }
    }

    if (t >= 1) {
      irisActive = false
    }
  }
  return true
}
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

// Beat-dash lightning bolts — short jagged streaks emanating from enemies hit by the AOE,
// and from the AOE center itself so the spread reads as radiating outward.
// Points are stored in LOCAL space (relative to the origin at spawn). When `enemy` is set,
// the bolt follows the enemy; if the enemy dies, we fall back to the last-seen world position.
// When `enemy` is null, the bolt stays pinned to its static spawn position (used for the
// AOE-center burst, which is anchored to where the player was at dash time).
interface LightningBolt {
  enemy: Enemy | null
  pts: { x: number; y: number }[]
  lastX: number; lastY: number
  timer: number; lifetime: number; scale: number
  fadeOffset: number   // ±shift to grow-end so strands stagger their fade start
  flickerSeed: number  // per-bolt phase seed so flicker isn't synced across strands
  angularVel: number   // rad/sec — bolt rotates around its origin as it ages
}
const lightningBolts: LightningBolt[] = []
const MAX_BOLTS = 90

function buildBoltPoints(angle: number, length: number): { x: number; y: number }[] {
  const SEGMENTS = 8
  const segLen = length / SEGMENTS
  const pts: { x: number; y: number }[] = [{ x: 0, y: 0 }]
  for (let i = 1; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS
    // Taper jitter — biggest in the middle, zero at start/end
    const taper = Math.sin(t * Math.PI)
    const jitter = (Math.random() - 0.5) * segLen * 0.9 * taper
    const bx = Math.cos(angle) * segLen * i
    const by = Math.sin(angle) * segLen * i
    pts.push({
      x: bx + Math.cos(angle + Math.PI / 2) * jitter,
      y: by + Math.sin(angle + Math.PI / 2) * jitter,
    })
  }
  return pts
}

function spawnLightningBolt(enemy: Enemy, angle: number, length: number, scale: number): void {
  if (lightningBolts.length >= MAX_BOLTS) return
  lightningBolts.push({
    enemy, pts: buildBoltPoints(angle, length),
    lastX: enemy.x, lastY: enemy.y,
    timer: 0, lifetime: 0.29 + Math.random() * 0.07, scale,
    fadeOffset: -0.05 + Math.random() * 0.30,
    flickerSeed: Math.random() * 100,
    angularVel: (Math.random() - 0.5) * 11,  // ±~5.5 rad/s
  })
}

// Static-origin variant for the beat-dash AOE center — bolt is pinned to (x, y) for its
// full lifetime so the "source" of the lightning sits where the player dashed from.
function spawnStaticLightningBolt(x: number, y: number, angle: number, length: number, scale: number, lifetime: number): void {
  if (lightningBolts.length >= MAX_BOLTS) return
  lightningBolts.push({
    enemy: null, pts: buildBoltPoints(angle, length),
    lastX: x, lastY: y,
    timer: 0, lifetime, scale,
    fadeOffset: -0.05 + Math.random() * 0.30,
    flickerSeed: Math.random() * 100,
    angularVel: (Math.random() - 0.5) * 11,
  })
}

function updateAndDrawLightningBolts(dt: number): void {
  for (let i = lightningBolts.length - 1; i >= 0; i--) {
    const b = lightningBolts[i]!
    b.timer += dt
    if (b.timer >= b.lifetime) {
      lightningBolts[i] = lightningBolts[lightningBolts.length - 1]!
      lightningBolts.pop()
      continue
    }
    const t = b.timer / b.lifetime  // 0→1
    // Two phases: rapid GROWTH from center (first ~35%) then fade to 0 (rest).
    // Each bolt staggers its GROW_END via fadeOffset so the cluster dissolves organically
    // rather than every strand dimming on the same frame.
    const growEnd = Math.max(0.15, Math.min(0.7, 0.35 + b.fadeOffset))
    const growLinear = Math.min(1, t / growEnd)
    const growT = growLinear * growLinear * (3 - 2 * growLinear)   // smoothstep ease
    const fadeLinear = t < growEnd ? 1 : 1 - (t - growEnd) / (1 - growEnd)
    const fadeT = fadeLinear * fadeLinear * (3 - 2 * fadeLinear)   // smoothstep for stroke-width scaling
    // Sine ease-out alpha + electric flicker that intensifies as the bolt dims.
    // Flicker is a sum of two out-of-phase sines (per-bolt seed) — reads as discharge noise
    // without burning CPU on per-frame randoms.
    let alpha = Math.sin(fadeLinear * Math.PI * 0.5)
    if (fadeLinear < 1) {
      const flickAmp = 0.18 + 0.32 * (1 - fadeLinear)
      const f1 = Math.sin(b.timer * 95 + b.flickerSeed)
      const f2 = Math.sin(b.timer * 53 + b.flickerSeed * 1.7)
      const flick = (f1 * 0.5 + f2 * 0.5) * 0.5 + 0.5   // 0..1
      alpha *= (1 - flickAmp) + flickAmp * flick
    }
    // Anchor to the enemy's current world position; fall back to last-seen if dead/dying.
    // Static-origin bolts (enemy = null) keep their initial lastX/lastY untouched.
    if (b.enemy && b.enemy.alive && !b.enemy.dying) { b.lastX = b.enemy.x; b.lastY = b.enemy.y }
    const ax = b.lastX, ay = b.lastY
    // Rotate the entire bolt around the enemy center over time.
    const rot = b.timer * b.angularVel
    const cr = Math.cos(rot), sr = Math.sin(rot)
    const pts = b.pts
    const totalSegs = pts.length - 1
    const grownSegs = growT * totalSegs
    const fullSegs = Math.floor(grownSegs)
    const partialFrac = grownSegs - fullSegs
    // Path is shared by both strokes — one beginPath, two strokes.
    // Draw all completed segments + the in-progress segment lerped to its tip position.
    const p0 = pts[0]!
    ctx.beginPath()
    ctx.moveTo(ax + (p0.x * cr - p0.y * sr) - camX, ay + (p0.x * sr + p0.y * cr) - camY)
    for (let p = 1; p <= fullSegs; p++) {
      const pt = pts[p]!
      ctx.lineTo(ax + (pt.x * cr - pt.y * sr) - camX, ay + (pt.x * sr + pt.y * cr) - camY)
    }
    if (partialFrac > 0 && fullSegs < totalSegs) {
      const pa = pts[fullSegs]!
      const pb = pts[fullSegs + 1]!
      const tipX = pa.x + (pb.x - pa.x) * partialFrac
      const tipY = pa.y + (pb.y - pa.y) * partialFrac
      ctx.lineTo(ax + (tipX * cr - tipY * sr) - camX, ay + (tipX * sr + tipY * cr) - camY)
    }
    // Dark-red outline underneath — gives the bolt a contrasting edge so it reads cleanly
    // against bright/cyan backgrounds (shield-break debris, AOE-center flash) without
    // breaking the warm yellow/white palette the way black would.
    ctx.lineCap = 'round'
    ctx.strokeStyle = `rgba(70, 8, 8, ${alpha * 0.7})`
    ctx.lineWidth = 4.95 * b.scale * (0.7 + fadeT * 0.3) * 1.4
    ctx.stroke()
    // Fat yellow glow — thickness scales with the originating enemy's size
    ctx.strokeStyle = `rgba(255, 200, 60, ${alpha * 0.9})`
    ctx.lineWidth = 4.95 * b.scale * (0.7 + fadeT * 0.3)
    ctx.stroke()
    // Hot white core on top
    ctx.strokeStyle = `rgba(255, 255, 220, ${alpha})`
    ctx.lineWidth = 1.54 * b.scale
    ctx.stroke()
  }
  ctx.lineCap = 'butt'
}

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
        ? Math.sin(orbT * 12 + c * 1.5) * 22 * orbLife * orbLife  // wave fades faster near target
        : 0
      const wnx = perpLen > 1 ? perpX / perpLen : 0
      const wny = perpLen > 1 ? perpY / perpLen : 0

      const orbX = sx1 + ddx * orbEase + wnx * wave
      const orbY = sy1 + ddy * orbEase + wny * wave
      const orbSize = (23 - c * 2.3) * Math.max(orbLife, 0.15)

      // Glow
      ctx.beginPath()
      ctx.arc(orbX, orbY, orbSize + 19, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${orbLife * 0.14})`
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
          const nextWave = Math.sin(nextT * 12 + (c + 1) * 1.5) * 22 * nextLife * nextLife
          const nextX = sx1 + ddx * nextEase + wnx * nextWave
          const nextY = sy1 + ddy * nextEase + wny * nextWave
          ctx.beginPath()
          ctx.moveTo(orbX, orbY)
          ctx.lineTo(nextX, nextY)
          ctx.strokeStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${orbLife * 0.36})`
          ctx.lineWidth = 5 * orbLife
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
          fx.r, fx.g, fx.b, 0.1 + Math.random() * 0.08, 2.9 + Math.random() * 2.2)
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
  volatileExplosions.push({ x, y, range, r, g, b, timer: 0, duration: 0.21 })
}

export function spawnVolatileParticles(cx: number, cy: number, range: number, r: number, g: number, b: number): void {
  const count = Math.min(56, Math.round(Math.sqrt(range) * 3.5))
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
    const dist = range * (0.3 + Math.random() * 0.7)
    const px = cx + Math.cos(angle) * dist
    const py = cy + Math.sin(angle) * dist
    const speed = 140 + Math.random() * 200
    const outAngle = Math.atan2(py - cy, px - cx)
    const tint = Math.random()
    const pr = Math.min(255, r + Math.floor(tint * 120))
    const pg = Math.min(255, g + Math.floor(tint * 40))
    const pb = Math.min(255, b + Math.floor(tint * 40))
    const spin = (8 + Math.random() * 10) * (Math.random() < 0.5 ? 1 : -1)
    spawnParticle(px, py,
      Math.cos(outAngle) * speed, Math.sin(outAngle) * speed,
      pr, pg, pb,
      0.41 + Math.random() * 0.25, 9 + Math.random() * 7, spin)
  }
  // White-hot core flash particles — fast outward burst from center
  const hotCount = Math.min(16, Math.round(range / 10))
  for (let i = 0; i < hotCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const speed = 200 + Math.random() * 300
    spawnParticle(cx, cy,
      Math.cos(angle) * speed, Math.sin(angle) * speed,
      255, 240, 220,
      0.19 + Math.random() * 0.13, 4 + Math.random() * 3)
  }
  // Edge ring sparks — fast particles tracing the blast circumference
  const edgeCount = Math.min(20, Math.round(range / 8))
  for (let i = 0; i < edgeCount; i++) {
    const angle = (i / edgeCount) * Math.PI * 2
    const tangent = angle + Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1)
    const speed = 120 + Math.random() * 180
    const px = cx + Math.cos(angle) * range
    const py = cy + Math.sin(angle) * range
    spawnParticle(px, py,
      Math.cos(tangent) * speed + Math.cos(angle) * 30,
      Math.sin(tangent) * speed + Math.sin(angle) * 30,
      Math.min(255, r + 100), Math.min(255, g + 60), Math.min(255, b + 60),
      0.22 + Math.random() * 0.15, 3 + Math.random() * 2.5)
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

    // Red area glow — radial gradient extending past the hitbox edge. Cheap (one fill per frame),
    // additive composite so overlapping explosions accumulate brightness like real light.
    {
      const glowR = ex.range * 1.35
      const glowAlpha = (1 - t) * (1 - t) * 0.78
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR)
      grad.addColorStop(0, `rgba(255, 125, 70, ${Math.min(1, glowAlpha)})`)
      grad.addColorStop(0.45, `rgba(255, 75, 40, ${glowAlpha * 0.78})`)
      grad.addColorStop(0.85, `rgba(255, 45, 30, ${glowAlpha * 0.27})`)
      grad.addColorStop(1, 'rgba(255, 40, 30, 0)')
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()
      ctx.globalCompositeOperation = prevComp
    }

    // White-hot flash — fills most of blast zone, fast fade
    if (t < 0.45) {
      const centerT = t / 0.45
      ctx.beginPath()
      ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${(1 - centerT) * 0.7})`
      ctx.fill()
    }

    // Full area flash — punchy initial, fast falloff
    const flashAlpha = t < 0.15 ? 0.5 * (1 - t / 0.15) : alpha * 0.15
    ctx.beginPath()
    ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${erR}, ${erG}, ${erB}, ${flashAlpha})`
    ctx.fill()

    // Crisp edge ring — exact hitbox boundary
    ctx.beginPath()
    ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${erR}, ${erG}, ${erB}, ${alpha * 0.7})`
    ctx.lineWidth = 4 * (1 - t)
    ctx.stroke()
    // Sharp white edge on top — reads as "this is the boundary"
    ctx.beginPath()
    ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.4})`
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Expanding ripples — shoot outward from blast edge
    for (let rip = 0; rip < 2; rip++) {
      const ripDelay = rip * 0.08
      const ripT = Math.max(0, t - ripDelay) / (ex.duration - ripDelay)
      if (ripT > 0 && ripT < 1) {
        const ripR = ex.range + ripT * 40
        const ripAlpha = (1 - ripT) * (1 - ripT) * 0.4
        ctx.beginPath()
        ctx.arc(sx, sy, ripR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${erR}, ${erG}, ${erB}, ${ripAlpha})`
        ctx.lineWidth = 2 * (1 - ripT)
        ctx.stroke()
      }
    }
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
    const chainCount = 8
    const spacing = 0.07
    ctx.lineCap = 'round'

    for (let c = 0; c < chainCount; c++) {
      const orbT = t - c * spacing
      if (orbT < 0 || orbT > 1) continue
      // Cubic ease-out — fast launch, decelerates
      const orbEase = 1 - (1 - orbT) * (1 - orbT) * (1 - orbT)
      const orbLife = 1 - orbT
      const isLead = c === 0
      const orbSize = isLead ? 41 : (29 - c * 3.6)
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
      ctx.arc(orbX, orbY, orbSize + 23, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${Math.min(255, fx.r + 80)}, ${Math.min(255, fx.g + 60)}, ${Math.min(255, fx.b + 60)}, ${orbLife * 0.22})`
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
          ctx.strokeStyle = `rgba(255, 255, 255, ${orbLife * 0.29})`
          ctx.lineWidth = 14.4 * orbLife
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
  const sizeScale = 1 + Math.max(0, (radius - 60) / 60) * 0.5  // floor at 1x, gentle scale above radius 60
  for (let i = 0; i < 3; i++) {
    deathRipples.push({
      x, y, r, g, b,
      startRadius: radius,
      maxRadius: radius + (110 + i * 65) * sizeScale,
      timer: 0,
      delay: i * 0.042,
      duration: 0.21 + i * 0.053,
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
  lifetime: number, size: number,
  spinRate = 0,
  tintR = -1, tintG = 0, tintB = 0
): void {
  if (particles.length >= MAX_PARTICLES) return
  if (getPhase() === 'entering_name') return  // block game particles on name entry screen
  particles.push({ x, y, vx, vy, r, g, b, life: 0, lifetime, size, spinRate, tintR, tintG, tintB })
}

// Aftershock telegraph — ticking pie + danger-zone ring drawn at the dash origin while a
// pending beat-dash detonation is counting down. Render-side state is decoupled from the
// sim's pending list (avoids a circular Renderer ↔ GameManager import); GameManager pushes
// via addPendingDetonation and both tick at the same dt, so they stay aligned to within
// a frame. The actual boom visuals are still triggerBeatDashFlash, fired by the sim.
interface PendingDetViz {
  x: number; y: number
  radius: number
  timer: number
  lifetime: number
}
const pendingDetVizList: PendingDetViz[] = []

export function addPendingDetonation(x: number, y: number, radius: number, lifetime: number): void {
  pendingDetVizList.push({ x, y, radius, timer: lifetime, lifetime })
}

function updateAndDrawPendingDetonations(dt: number): void {
  if (pendingDetVizList.length === 0) return
  // Tick during any active-sim phase. 'playing' is normal gameplay; 'designer' is the test-play
  // scene where Aftershock can also be applied and beat-dashes fire. Frozen otherwise
  // (paused / dead / upgrading / shopping) to stay in sync with the sim's update guards.
  const simActive = getPhase() === 'playing' || getPhase() === 'designer'
  for (let i = pendingDetVizList.length - 1; i >= 0; i--) {
    const p = pendingDetVizList[i]!
    if (simActive) p.timer -= dt
    if (p.timer <= 0) {
      pendingDetVizList[i] = pendingDetVizList[pendingDetVizList.length - 1]!
      pendingDetVizList.pop()
      continue
    }
    const sx = p.x - camX
    const sy = p.y - camY
    const elapsed = 1 - p.timer / p.lifetime  // 0 → 1
    // Color shift: gold → orange → red as detonation nears
    const lateT = Math.max(0, (elapsed - 0.7) / 0.3)
    const colR = 255
    const colG = Math.floor(200 - elapsed * 90 - lateT * 50)
    const colB = Math.floor(80 - elapsed * 50)
    // Pulse accelerates as it counts down (period: 600ms → 180ms)
    const pulsePeriod = 600 - elapsed * 420
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / pulsePeriod * Math.PI * 2)
    // Outer danger ring outline — dashed, pulsing, gets brighter near detonation
    ctx.beginPath()
    ctx.arc(sx, sy, p.radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${colR}, ${colG}, ${colB}, ${0.35 + pulse * 0.35 + lateT * 0.2})`
    ctx.lineWidth = 2.5 + pulse * 1.5 + lateT * 1.5
    ctx.setLineDash([10, 7])
    ctx.stroke()
    ctx.setLineDash([])
    // Ticking pie wedge — fills clockwise from 12 o'clock
    const pieEnd = -Math.PI / 2 + elapsed * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, p.radius, -Math.PI / 2, pieEnd)
    ctx.closePath()
    ctx.fillStyle = `rgba(${colR}, ${colG}, ${colB}, ${0.14 + lateT * 0.22})`
    ctx.fill()
    // Pie leading edge line — clearer "hand of the clock"
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.lineTo(sx + Math.cos(pieEnd) * p.radius, sy + Math.sin(pieEnd) * p.radius)
    ctx.strokeStyle = `rgba(255, ${Math.min(255, colG + 50)}, ${colB}, ${0.7 + lateT * 0.3})`
    ctx.lineWidth = 2
    ctx.stroke()
    // Fuse sparks drifting up from center — sparse early, ramping near detonation
    if (Math.random() < 0.25 + elapsed * 0.4 + lateT * 0.5) {
      const sa = -Math.PI / 2 + (Math.random() - 0.5) * 1.0
      const ss = 70 + Math.random() * 70 + lateT * 100
      spawnParticle(p.x, p.y, Math.cos(sa) * ss, Math.sin(sa) * ss,
        colR, Math.min(255, colG + 30), colB,
        0.25 + Math.random() * 0.15, 3 + Math.random() * 2)
    }
  }
}

// Echo Step visuals — anchor marker (persistent while anchorActive) + recall streak (during
// the half-beat warp). Marker reads as a violet rune on the ground: rotating triangular runes
// around a pulsing core ring. The streak is a fading violet line from departure to current
// player position with extra afterimage echoes for that "warping through space" feel.
function drawEchoStep(player: Player): void {
  // Anchor marker — only when active. Big violet rune cluster: soft halo gradient + outer
  // dashed ring (rotating CW) + mid chevron ring (counter-CCW) + inner pulsing core + six
  // perimeter triangular runes + spinning center diamond + ambient floor sparks + a soft
  // vertical light pillar so it's readable from across the arena.
  if (player.anchorActive) {
    const ax = player.anchorX - camX
    const ay = player.anchorY - camY
    const baseR = 78  // 3× the old 26 — "200% bigger"
    const now = performance.now()
    const pulse = 0.5 + 0.5 * Math.sin(now / 240)
    const fastPulse = 0.5 + 0.5 * Math.sin(now / 110)
    const rotCW = now / 1800        // slow clockwise
    const rotCCW = -now / 2200      // slower counter-clockwise
    const rotFast = now / 600       // center diamond spin

    // (1) Wide radial halo — gradient that fades out beyond the marker
    {
      const haloR = baseR * 1.6 + pulse * 8
      const g = ctx.createRadialGradient(ax, ay, 0, ax, ay, haloR)
      g.addColorStop(0, `rgba(140, 90, 255, ${0.22 + pulse * 0.08})`)
      g.addColorStop(0.55, `rgba(124, 77, 255, ${0.1 + pulse * 0.05})`)
      g.addColorStop(1, `rgba(80, 40, 180, 0)`)
      ctx.beginPath()
      ctx.arc(ax, ay, haloR, 0, Math.PI * 2)
      ctx.fillStyle = g
      ctx.fill()
    }

    // (2) Soft vertical light pillar — readable from distance
    {
      const pillarH = baseR * 2.2
      const pillarW = baseR * 0.55
      const pg = ctx.createLinearGradient(ax, ay - pillarH, ax, ay + 4)
      pg.addColorStop(0, `rgba(180, 140, 255, 0)`)
      pg.addColorStop(0.7, `rgba(180, 140, 255, ${0.10 + pulse * 0.06})`)
      pg.addColorStop(1, `rgba(220, 200, 255, ${0.28 + pulse * 0.10})`)
      ctx.fillStyle = pg
      ctx.fillRect(ax - pillarW / 2, ay - pillarH, pillarW, pillarH + 4)
    }

    // (3) Outer dashed ring rotating CW
    ctx.save()
    ctx.translate(ax, ay)
    ctx.rotate(rotCW)
    ctx.setLineDash([14, 9])
    ctx.beginPath()
    ctx.arc(0, 0, baseR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(180, 140, 255, ${0.7 + pulse * 0.2})`
    ctx.lineWidth = 3
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()

    // (4) Mid ring — chevrons (V shapes) pointing inward, counter-rotating
    ctx.save()
    ctx.translate(ax, ay)
    ctx.rotate(rotCCW)
    const midR = baseR * 0.78
    const chevrons = 12
    ctx.strokeStyle = `rgba(220, 200, 255, ${0.55 + pulse * 0.25})`
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    for (let i = 0; i < chevrons; i++) {
      const a = (i / chevrons) * Math.PI * 2
      const cx = Math.cos(a) * midR
      const cy = Math.sin(a) * midR
      const size = 7
      // Chevron points inward toward center
      const inward = Math.atan2(-cy, -cx)
      const wing1 = inward + 0.6
      const wing2 = inward - 0.6
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(wing1) * size, cy + Math.sin(wing1) * size)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx + Math.cos(wing2) * size, cy + Math.sin(wing2) * size)
      ctx.stroke()
    }
    ctx.restore()
    ctx.lineCap = 'butt'

    // (5) Inner core ring — solid, pulses with fastPulse for energy feel
    ctx.beginPath()
    ctx.arc(ax, ay, baseR * 0.42, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(230, 215, 255, ${0.75 + fastPulse * 0.25})`
    ctx.lineWidth = 2.4
    ctx.stroke()
    // Inner-inner ring — thin highlight
    ctx.beginPath()
    ctx.arc(ax, ay, baseR * 0.28, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 245, 255, ${0.5 + fastPulse * 0.3})`
    ctx.lineWidth = 1.2
    ctx.stroke()

    // (6) Six triangular runes around the outer perimeter, rotating CW
    for (let i = 0; i < 6; i++) {
      const ra = rotCW * 1.4 + (i / 6) * Math.PI * 2
      const rx = ax + Math.cos(ra) * (baseR + 6)
      const ry = ay + Math.sin(ra) * (baseR + 6)
      const tri = 9
      ctx.beginPath()
      ctx.moveTo(rx + Math.cos(ra) * tri, ry + Math.sin(ra) * tri)
      ctx.lineTo(rx + Math.cos(ra + 2.3) * tri * 0.7, ry + Math.sin(ra + 2.3) * tri * 0.7)
      ctx.lineTo(rx + Math.cos(ra - 2.3) * tri * 0.7, ry + Math.sin(ra - 2.3) * tri * 0.7)
      ctx.closePath()
      ctx.fillStyle = `rgba(200, 170, 255, ${0.75 + pulse * 0.25})`
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 245, 255, ${0.6 + pulse * 0.2})`
      ctx.lineWidth = 1.2
      ctx.stroke()
    }

    // (7) Center diamond — spins fast, the "active focus" of the rune
    ctx.save()
    ctx.translate(ax, ay)
    ctx.rotate(rotFast)
    const diaR = 7 + fastPulse * 2
    ctx.beginPath()
    ctx.moveTo(0, -diaR)
    ctx.lineTo(diaR, 0)
    ctx.lineTo(0, diaR)
    ctx.lineTo(-diaR, 0)
    ctx.closePath()
    ctx.fillStyle = `rgba(255, 240, 255, ${0.85 + fastPulse * 0.15})`
    ctx.fill()
    ctx.strokeStyle = `rgba(180, 140, 255, 0.9)`
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()

    // (8) Floor sparks drifting up from the perimeter — denser than before
    if (Math.random() < 0.55) {
      const sweep = Math.random() * Math.PI * 2
      const spawnR = baseR * (0.7 + Math.random() * 0.3)
      const spawnX = player.anchorX + Math.cos(sweep) * spawnR
      const spawnY = player.anchorY + Math.sin(sweep) * spawnR
      // Velocity mostly upward with a slight inward bias toward center
      const inwardX = (player.anchorX - spawnX) * 0.4
      const inwardY = (player.anchorY - spawnY) * 0.4
      spawnParticle(spawnX, spawnY,
        inwardX, -50 - Math.random() * 50 + inwardY,
        180 + Math.floor(Math.random() * 60), 150 + Math.floor(Math.random() * 70), 255,
        0.7 + Math.random() * 0.4, 2.5 + Math.random() * 2)
    }
    // Occasional bright twinkle particles near the perimeter
    if (Math.random() < 0.22) {
      const sweep = Math.random() * Math.PI * 2
      const spawnR = baseR * (0.85 + Math.random() * 0.25)
      spawnParticle(
        player.anchorX + Math.cos(sweep) * spawnR,
        player.anchorY + Math.sin(sweep) * spawnR,
        Math.cos(sweep) * 20, Math.sin(sweep) * 20 - 30,
        240, 220, 255, 0.4 + Math.random() * 0.3, 3 + Math.random() * 2)
    }
  }

  // Recall warp streak — only during the traversal
  if (player.recallTimer >= 0) {
    const fx = player.recallFromX - camX
    const fy = player.recallFromY - camY
    const cx = player.x - camX
    const cy = player.y - camY
    // Bright streak from departure point to current player position (the head of the warp)
    const dx = cx - fx
    const dy = cy - fy
    const len = Math.sqrt(dx * dx + dy * dy)
    if (len > 1) {
      // Outer glow
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(fx, fy)
      ctx.lineTo(cx, cy)
      ctx.strokeStyle = `rgba(124, 77, 255, 0.35)`
      ctx.lineWidth = 16
      ctx.stroke()
      // Mid stroke
      ctx.beginPath()
      ctx.moveTo(fx, fy)
      ctx.lineTo(cx, cy)
      ctx.strokeStyle = `rgba(180, 140, 255, 0.7)`
      ctx.lineWidth = 7
      ctx.stroke()
      // Hot core
      ctx.beginPath()
      ctx.moveTo(fx, fy)
      ctx.lineTo(cx, cy)
      ctx.strokeStyle = `rgba(240, 230, 255, 0.95)`
      ctx.lineWidth = 2.5
      ctx.stroke()
      ctx.lineCap = 'butt'
    }
    // Spray particles around the streak head
    for (let i = 0; i < 2; i++) {
      const sa = Math.random() * Math.PI * 2
      const ss = 60 + Math.random() * 80
      spawnParticle(player.x, player.y,
        Math.cos(sa) * ss, Math.sin(sa) * ss,
        180 + Math.floor(Math.random() * 60), 150 + Math.floor(Math.random() * 50), 255,
        0.3 + Math.random() * 0.2, 3 + Math.random() * 2)
    }
  }
}

// Chill Zone visuals — persistent slow-field marker on the arena floor, plus the one-shot
// ice-shard burst that fires when the zone gets replaced. State pushed from GameManager via
// the setChillZoneViz/clearChillZoneViz/spawnIceShardBurst helpers (decouples to avoid the
// circular Renderer ↔ GameManager import, same pattern used for pending detonations).
let chillZoneViz: { x: number; y: number; radius: number } | null = null
interface IceShard {
  ox: number; oy: number     // origin (center of burst)
  dx: number; dy: number     // direction vector (unit-ish)
  startDist: number          // initial distance from center
  endDist: number            // target distance (where it stops/dissolves)
  rot: number; rotVel: number
  size: number
  timer: number; lifetime: number
}
const iceShards: IceShard[] = []
interface FrostCrack {
  x: number; y: number; radius: number
  timer: number; lifetime: number
}
const frostCracks: FrostCrack[] = []
// Mini snowflakes — small 6-armed asterisks drifting in the collapse area to add a "flurry"
// texture to the ice-shard burst. Stateful (each has its own velocity + rotation) so they
// drift organically rather than animating along a fixed lerp like the shards.
interface MiniSnowflake {
  x: number; y: number
  vx: number; vy: number
  rot: number; rotVel: number
  size: number
  timer: number; lifetime: number
}
const miniSnowflakes: MiniSnowflake[] = []

export function setChillZoneViz(x: number, y: number, radius: number): void {
  chillZoneViz = { x, y, radius }
}
export function clearChillZoneViz(): void {
  chillZoneViz = null
}

// Inward-flying crystal shards from the perimeter of the old zone, plus a sharp shock-ring
// flash. Tunable: shard count scales with radius so big zones have more debris.
export function spawnIceShardBurst(x: number, y: number, radius: number): void {
  const shardCount = Math.max(28, Math.floor(radius * 0.42))
  for (let i = 0; i < shardCount; i++) {
    const a = (i / shardCount) * Math.PI * 2 + Math.random() * 0.3
    // Shards fire INWARD from perimeter toward center, decelerating
    iceShards.push({
      ox: x, oy: y,
      dx: Math.cos(a), dy: Math.sin(a),
      startDist: radius * (0.85 + Math.random() * 0.2),
      endDist: radius * (0.1 + Math.random() * 0.2),
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 8,
      size: 7 + Math.random() * 5,
      timer: 0, lifetime: 0.38 + Math.random() * 0.08,
    })
  }
  // Spray of small fast particles for added texture
  for (let i = 0; i < 30; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 250 + Math.random() * 250
    spawnParticle(x + Math.cos(a) * radius * 0.4, y + Math.sin(a) * radius * 0.4,
      Math.cos(a) * sp, Math.sin(a) * sp,
      200 + Math.floor(Math.random() * 55), 230 + Math.floor(Math.random() * 25), 255,
      0.3 + Math.random() * 0.2, 3 + Math.random() * 2)
  }
  // Bright central flash + shock-ring (drawn each frame in updateAndDrawChillFX while alive)
  frostCracks.push({ x, y, radius, timer: 0, lifetime: 0.36 })
  // Mini snowflake flurry — sprinkled across the collapse area, drifting outward+upward
  // with slight gravity. Reads as "powder snow kicked up by the shatter." Scales with radius.
  const flakeCount = Math.max(20, Math.floor(radius * 0.30))
  for (let i = 0; i < flakeCount; i++) {
    const a = Math.random() * Math.PI * 2
    const d = Math.sqrt(Math.random()) * radius * 0.88   // uniform distribution inside circle
    const spawnX = x + Math.cos(a) * d
    const spawnY = y + Math.sin(a) * d
    // Velocity: gentle drift outward from center + jitter + slight upward bias for "kicked up dust"
    const outAng = Math.atan2(spawnY - y, spawnX - x)
    const speed = 50 + Math.random() * 90
    const vx = Math.cos(outAng) * speed * 0.45 + (Math.random() - 0.5) * 50
    const vy = Math.sin(outAng) * speed * 0.45 + (Math.random() - 0.5) * 50 - 35
    miniSnowflakes.push({
      x: spawnX, y: spawnY,
      vx, vy,
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 7,
      size: 4 + Math.random() * 3.5,
      timer: 0, lifetime: 0.75 + Math.random() * 0.55,
    })
  }
}

// Snowflake "shatter free" — fires when an enemy's immobileTimer hits 0. Twelve crystal
// fragments fly OUTWARD from the enemy along the snowflake's arm directions (vs the burst's
// inward shower), plus white-cyan sparkles. Reads as the enemy cracking the ice and pushing
// through, not as damage.
export function spawnSnowflakeShatter(x: number, y: number, r: number): void {
  const totalShards = 12
  for (let i = 0; i < totalShards; i++) {
    // First 6 align with the snowflake arms; second 6 in-fill the gaps
    const a = (i / 6) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
    iceShards.push({
      ox: x, oy: y,
      dx: Math.cos(a), dy: Math.sin(a),
      startDist: r * 0.12,                          // start near hub
      endDist: r * (1.4 + Math.random() * 0.5),     // fling past the body
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 10,
      size: 5 + Math.random() * 4,
      timer: 0, lifetime: 0.32 + Math.random() * 0.08,
    })
  }
  // Sparkle particles for the "ice dust" feel
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 180 + Math.random() * 200
    spawnParticle(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3,
      Math.cos(a) * sp, Math.sin(a) * sp,
      230, 245, 255, 0.25 + Math.random() * 0.15, 2.5 + Math.random() * 2)
  }
}

// Small white-cyan puff for the FIRST chill zone placement (no old zone to shatter).
export function spawnFrostCrack(x: number, y: number, radius: number): void {
  frostCracks.push({ x, y, radius: radius * 0.6, timer: 0, lifetime: 0.28 })
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2 + Math.random() * 0.4
    const sp = 140 + Math.random() * 100
    spawnParticle(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
      210 + Math.floor(Math.random() * 45), 235, 255,
      0.28 + Math.random() * 0.15, 2.5 + Math.random() * 2)
  }
}

// One-shot particle burst when a wall spring fires. Particles spray perpendicular to the
// wall surface in BOTH directions (out either side of the capsule) for a shockwave look.
function spawnSpringFireBurst(w: Wall): void {
  // Pillar — radial burst
  const dxw = w.bx - w.ax
  const dyw = w.by - w.ay
  const segLen = Math.sqrt(dxw * dxw + dyw * dyw)
  const isPillar = segLen < 0.5
  const PARTICLES_PER_SIDE = 10
  const SIDES = isPillar ? 1 : 2
  for (let side = 0; side < SIDES; side++) {
    // For pillars, scatter radially; for capsules, perpendicular to chord (both sides)
    const sign = side === 0 ? 1 : -1
    const perpX = isPillar ? 0 : -dyw / segLen * sign
    const perpY = isPillar ? 0 : dxw / segLen * sign
    for (let p = 0; p < PARTICLES_PER_SIDE; p++) {
      // Position: somewhere along the wall length (for capsules), edge of pillar otherwise
      let sx: number, sy: number
      if (isPillar) {
        const ang = Math.random() * Math.PI * 2
        sx = w.ax + Math.cos(ang) * w.radius
        sy = w.ay + Math.sin(ang) * w.radius
      } else {
        const t = Math.random()
        const cx = w.ax + dxw * t
        const cy = w.ay + dyw * t
        sx = cx + perpX * w.radius
        sy = cy + perpY * w.radius
      }
      // Velocity: outward (perpendicular for capsule, radial for pillar) + a bit of jitter
      let vx: number, vy: number
      const launchSpeed = 280 + Math.random() * 220
      if (isPillar) {
        const ang = Math.atan2(sy - w.ay, sx - w.ax)
        vx = Math.cos(ang) * launchSpeed
        vy = Math.sin(ang) * launchSpeed
      } else {
        vx = perpX * launchSpeed + (Math.random() - 0.5) * 60
        vy = perpY * launchSpeed + (Math.random() - 0.5) * 60
      }
      spawnParticle(sx, sy, vx, vy,
        200 + Math.floor(Math.random() * 55), 230 + Math.floor(Math.random() * 25), 255,
        0.28 + Math.random() * 0.18, 3 + Math.random() * 2.5)
    }
  }
}

// Wall rendering — glowing rune-edged capsules. Four layered strokes per wall give the
// cohesive cyan-energy aesthetic that matches the rest of the game's visual language
// (anchors, recall streaks, chill zone). Pillars (degenerate capsules where ax=bx, ay=by)
// are handled via concentric arcs since a zero-length stroke draws nothing.
// Layer-by-layer rendering: ALL halos first, then ALL mid glows, then ALL rims, then ALL
// bodies. This avoids the per-wall ordering bug where wall B's bright rim would draw on top
// of wall A's body at shared endpoints, creating a visible cyan crossover. With all bodies
// drawn last, joint-overlapping bodies cover any rim crossover, and the halo/rim form a
// unified outline around the whole connected shape.
function drawWalls(): void {
  const walls = getWalls()
  if (walls.length === 0) {
    drawWallsOverlay()
    return
  }
  const now = performance.now()
  const pulse = 0.5 + 0.5 * Math.sin(now / 1800)
  const haloAlpha = 0.10 + pulse * 0.04
  const midAlpha = 0.22 + pulse * 0.06
  const rimAlpha = 0.85 + pulse * 0.15
  ctx.lineCap = 'round'

  // Precompute per-wall screen-space data including arc info for bent walls + a per-wall
  // visual-scale multiplier driven by spring state (compress on anticipation, expand on fire).
  type WallDraw = {
    w: Wall
    ax: number; ay: number; bx: number; by: number
    pillar: boolean
    arc: { cx: number; cy: number; r: number; aA: number; aB: number; antiClockwise: boolean } | null
    visScale: number
    springFireT: number   // 0..1 — color-flash intensity, 1 on fire frame, decays across pulse
  }
  const drawList: WallDraw[] = []
  const beatPosForSpring = getAbsoluteBeats()
  for (const w of walls) {
    const ax = w.ax - camX, ay = w.ay - camY
    const bx = w.bx - camX, by = w.by - camY
    const dxw = bx - ax, dyw = by - ay
    const pillar = dxw * dxw + dyw * dyw < 0.5
    const arcWorld = computeWallArc(w)
    const arc = arcWorld ? {
      cx: arcWorld.cx - camX, cy: arcWorld.cy - camY,
      r: arcWorld.r, aA: arcWorld.aA, aB: arcWorld.aB, antiClockwise: arcWorld.antiClockwise,
    } : null
    // Spring visual — pure beat math (no timer). Adapts duration + amplitude to the wall's
    // cycle so fast tempos get a tight, small pulse instead of a constantly-flailing wall.
    // Three phases: post-fire pulse (expand peak), anticipation (compress before next fire),
    // idle. Particle burst is gated by the springJustFired transient flag from Arena.
    let visScale = 1
    let springFireT = 0   // 1 at fire moment, 0 elsewhere (drives color flash intensity)
    if (w.spring && w.springLastFireBeat != null) {
      const cycle = w.spring.beatsPerCycle
      // Pulse + anticipation durations cap at the original values for long cycles, but
      // shrink to a fraction of the cycle for fast tempos so the animation can actually
      // settle between fires.
      const pulseDur = Math.min(0.20, cycle * 0.30)   // matches grace window (~0.22 beats) so the visual reads "actively pushing" for the full active time
      const anticipDur = Math.min(0.3, cycle * 0.3)
      const pulseAmpl = Math.min(0.13, cycle * 0.13)   // tighter — visual ≈ hitbox (was 18%)
      const beatsSinceFire = beatPosForSpring - w.springLastFireBeat
      const beatsUntilNext = (w.springLastFireBeat + cycle) - beatPosForSpring
      if (beatsSinceFire >= 0 && beatsSinceFire < pulseDur) {
        const t = beatsSinceFire / pulseDur   // 0 at fire → 1 at end of pulse
        // Hammer profile: instant peak at fire (t=0), smooth quadratic decay to rest. Was a
        // sine arch peaking at t=0.5, which meant the wall grew LARGER ~75ms after firing —
        // confusing because the spring is already inert by then.
        const ease = (1 - t) * (1 - t)
        visScale = 1 + ease * pulseAmpl
        springFireT = ease   // color flash follows the same curve
      } else if (beatsUntilNext > 0 && beatsUntilNext < anticipDur) {
        const a = 1 - beatsUntilNext / anticipDur
        visScale = 1 - a * 0.06   // gentler anticipation squash
      }
      // Consume the one-shot fire flag — inner shockwave is rendered in pass 5 below;
      // outside particle burst is intentionally suppressed (visual moved INSIDE the wall).
      if (w.springJustFired) {
        w.springJustFired = false
      }
    }
    drawList.push({ w, ax, ay, bx, by, pillar, arc, visScale, springFireT })
  }

  function strokeWallLayer(d: WallDraw, padding: number, style: string, fixedWidth?: number): void {
    const thick = d.w.radius * 2 * d.visScale
    if (d.pillar) {
      ctx.beginPath()
      ctx.arc(d.ax, d.ay, (d.w.radius + padding / 2) * d.visScale, 0, Math.PI * 2)
      ctx.fillStyle = style
      ctx.fill()
      return
    }
    const w = fixedWidth ?? (thick + padding)
    if (w < 0.5) return   // guard tiny / negative widths
    ctx.beginPath()
    if (d.arc) {
      ctx.arc(d.arc.cx, d.arc.cy, d.arc.r, d.arc.aA, d.arc.aB, !d.arc.antiClockwise)
    } else {
      ctx.moveTo(d.ax, d.ay)
      ctx.lineTo(d.bx, d.by)
    }
    ctx.strokeStyle = style
    ctx.lineWidth = w
    ctx.stroke()
  }

  // Helper — spring fire intensity 0..1 (peaks at 1 on fire frame, decays to 0 by end of pulse)
  function springFireGlow(d: WallDraw): number {
    return d.springFireT
  }

  // Helper — inner shockwave on spring fire. Clips drawing to the wall body interior so
  // the bright wave reads as energy radiating from inside the wall.
  //   pillar  : concentric ring expanding from the center outward to the rim
  //   capsule : two parallel bars sliding from the spine outward to the perpendicular rim
  //   arc     : two concentric arcs (one going inward, one outward) from the spine arc
  function drawInnerShockwave(d: WallDraw, progress: number): void {
    const alpha = (1 - progress * progress)   // bright at fire moment, quadratic fade
    if (alpha <= 0.01) return
    const w = d.w
    const r = Math.max(2, w.radius * d.visScale - 1)   // -1 px so the wave sits INSIDE the rim
    // Layer widths scale with wall thickness so the shockwave reads proportionally on
    // anything from a tiny pillar to a 240-radius wall. Minimums keep thin walls visible.
    const glowW = Math.max(10, r * 0.60)
    const coreW = Math.max(3.5, r * 0.24)
    const hotW = Math.max(1.2, r * 0.08)
    const glowColor = `rgba(255, 200, 90, ${alpha * 0.55})`
    const coreColor = `rgba(255, 245, 200, ${alpha})`
    const hotColor = `rgba(255, 255, 245, ${alpha * 0.9})`
    ctx.save()
    if (d.pillar) {
      ctx.beginPath()
      ctx.arc(d.ax, d.ay, r, 0, Math.PI * 2)
      ctx.clip()
      const ringR = progress * r
      ctx.beginPath()
      ctx.arc(d.ax, d.ay, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = glowColor
      ctx.lineWidth = glowW
      ctx.stroke()
      ctx.strokeStyle = coreColor
      ctx.lineWidth = coreW
      ctx.stroke()
      ctx.strokeStyle = hotColor
      ctx.lineWidth = hotW
      ctx.stroke()
    } else if (d.arc) {
      const a = d.arc
      const rIn = Math.max(0.1, a.r - r)
      const rOut = a.r + r
      ctx.beginPath()
      ctx.arc(a.cx, a.cy, rOut, a.aA, a.aB, a.antiClockwise)
      ctx.arc(a.cx, a.cy, rIn, a.aB, a.aA, !a.antiClockwise)
      ctx.closePath()
      ctx.clip()
      const outerR = a.r + progress * r
      const innerR = Math.max(0.1, a.r - progress * r)
      const drawArcPair = (style: string, width: number) => {
        ctx.strokeStyle = style; ctx.lineWidth = width
        ctx.beginPath(); ctx.arc(a.cx, a.cy, outerR, a.aA, a.aB, a.antiClockwise); ctx.stroke()
        ctx.beginPath(); ctx.arc(a.cx, a.cy, innerR, a.aA, a.aB, a.antiClockwise); ctx.stroke()
      }
      drawArcPair(glowColor, glowW)
      drawArcPair(coreColor, coreW)
      drawArcPair(hotColor, hotW)
    } else {
      const dx = d.bx - d.ax, dy = d.by - d.ay
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len < 0.5) { ctx.restore(); return }
      const midX = (d.ax + d.bx) / 2
      const midY = (d.ay + d.by) / 2
      const angle = Math.atan2(dy, dx)
      const halfLen = len / 2
      ctx.translate(midX, midY)
      ctx.rotate(angle)
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(-halfLen - r, -r, len + 2 * r, 2 * r, r)
      } else {
        ctx.moveTo(-halfLen, -r)
        ctx.lineTo(halfLen, -r)
        ctx.arc(halfLen, 0, r, -Math.PI / 2, Math.PI / 2)
        ctx.lineTo(-halfLen, r)
        ctx.arc(-halfLen, 0, r, Math.PI / 2, -Math.PI / 2)
        ctx.closePath()
      }
      ctx.clip()
      const offset = progress * r
      const drawBarPair = (style: string, width: number) => {
        ctx.strokeStyle = style; ctx.lineWidth = width
        ctx.beginPath()
        ctx.moveTo(-halfLen - r, +offset)
        ctx.lineTo(+halfLen + r, +offset)
        ctx.moveTo(-halfLen - r, -offset)
        ctx.lineTo(+halfLen + r, -offset)
        ctx.stroke()
      }
      drawBarPair(glowColor, glowW)
      drawBarPair(coreColor, coreW)
      drawBarPair(hotColor, hotW)
    }
    ctx.restore()
  }
  // Pass 1 — outer halos. Brighter alpha for passive bloom feel, but padding stays tight
  // so the glow doesn't extend far past the rim. Spring-firing walls add a brighter gold
  // halo on top.
  const haloStyle = `rgba(80, 200, 250, ${haloAlpha + 0.08})`
  for (const d of drawList) {
    strokeWallLayer(d, 14, haloStyle)
    const fire = springFireGlow(d)
    if (fire > 0) strokeWallLayer(d, 22, `rgba(255, 200, 80, ${0.5 * fire})`)
  }
  // Pass 2 — mid glows
  const midStyle = `rgba(120, 215, 250, ${midAlpha})`
  for (const d of drawList) {
    strokeWallLayer(d, 9, midStyle)
    const fire = springFireGlow(d)
    if (fire > 0) strokeWallLayer(d, 13, `rgba(255, 220, 100, ${0.7 * fire})`)
  }
  // Pass 3 — bright cyan rims (will be partially covered by bodies; only the perimeter shows).
  // Spring-fire walls swap to bright white-gold for visceral color shift.
  for (const d of drawList) {
    const fire = springFireGlow(d)
    const style = fire > 0
      ? `rgba(${Math.floor(190 + 65 * fire)}, ${Math.floor(245 - 35 * fire)}, ${Math.floor(255 - 155 * fire)}, ${rimAlpha + 0.15 * fire})`
      : `rgba(190, 245, 255, ${rimAlpha})`
    strokeWallLayer(d, 4, style)
  }
  // Pass 4 — bodies. Default = dark navy. Spring-firing walls lerp toward bright orange so
  // the bounce is unmissable. Drawn LAST so they cover any rim crossover at shared endpoints.
  for (const d of drawList) {
    const fire = springFireGlow(d)
    const bodyStyle = fire > 0
      ? `rgba(${Math.floor(35 + (255 - 35) * fire)}, ${Math.floor(50 + (175 - 50) * fire)}, ${Math.floor(70 - 70 * fire)}, 1)`
      : 'rgba(35, 50, 70, 1)'
    strokeWallLayer(d, 0, bodyStyle)
  }
  // Pass 5 — inner shockwave on spring fire. Bright wave expands from the spine outward to
  // the rim, clipped to the wall body interior. Pillars get a concentric ring growing from
  // center, capsules get two parallel bars sliding from the spine to the rim. Reads as
  // "energy released from inside the wall" without spraying particles into the play area.
  for (const d of drawList) {
    const w = d.w
    if (!w.spring || w.springLastFireBeat == null) continue
    const cycle = w.spring.beatsPerCycle
    // Shockwave duration slightly longer than the visual pulse (0.15 beats) so the wave
    // has time to reach the rim before fading. Capped per cycle so fast tempos shrink it.
    const shockDur = Math.min(0.22, cycle * 0.32)
    const beatsSinceFire = beatPosForSpring - w.springLastFireBeat
    if (beatsSinceFire < 0 || beatsSinceFire >= shockDur) continue
    const progress = beatsSinceFire / shockDur   // 0 at fire → 1 at rim
    drawInnerShockwave(d, progress)
  }
  // For rotating / pendulum walls, brighter outer rim flash + halo pulse so motion reads
  // as "this thing is alive" even when momentarily near zero angular velocity (especially
  // important for pendulums at the turnaround points where they pause). Checks groupMotion
  // so every wall in a moving group flashes — not just the wall that owns the motion.
  for (const d of drawList) {
    const mt = d.w.groupMotion?.type
    const hasMotion = mt === 'rotate' || mt === 'pendulum' || mt === 'tick'
    const hasTranslation = !!d.w.groupTranslation
    if (!hasMotion && !hasTranslation) continue
    const motionPulse = 0.5 + 0.5 * Math.sin(now / 320)
    strokeWallLayer(d, 6, `rgba(255, 215, 64, ${0.18 + motionPulse * 0.18})`)
  }

  ctx.lineCap = 'butt'
  drawWallsOverlay()
}

// Designer-only overlays (hover-delete highlight + drag-ghost + selection handles).
// Extracted so drawWalls can call it even when there are no placed walls (so the drag
// ghost still renders on an empty arena).
function drawWallsOverlay(): void {
  if (getPhase() !== 'designer') return
  const wallsRef = getWalls()

  // No-clip indicator — dashed red rim around any wall tagged noClip. Designer-only visual
  // cue that "this wall is isolated, won't auto-group with neighbors, isn't a snap target."
  ctx.save()
  ctx.setLineDash([5, 4])
  ctx.lineCap = 'butt'
  ctx.strokeStyle = 'rgba(255, 80, 80, 0.85)'
  ctx.lineWidth = 2
  for (const w of wallsRef) {
    if (!w.noClip) continue
    const ax = w.ax - camX, ay = w.ay - camY
    const bx = w.bx - camX, by = w.by - camY
    const dxw = bx - ax, dyw = by - ay
    const isPillar = dxw * dxw + dyw * dyw < 0.5
    if (isPillar) {
      ctx.beginPath()
      ctx.arc(ax, ay, w.radius + 3, 0, Math.PI * 2)
      ctx.stroke()
    } else {
      ctx.lineCap = 'round'
      ctx.lineWidth = w.radius * 2 + 6
      ctx.beginPath()
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
      // Outline as a thicker hollow stroke isn't trivial with line dash; use a thin dashed
      // perimeter built from two parallel lines + arc caps instead. Approximation: thick
      // dashed stroke around the spine reads as "danger ring" even if it's just a thick line.
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.18)'
      ctx.stroke()
      ctx.strokeStyle = 'rgba(255, 80, 80, 0.85)'
      ctx.lineWidth = 2
      ctx.lineCap = 'butt'
    }
  }
  ctx.restore()

  // Selection outline — gold pulsing band drawn under the hover red so a hovered selected
  // wall still shows the red "will delete" treatment on top. The interactive HANDLES
  // (endpoints + curve diamond) get drawn LATER, after the hover overlay, so they're never
  // obscured by the red — the user always sees what they can click on.
  const selIdx = getSelectedWallIdx()
  let selData: { w: Wall; ax: number; ay: number; bx: number; by: number; thick: number; isPillar: boolean } | null = null
  if (selIdx >= 0 && selIdx < wallsRef.length) {
    const w = wallsRef[selIdx]!
    const ax = w.ax - camX
    const ay = w.ay - camY
    const bx = w.bx - camX
    const by = w.by - camY
    const thick = w.radius * 2
    const dxw = bx - ax
    const dyw = by - ay
    const isPillar = dxw * dxw + dyw * dyw < 0.5
    selData = { w, ax, ay, bx, by, thick, isPillar }
    const sPulse = 0.5 + 0.5 * Math.sin(performance.now() / 300)
    ctx.lineCap = 'round'
    if (isPillar) {
      ctx.beginPath()
      ctx.arc(ax, ay, w.radius + 5, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 215, 64, ${0.85 + sPulse * 0.15})`
      ctx.lineWidth = 2
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
      ctx.strokeStyle = `rgba(255, 215, 64, ${0.85 + sPulse * 0.15})`
      ctx.lineWidth = thick + 6
      ctx.stroke()
    }
    ctx.lineCap = 'butt'
  }

  // Designer hover preview — red overlay on the wall the cursor is over so the player
  // knows which one right-click would delete. Drawn additively to leave the wall visible.
  {
    const hi = getHoveredWallIdx()
    if (hi >= 0 && hi < wallsRef.length) {
      const w = wallsRef[hi]!
      const ax = w.ax - camX
      const ay = w.ay - camY
      const bx = w.bx - camX
      const by = w.by - camY
      const thick = w.radius * 2
      const dxw = bx - ax
      const dyw = by - ay
      const isPillar = dxw * dxw + dyw * dyw < 0.5
      const hPulse = 0.5 + 0.5 * Math.sin(performance.now() / 220)
      ctx.lineCap = 'round'
      if (isPillar) {
        // Red halo + outline ring
        ctx.beginPath()
        ctx.arc(ax, ay, w.radius + 8, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 80, 80, ${0.28 + hPulse * 0.12})`
        ctx.fill()
        ctx.beginPath()
        ctx.arc(ax, ay, w.radius + 2, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 100, 100, ${0.95})`
        ctx.lineWidth = 2
        ctx.stroke()
      } else {
        ctx.beginPath()
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
        ctx.strokeStyle = `rgba(255, 80, 80, ${0.28 + hPulse * 0.12})`
        ctx.lineWidth = thick + 14
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
        ctx.strokeStyle = `rgba(255, 100, 100, ${0.95})`
        ctx.lineWidth = thick + 4
        ctx.stroke()
      }
      ctx.lineCap = 'butt'
    }
  }

  // Selection HANDLES — drawn AFTER the hover red overlay so a hovered selected wall still
  // shows its endpoint + curve handles on top of the red (otherwise the red would swallow
  // them and the user couldn't see what to click).
  if (selData) {
    const { w, ax, ay, bx, by, isPillar } = selData
    // Dashed chord guide for bent walls — reference line showing the straight A→B chord
    if (!isPillar && (w.bend ?? 0) !== 0) {
      ctx.save()
      ctx.setLineDash([5, 5])
      ctx.beginPath()
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
      ctx.strokeStyle = 'rgba(255, 215, 64, 0.5)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.restore()
    }
    // Endpoint handles — yellow squares with dark border
    const drawHandle = (hx: number, hy: number) => {
      const s = 14
      ctx.fillStyle = 'rgba(255, 215, 64, 0.95)'
      ctx.fillRect(hx - s / 2, hy - s / 2, s, s)
      ctx.strokeStyle = 'rgba(40, 30, 0, 1)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(hx - s / 2, hy - s / 2, s, s)
    }
    if (isPillar) drawHandle(ax, ay)
    else { drawHandle(ax, ay); drawHandle(bx, by) }
    // Curve handle — cyan diamond at the apex (or midpoint for a straight wall)
    if (!isPillar) {
      const apex = getWallCurveHandle(w)
      const hx = apex.x - camX
      const hy = apex.y - camY
      const s = 8
      ctx.save()
      ctx.translate(hx, hy)
      ctx.rotate(Math.PI / 4)
      ctx.fillStyle = 'rgba(128, 216, 255, 0.95)'
      ctx.fillRect(-s, -s, s * 2, s * 2)
      ctx.strokeStyle = 'rgba(0, 40, 60, 1)'
      ctx.lineWidth = 1.5
      ctx.strokeRect(-s, -s, s * 2, s * 2)
      ctx.restore()
    }
  }

  // Designer-only: ghost preview of the in-progress wall drag. Dashed bright cyan capsule
  // at the user-selected thickness so they see exactly what they'll get on release.
  if (getPhase() === 'designer' && getPlaceTool() === 'wall') {
    const drag = getWallDrag()
    if (drag) {
      const gThick = getWallThickness() * 2
      const gax = drag.startX - camX
      const gay = drag.startY - camY
      const gbx = drag.curX - camX
      const gby = drag.curY - camY
      const gdx = gbx - gax
      const gdy = gby - gay
      const gLen2 = gdx * gdx + gdy * gdy
      // Only draw if drag has measurable extent
      if (gLen2 > 0.5) {
        ctx.lineCap = 'round'
        // Soft halo
        ctx.beginPath()
        ctx.moveTo(gax, gay); ctx.lineTo(gbx, gby)
        ctx.strokeStyle = 'rgba(128, 216, 255, 0.20)'
        ctx.lineWidth = gThick + 14
        ctx.stroke()
        // Dashed body fill (semi-transparent)
        ctx.setLineDash([12, 8])
        ctx.beginPath()
        ctx.moveTo(gax, gay); ctx.lineTo(gbx, gby)
        ctx.strokeStyle = 'rgba(128, 216, 255, 0.55)'
        ctx.lineWidth = gThick
        ctx.stroke()
        // Crisp dashed center line
        ctx.beginPath()
        ctx.moveTo(gax, gay); ctx.lineTo(gbx, gby)
        ctx.strokeStyle = 'rgba(220, 245, 255, 0.95)'
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.setLineDash([])
        ctx.lineCap = 'butt'
      }
      // Endpoint markers (filled dots) so the snap targets are obvious
      ctx.beginPath()
      ctx.arc(gax, gay, 4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(220, 245, 255, 0.95)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(gbx, gby, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Prefab ghost preview — purple ghosts of all prefab walls translated + rotated to cursor.
  // Each wall is drawn as a translucent capsule/arc at the same thickness it'll have on drop.
  const prefab = getPlacingPrefab()
  if (prefab) {
    const cur = getPrefabCursor()
    const rot = getPrefabRotation()
    const cos = Math.cos(rot), sin = Math.sin(rot)
    ctx.lineCap = 'round'
    for (const w of prefab.walls) {
      // Apply rotation around (0,0) to the relative coords, then translate to cursor
      const rax = w.ax * cos - w.ay * sin
      const ray = w.ax * sin + w.ay * cos
      const rbx = w.bx * cos - w.by * sin
      const rby = w.bx * sin + w.by * cos
      const wx0 = rax + cur.x, wy0 = ray + cur.y
      const wx1 = rbx + cur.x, wy1 = rby + cur.y
      const ax = wx0 - camX, ay = wy0 - camY
      const bx = wx1 - camX, by = wy1 - camY
      const thick = w.radius * 2
      const dxw = bx - ax, dyw = by - ay
      const isPillar = dxw * dxw + dyw * dyw < 0.5
      // Compute arc if bent — match the live renderer's geometry
      const shifted: Wall = { ax: wx0, ay: wy0, bx: wx1, by: wy1, radius: w.radius, ...(w.bend != null ? { bend: w.bend } : {}) }
      const arcWorld = computeWallArc(shifted)
      ctx.beginPath()
      if (isPillar) {
        ctx.arc(ax, ay, w.radius, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(180, 140, 255, 0.30)'
        ctx.fill()
      } else if (arcWorld) {
        ctx.arc(arcWorld.cx - camX, arcWorld.cy - camY, arcWorld.r, arcWorld.aA, arcWorld.aB, !arcWorld.antiClockwise)
        ctx.strokeStyle = 'rgba(180, 140, 255, 0.55)'
        ctx.lineWidth = thick
        ctx.stroke()
      } else {
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
        ctx.strokeStyle = 'rgba(180, 140, 255, 0.55)'
        ctx.lineWidth = thick
        ctx.stroke()
      }
    }
    // Cursor crosshair (small + at cursor world position) so the drop anchor is visible
    const cx = cur.x - camX
    const cy = cur.y - camY
    ctx.strokeStyle = 'rgba(220, 200, 255, 0.9)'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy)
    ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8)
    ctx.stroke()
    ctx.lineCap = 'butt'
  }

  // Pivot diamond + spokes — drawn when the selected wall's group has a motion config.
  // Gold diamond at the actual rotation pivot (bbox center + offset). Faint spokes from
  // the diamond to each wall in the group communicate the rotation relationship. When in
  // pivot-set mode, the diamond pulses and a target ring appears at the cursor to invite
  // a click — though we don't have the cursor position here, the pulse alone signals mode.
  const pivot = getSelectedWallPivotWorld()
  if (pivot) {
    const px = pivot.x - camX
    const py = pivot.y - camY
    const inPivotMode = isPivotSetMode()
    const atCenter = Math.abs(pivot.offset.x) < 0.5 && Math.abs(pivot.offset.y) < 0.5
    // Spokes from pivot to every wall in the selected group's bbox extent
    const selIdxP = getSelectedWallIdx()
    if (selIdxP >= 0) {
      // Reach across all walls in the group to draw spokes
      ctx.save()
      ctx.strokeStyle = 'rgba(255, 215, 64, 0.22)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 4])
      // Without group info exposed to renderer, just draw a single spoke to the selected wall's midpoint.
      const sw = wallsRef[selIdxP]
      if (sw) {
        const mx = (sw.ax + sw.bx) / 2 - camX
        const my = (sw.ay + sw.by) / 2 - camY
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(mx, my)
        ctx.stroke()
      }
      ctx.restore()
    }
    // Diamond marker — bright gold when off-center or in pivot-set mode, dim grey when default
    const pulse = inPivotMode ? (0.6 + 0.4 * Math.sin(performance.now() / 180)) : 1
    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(Math.PI / 4)
    const s = 7
    ctx.fillStyle = atCenter && !inPivotMode ? 'rgba(160, 160, 160, 0.9)' : `rgba(255, 215, 64, ${0.95 * pulse})`
    ctx.fillRect(-s, -s, s * 2, s * 2)
    ctx.strokeStyle = 'rgba(40, 30, 0, 1)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(-s, -s, s * 2, s * 2)
    ctx.restore()
    // Inner dot at exact pivot point
    ctx.beginPath()
    ctx.arc(px, py, 1.8, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)'
    ctx.fill()
    // Outer ring when in pivot-set mode (signals "click to place")
    if (inPivotMode) {
      ctx.beginPath()
      ctx.arc(px, py, 18 + 4 * Math.sin(performance.now() / 200), 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 215, 64, ${0.4 * pulse})`
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }

  // Snap point dots — drawn LAST so they sit on top of the gold selection outline, hover
  // red, endpoint handles, and curve diamond. Otherwise the thick selection stroke covers
  // every internal snap point and the user only sees handles at the endpoints. Cyan halo +
  // bright core dot at every snap point of every wall (1 for pillar, 3 for short capsule,
  // 5 for long capsule ≥ 40px). noClip walls return no points → no dots → visually obvious.
  const showSnap = getSelectedWallIdx() >= 0 || !!getWallDrag() || !!getEndpointDrag() || getPlaceTool() === 'pillar'
  if (showSnap) {
    ctx.save()
    for (const w of wallsRef) {
      const pts = getWallSnapPoints(w)
      for (const pt of pts) {
        const sx = pt.x - camX, sy = pt.y - camY
        // Halo
        ctx.beginPath()
        ctx.arc(sx, sy, 7, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(120, 220, 255, 0.35)'
        ctx.fill()
        // Bright core dot
        ctx.beginPath()
        ctx.arc(sx, sy, 3.2, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(180, 245, 255, 1)'
        ctx.fill()
        // Dark rim around core for contrast against the gold selection background
        ctx.beginPath()
        ctx.arc(sx, sy, 3.2, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(0, 40, 70, 0.9)'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
    ctx.restore()
  }
}

function drawChillZone(): void {
  if (!chillZoneViz) return
  const cz = chillZoneViz
  const sx = cz.x - camX
  const sy = cz.y - camY
  const now = performance.now()
  const t = now / 1000
  const breathe = 0.5 + 0.5 * Math.sin(now / 700)
  const slowRot = now / 4500

  // (1) Base radial fill — soft cyan, breathing alpha
  const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, cz.radius)
  g.addColorStop(0, `rgba(128, 216, 255, ${0.20 + breathe * 0.06})`)
  g.addColorStop(0.65, `rgba(100, 200, 245, ${0.13 + breathe * 0.05})`)
  g.addColorStop(1, `rgba(80, 180, 235, 0)`)
  ctx.beginPath()
  ctx.arc(sx, sy, cz.radius, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()

  // Clip everything below to the zone circle so layers don't leak past the edge.
  ctx.save()
  ctx.beginPath()
  ctx.arc(sx, sy, cz.radius, 0, Math.PI * 2)
  ctx.clip()

  // (A) Hex tile floor pattern — faint flat-top hex grid pulsing with the breathe envelope.
  // Suggests ice's molecular structure. Stroke-only, very low alpha so it sits under the
  // other layers without dominating. Rendered in world coords so the grid stays anchored to
  // the zone (not panning with camera in a distracting way).
  {
    const hexR = 48
    const hexW = hexR * 2
    const hexH = hexR * Math.sqrt(3)
    const colStep = hexR * 1.5
    const rowStep = hexH
    // Bounding box of the zone in world space
    const x0 = cz.x - cz.radius
    const x1 = cz.x + cz.radius
    const y0 = cz.y - cz.radius
    const y1 = cz.y + cz.radius
    // Snap iteration grid to multiples of stride so the pattern is stable as zone moves
    const startCol = Math.floor(x0 / colStep)
    const endCol = Math.ceil(x1 / colStep)
    const startRow = Math.floor(y0 / rowStep)
    const endRow = Math.ceil(y1 / rowStep)
    ctx.strokeStyle = `rgba(180, 230, 255, ${0.10 + breathe * 0.05})`
    ctx.lineWidth = 1
    for (let col = startCol; col <= endCol; col++) {
      const cxw = col * colStep
      const offset = (col & 1) ? rowStep * 0.5 : 0
      for (let row = startRow; row <= endRow; row++) {
        const cyw = row * rowStep + offset
        const hx = cxw - camX
        const hy = cyw - camY
        // Skip hexes whose center is well outside the zone (still inside clip path though)
        const dx = cxw - cz.x
        const dy = cyw - cz.y
        if (dx * dx + dy * dy > (cz.radius + hexR) * (cz.radius + hexR)) continue
        ctx.beginPath()
        for (let v = 0; v < 6; v++) {
          const va = (v / 6) * Math.PI * 2
          const vx = hx + Math.cos(va) * hexR
          const vy = hy + Math.sin(va) * hexR
          if (v === 0) ctx.moveTo(vx, vy)
          else ctx.lineTo(vx, vy)
        }
        ctx.closePath()
        ctx.stroke()
      }
    }
    // Suppress unused-var warnings from the simple bounds-only computation
    void hexW
  }

  // (D) Drifting cold mist — 4 stateless soft blobs that orbit the zone center with phase
  // offsets driven by sin combinations. No persistent state needed; positions are derived
  // from time + index each frame, so they drift smoothly without arrays.
  {
    const mistCount = 4
    for (let i = 0; i < mistCount; i++) {
      const orbitAngle = (t * 0.18) + (i / mistCount) * Math.PI * 2 + Math.sin(t * 0.5 + i * 1.3) * 0.4
      const orbitR = cz.radius * (0.25 + 0.30 * (0.5 + 0.5 * Math.sin(t * 0.4 + i * 2.1)))
      const mx = sx + Math.cos(orbitAngle) * orbitR
      const my = sy + Math.sin(orbitAngle) * orbitR
      const blobR = cz.radius * 0.32 + Math.sin(t * 0.6 + i * 2.7) * cz.radius * 0.08
      const mg = ctx.createRadialGradient(mx, my, 0, mx, my, blobR)
      mg.addColorStop(0, `rgba(210, 240, 255, 0.13)`)
      mg.addColorStop(0.5, `rgba(190, 230, 255, 0.06)`)
      mg.addColorStop(1, `rgba(190, 230, 255, 0)`)
      ctx.beginPath()
      ctx.arc(mx, my, blobR, 0, Math.PI * 2)
      ctx.fillStyle = mg
      ctx.fill()
    }
  }

  // (B) Beat-synced cold pulse — expanding white-cyan ring on every beat. Phase derived from
  // PatternClock.getLoopPosition() so it stays locked to the game's rhythm. The ring expands
  // from center to slightly past the zone edge over one beat, fading as it grows. Clipped to
  // the zone so the "cold containing itself" feel is preserved.
  {
    const beatPhase = getLoopPosition() % 1
    const pulseR = beatPhase * cz.radius * 1.08
    const pulseAlpha = (1 - beatPhase) * 0.45
    if (pulseR > 6 && pulseAlpha > 0.02) {
      ctx.beginPath()
      ctx.arc(sx, sy, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(225, 245, 255, ${pulseAlpha})`
      ctx.lineWidth = 2 + (1 - beatPhase) * 3.5
      ctx.stroke()
      // Inner core line for double-stroke clarity
      ctx.beginPath()
      ctx.arc(sx, sy, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${pulseAlpha * 0.6})`
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
  }

  // Snowflake clusters scattered inside — 6-pointed asterisks, slow counter-rotation (kept
  // from before; they're the "ice crystals on the ground" layer between the hex grid and
  // the tendrils).
  ctx.save()
  ctx.translate(sx, sy)
  ctx.rotate(-slowRot * 0.6)
  const flakes = 5
  for (let i = 0; i < flakes; i++) {
    const a = (i / flakes) * Math.PI * 2
    const dist = cz.radius * (0.4 + (i % 2) * 0.25)
    const fx = Math.cos(a) * dist
    const fy = Math.sin(a) * dist
    const fr = 9 + (i % 2) * 3
    ctx.strokeStyle = `rgba(220, 245, 255, ${0.45 + breathe * 0.2})`
    ctx.lineWidth = 1.4
    for (let arm = 0; arm < 6; arm++) {
      const aa = (arm / 6) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(fx, fy)
      ctx.lineTo(fx + Math.cos(aa) * fr, fy + Math.sin(aa) * fr)
      ctx.stroke()
    }
  }
  ctx.restore()

  ctx.restore()   // end inner-clip — tendrils and sparkles render unclipped

  // (C) Rotating ice shards at the edge — replaces the dashed/tendril perimeter. N small
  // elongated-diamond crystals sit AT the perimeter, each spinning independently in their
  // own direction and speed. Phase-cycled visibility (grow → hold → fade) staggers their
  // life so the edge always has a few crystals appearing while others fade. The rotation
  // sells the "alive ice" feel and justifies the freeze-on-touch interaction.
  {
    const N = 29
    const cycleDur = 2.0  // seconds per full grow→hold→fade cycle
    // Faint solid outline so the perimeter is always slightly readable
    ctx.beginPath()
    ctx.arc(sx, sy, cz.radius - 1, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(160, 220, 250, ${0.16 + breathe * 0.08})`
    ctx.lineWidth = 1.5
    ctx.stroke()
    for (let i = 0; i < N; i++) {
      const baseAngle = (i / N) * Math.PI * 2 + Math.sin(i * 1.13) * 0.02
      // Pseudo-random per-shard phase + rotation params
      const phaseOff = (i * 0.317) % 1
      const ph = ((t / cycleDur) + phaseOff) % 1
      let vis: number
      if (ph < 0.18) vis = ph / 0.18              // grow
      else if (ph < 0.78) vis = 1                 // hold
      else vis = 1 - (ph - 0.78) / 0.22           // fade
      if (vis < 0.04) continue
      const cxw = sx + Math.cos(baseAngle) * cz.radius
      const cyw = sy + Math.sin(baseAngle) * cz.radius
      // Each shard spins at its own speed and direction
      const spinDir = (i & 1) ? 1 : -1
      const spinRate = 1.4 + (i % 5) * 0.35
      const shardRot = t * spinRate * spinDir + i * 0.7
      const shardSize = 9 + (i % 4) * 1.5
      const longHalf = shardSize * 1.15
      const shortHalf = shardSize * 0.42
      // Grow-in scale also tied to vis so shards "snap into" their full size as they appear
      const growScale = vis < 0.4 ? vis / 0.4 : 1
      ctx.save()
      ctx.translate(cxw, cyw)
      ctx.rotate(shardRot)
      ctx.scale(growScale, growScale)
      // Soft halo backdrop — wider diamond, fades vis
      ctx.beginPath()
      ctx.moveTo(longHalf * 1.4, 0)
      ctx.lineTo(0, shortHalf * 1.4)
      ctx.lineTo(-longHalf * 1.4, 0)
      ctx.lineTo(0, -shortHalf * 1.4)
      ctx.closePath()
      ctx.fillStyle = `rgba(140, 215, 250, ${0.35 * vis})`
      ctx.fill()
      // Cyan body
      ctx.beginPath()
      ctx.moveTo(longHalf, 0)
      ctx.lineTo(0, shortHalf)
      ctx.lineTo(-longHalf, 0)
      ctx.lineTo(0, -shortHalf)
      ctx.closePath()
      ctx.fillStyle = `rgba(200, 235, 255, ${0.82 * vis})`
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.95 * vis})`
      ctx.lineWidth = 1.2
      ctx.stroke()
      // Highlight slash across the body for "polished crystal" look
      ctx.beginPath()
      ctx.moveTo(-longHalf * 0.5, -shortHalf * 0.3)
      ctx.lineTo(longHalf * 0.4, shortHalf * 0.2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.7 * vis})`
      ctx.lineWidth = 0.8
      ctx.stroke()
      ctx.restore()
    }
  }

  // (E) Glint sparkles — tiny static white particles flickering in random positions inside
  // the zone. Implemented via the particle system (no velocity, short lifetime) so they
  // self-fade and don't need extra state. Sparse enough not to spam.
  if (Math.random() < 0.55) {
    const sa = Math.random() * Math.PI * 2
    const sd = cz.radius * Math.sqrt(Math.random()) * 0.92
    spawnParticle(cz.x + Math.cos(sa) * sd, cz.y + Math.sin(sa) * sd,
      0, 0,
      255, 255, 255, 0.18 + Math.random() * 0.12, 1.2 + Math.random() * 1.0)
  }

  // Drift particles (existing) — small ice crystals floating up from random spots
  if (Math.random() < 0.45) {
    const a = Math.random() * Math.PI * 2
    const d = cz.radius * Math.sqrt(Math.random()) * 0.92
    const px = cz.x + Math.cos(a) * d
    const py = cz.y + Math.sin(a) * d
    spawnParticle(px, py, (Math.random() - 0.5) * 18, -30 - Math.random() * 25,
      200 + Math.floor(Math.random() * 55), 230 + Math.floor(Math.random() * 25), 255,
      0.7 + Math.random() * 0.4, 2 + Math.random() * 2)
  }
}

function updateAndDrawChillFX(dt: number): void {
  // Ice shards — animate inward from perimeter with rotation, fade out near end
  for (let i = iceShards.length - 1; i >= 0; i--) {
    const s = iceShards[i]!
    s.timer += dt
    if (s.timer >= s.lifetime) {
      iceShards[i] = iceShards[iceShards.length - 1]!
      iceShards.pop()
      continue
    }
    const t = s.timer / s.lifetime
    // Ease-out distance — fast start, slow finish
    const ease = 1 - (1 - t) * (1 - t)
    const dist = s.startDist + (s.endDist - s.startDist) * ease
    const cx = s.ox + s.dx * dist - camX
    const cy = s.oy + s.dy * dist - camY
    s.rot += s.rotVel * dt
    const alpha = 1 - t * t
    // Elongated diamond shape — point in direction of travel
    const longLen = s.size * 1.8
    const shortLen = s.size * 0.55
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(Math.atan2(s.dy, s.dx) + s.rot * 0.2)
    ctx.beginPath()
    ctx.moveTo(longLen, 0)
    ctx.lineTo(0, shortLen)
    ctx.lineTo(-longLen * 0.7, 0)
    ctx.lineTo(0, -shortLen)
    ctx.closePath()
    ctx.fillStyle = `rgba(200, 235, 255, ${0.85 * alpha})`
    ctx.fill()
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.9 * alpha})`
    ctx.lineWidth = 1.2
    ctx.stroke()
    ctx.restore()
  }
  // Frost cracks — central bright shock-ring expanding + flash, fades fast
  for (let i = frostCracks.length - 1; i >= 0; i--) {
    const f = frostCracks[i]!
    f.timer += dt
    if (f.timer >= f.lifetime) {
      frostCracks[i] = frostCracks[frostCracks.length - 1]!
      frostCracks.pop()
      continue
    }
    const t = f.timer / f.lifetime
    const cx = f.x - camX
    const cy = f.y - camY
    // Expanding ring
    const ringR = f.radius * (0.2 + t * 0.9)
    ctx.beginPath()
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(220, 245, 255, ${0.85 * (1 - t)})`
    ctx.lineWidth = 4 + (1 - t) * 4
    ctx.stroke()
    // Central flash for the first ~30% of lifetime
    if (t < 0.3) {
      const flashT = 1 - t / 0.3
      ctx.beginPath()
      ctx.arc(cx, cy, f.radius * 0.35 * flashT, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${0.6 * flashT})`
      ctx.fill()
    }
  }
  // Mini snowflakes — drift with velocity + slight gravity + drag, rotate, fade out.
  for (let i = miniSnowflakes.length - 1; i >= 0; i--) {
    const f = miniSnowflakes[i]!
    f.timer += dt
    if (f.timer >= f.lifetime) {
      miniSnowflakes[i] = miniSnowflakes[miniSnowflakes.length - 1]!
      miniSnowflakes.pop()
      continue
    }
    // Physics: position update, gravity, drag
    f.x += f.vx * dt
    f.y += f.vy * dt
    f.vy += 35 * dt           // gentle gravity
    f.vx *= 1 - dt * 0.7      // drag — flakes settle
    f.vy *= 1 - dt * 0.45
    f.rot += f.rotVel * dt
    const tt = f.timer / f.lifetime
    // Fade in fast (0–15%), hold, fade out (last 50%)
    const alpha = tt < 0.15 ? tt / 0.15 : Math.max(0, 1 - (tt - 0.5) / 0.5)
    const sx = f.x - camX
    const sy = f.y - camY
    ctx.save()
    ctx.translate(sx, sy)
    ctx.rotate(f.rot)
    // Wide soft halo
    ctx.strokeStyle = `rgba(160, 220, 250, ${0.55 * alpha})`
    ctx.lineWidth = 2.6
    ctx.lineCap = 'round'
    for (let arm = 0; arm < 6; arm++) {
      const aa = (arm / 6) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(aa) * f.size, Math.sin(aa) * f.size)
      ctx.stroke()
    }
    // Crisp white core
    ctx.strokeStyle = `rgba(240, 250, 255, ${0.9 * alpha})`
    ctx.lineWidth = 1.0
    for (let arm = 0; arm < 6; arm++) {
      const aa = (arm / 6) * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(aa) * f.size, Math.sin(aa) * f.size)
      ctx.stroke()
    }
    ctx.lineCap = 'butt'
    ctx.restore()
  }
}

export function triggerBeatDashFlash(x: number, y: number, radius: number): void {
  beatDashFlash = 0.444
  beatDashX = x
  beatDashY = y
  beatDashRadius = radius
  // Lightning at the AOE center — reads as the source radiating outward. Two layers:
  // a tight inner cluster of short bolts (the "core arc"), and a longer outer ring that
  // reaches roughly to where enemy bolts will spawn so the spread visually connects.
  const innerCount = 9
  const innerScale = 1.4
  const innerLen = radius * 0.74
  const innerLife = 0.36
  for (let i = 0; i < innerCount; i++) {
    const a = (i / innerCount) * Math.PI * 2 + Math.random() * 0.5
    spawnStaticLightningBolt(x, y, a, innerLen * (0.75 + Math.random() * 0.5), innerScale, innerLife + Math.random() * 0.06)
  }
  const outerCount = 6
  const outerScale = 1.1
  const outerLen = radius * 1.37
  const outerLife = 0.30
  for (let i = 0; i < outerCount; i++) {
    const a = (i / outerCount) * Math.PI * 2 + Math.random() * 0.8
    spawnStaticLightningBolt(x, y, a, outerLen * (0.8 + Math.random() * 0.35), outerScale, outerLife + Math.random() * 0.06)
  }
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
    // Spinning particles spiral + rise like embers
    if (p.spinRate) {
      const fade = p.life  // 0→1 over lifetime
      const pull = fade * 15.0  // spiral tightens as particle fades
      // Rotate velocity inward
      const cos = Math.cos(pull * dt)
      const sin = Math.sin(pull * dt) * (p.spinRate > 0 ? 1 : -1)
      const nvx = p.vx * cos - p.vy * sin
      const nvy = p.vx * sin + p.vy * cos
      p.vx = nvx
      p.vy = nvy
      // Ember rise — gentle upward drift that increases as they fade
      p.vy -= 60 * fade * dt
      // Flicker drift — slight horizontal wobble
      p.vx += Math.sin(p.life * 20 + p.x * 0.1) * 15 * dt
    }
    if (p.life >= 1) {
      particles[i] = particles[particles.length - 1]!
      particles.pop()
    }
  }
}

// Pre-rendered glow sprites for tinted particles — cached once, drawImage'd at runtime.
// Each sprite is a heavily-blurred circular blob (shape doesn't matter when blurred). Drawn
// UNDER the particle's sharp body. Massive perf win over per-frame shadowBlur.
function makeGlowSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const blurRadius = 40
  const innerR = 5
  const total = (innerR + blurRadius) * 2 + 4
  const c = document.createElement('canvas')
  c.width = total
  c.height = total
  const sctx = c.getContext('2d')!
  sctx.translate(total / 2, total / 2)
  sctx.fillStyle = `rgb(${r}, ${g}, ${b})`
  sctx.shadowColor = `rgba(${r}, ${g}, ${b}, 1)`
  sctx.shadowBlur = blurRadius
  // 5 draws bake a denser halo into the sprite (paid once, free at runtime)
  for (let i = 0; i < 5; i++) {
    sctx.beginPath()
    sctx.arc(0, 0, innerR, 0, Math.PI * 2)
    sctx.fill()
  }
  return c
}
// Lazy cache keyed by RGB — first time each color is requested, sprite is rendered
const glowSpriteCache = new Map<number, HTMLCanvasElement>()
function getGlowSprite(r: number, g: number, b: number): HTMLCanvasElement {
  // Pack 8-bit RGB into one int (faster + smaller key than a string)
  const key = (r << 16) | (g << 8) | b
  let s = glowSpriteCache.get(key)
  if (!s) { s = makeGlowSprite(r, g, b); glowSpriteCache.set(key, s) }
  return s
}

function drawParticles(): void {
  for (const p of particles) {
    const t = 1 - p.life
    // bright early, sine ease-out tail (smoother than linear)
    const alpha = Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5)
    const sx = p.x - camX
    const sy = p.y - camY
    const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
    const baseShrink = 0.65 + t * 0.35  // starts full, shrinks to 65% as it fades
    const shrink = p.spinRate ? t * t : baseShrink  // spinning particles shrink to nothing
    const hs = p.size * shrink / 2
    // Ember tint — spinning particles shift toward warm orange/red as they fade
    let dr = p.r, dg = p.g, db = p.b
    if (p.spinRate) {
      const emberT = p.life * p.life  // accelerating warmth
      dr = Math.min(255, p.r + Math.floor(emberT * (255 - p.r) * 0.6))
      dg = Math.floor(p.g * (1 - emberT * 0.5) + emberT * 80)
      db = Math.floor(p.b * (1 - emberT * 0.8))
    }
    let tintBlend = 0
    if (p.tintR >= 0) {
      // Color tint — 0.1s delay then fast blend toward target (red or gold for ring explosions)
      const delay = 0.1 / p.lifetime
      tintBlend = Math.min(1, Math.max(0, p.life - delay) * 3.3)
      dr = Math.round(p.r + (p.tintR - p.r) * tintBlend)
      dg = Math.round(p.g + (p.tintG - p.g) * tintBlend)
      db = Math.round(p.b + (p.tintB - p.b) * tintBlend)
    }
    ctx.fillStyle = `rgba(${dr}, ${dg}, ${db}, ${alpha})`
    ctx.save()
    ctx.translate(sx, sy)
    // Cached glow sprite UNDER the particle — fades in with tintBlend. drawImage is ~100× cheaper
    // than per-frame shadowBlur. Drawn with `lighter` composite so overlapping glows add brightness
    // (real-light behavior), making bursts pop without per-particle cost.
    if (tintBlend > 0) {
      const sprite = getGlowSprite(p.tintR, p.tintG, p.tintB)
      const glowScale = Math.max(0.7, hs / 5) * (0.9 + tintBlend * 0.5)
      const dim = sprite.width * glowScale
      const prevAlpha = ctx.globalAlpha
      const prevComp = ctx.globalCompositeOperation
      ctx.globalAlpha = Math.min(1, alpha * tintBlend * 1.3)
      ctx.globalCompositeOperation = 'lighter'
      ctx.drawImage(sprite, -dim / 2, -dim / 2, dim, dim)
      ctx.globalAlpha = prevAlpha
      ctx.globalCompositeOperation = prevComp
    }
    if (speed > 60) {
      const angle = Math.atan2(p.vy, p.vx)
      ctx.rotate(angle)
      const stretch = Math.min(speed / 80, 3)
      const hw = hs * stretch * 2.25
      const hh = hs * 1.05
      ctx.beginPath()
      ctx.moveTo(-hw, 0)
      ctx.lineTo(0, -hh)
      ctx.lineTo(hw, 0)
      ctx.lineTo(0, hh)
      ctx.closePath()
      ctx.fill()
    } else {
      const spin = p.spinRate ? p.life * p.spinRate : p.life * 2.7 + (p.x * 0.01)
      ctx.rotate(spin)
      ctx.fillRect(-hs, -hs, p.size, p.size)
    }
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
  lightningBolts.length = 0
  spawnEffects.length = 0
  absorbEffects.length = 0
  volatileExplosions.length = 0
  pendingExplosionVisuals = []
  revengeRings.length = 0
  toasts.length = 0
  borderWaveIntensity = 0
  globalBeatPulse = 0
  outerPulseIntensity = 0
  dashSweepIntensity = 0
  dashSweepPath = []
  shieldDisplayProgress = 0
  gameTimeMs = 0
  dashReadyFlash.length = 0
  shieldActivateSweep = 0
  shieldPulsePhase = 0
  shieldFuseCompletionFlash = 0
}

export function render(player: Player, enemies: Enemy[], _alpha: number, fps = 0, dt = 0.016, cam?: Camera): void {
  csWasDrawn = false
  // Portrait orientation check — mobile phones only (not desktop touchscreens)
  const isMobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  if (isMobileDevice && window.innerWidth < window.innerHeight) {
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
  if (getPhase() === 'playing' || getPhase() === 'designer') gameTimeMs += dt * 1000

  // Designer zoom-out: center the camera on the arena (not the player) and scale down so
  // more of the world fits on screen. `camX/camY` math stays unchanged for downstream draws,
  // it just covers a larger world area when zoom < 1 (because the canvas is then scaled up
  // by ctx.scale below — the world-to-screen calc is `(worldX - camX) * zoom`).
  const isZoomedDesigner = designerZoomedOut && getPhase() === 'designer'
  const renderZoom = isZoomedDesigner ? DESIGNER_ZOOM : 1
  if (isZoomedDesigner) {
    camX = ARENA_CX - width / (2 * renderZoom)
    camY = ARENA_CY - height / (2 * renderZoom)
  } else if (cam) {
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

  // Designer zoom-out — scale world rendering so more of the arena fits on screen.
  // HUD/UI rendered later is NOT scaled (we restore before drawHUD).
  if (renderZoom !== 1) {
    ctx.save()
    ctx.scale(renderZoom, renderZoom)
  }

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
  // Arena walls — drawn under all entities (floor layer), above the arena fill
  drawWalls()
  // Chill Zone slow-field — on the arena floor, under enemies/orbs/player
  drawChillZone()
  perfStart('ripples')
  updateAndDrawDeathRipples(lastDt)
  updateAndDrawLightningBolts(lastDt)
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

  // Capture enemy ring peak positions (needed for overlay pass later)
  perfStart('e_rings')
  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    if (!enemy.dying) {
      for (const rs of enemy.rings) {
        const pastPeak = rs.attackTimer - rs.expandTime
        if (pastPeak >= 0 && !rs.peakCaptured) {
          rs.peakX = enemy.x
          rs.peakY = enemy.y
          rs.peakCaptured = true
        }
      }
    }
  }
  perfEnd('e_rings')

  perfStart('e_bodies')
  // Draw shrines first (ground layer, under everything)
  for (const enemy of enemies) {
    if (!enemy.isShrine) continue
    if (!enemy.alive && !enemy.dying) continue
    if (enemy.dying) {
      drawEnemy(enemy, player)  // use enemy death animation (dissolve + ripples)
    } else {
      drawShrine(enemy, player)
    }
  }
  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    if (enemy.isShrine) continue  // already drawn above
    drawEnemy(enemy, player)
  }
  perfEnd('e_bodies')

  // Dodge trails — rendered AFTER all enemy bodies so the trail layers on top of any body
  // (otherwise enemies drawn later in the loop cover the dasher's silhouettes). Particles
  // are also spawned here for the same reason — the spawn-then-render is one-frame-correct.
  for (const enemy of enemies) {
    if (!enemy.dodge || enemy.dashTimer < 0 || !enemy.alive || enemy.dying) continue
    const r = enemy.radius
    // Dash trail uses player's dash green for unified visual language
    const tdr = 100, tdg = 255, tdb = 120
    if (enemy.dashPath.length > 1) {
      const tr = Math.round(enemy.cr * 0.55 + tdr * 0.45)
      const tg = Math.round(enemy.cg * 0.55 + tdg * 0.45)
      const tb = Math.round(enemy.cb * 0.55 + tdb * 0.45)
      const trailLen = enemy.dashPath.length
      for (let i = 0; i < trailLen; i++) {
        const p = enemy.dashPath[i]!
        const t = i / Math.max(1, trailLen - 1)
        const alpha = 0.02 + t * 0.10
        ctx.beginPath()
        ctx.arc(p.x - camX, p.y - camY, r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, ${alpha})`
        ctx.fill()
      }
    }
    if (enemy.dashTimer > 0) {
      const partScale = Math.max(1.5, r * 0.06)
      const count = r >= 60 ? 3 : 2
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2
        const px = enemy.x + Math.cos(a) * r * (0.5 + Math.random() * 0.5)
        const py = enemy.y + Math.sin(a) * r * (0.5 + Math.random() * 0.5)
        spawnParticle(px, py,
          -enemy.dashDirX * 30 + (Math.random() - 0.5) * 20,
          -enemy.dashDirY * 30 + (Math.random() - 0.5) * 20,
          tdr, tdg, tdb, 0.35, partScale)
      }
    }
  }

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
      dashSweepIntensity *= 0.88
      if (dashSweepIntensity < 0.01) dashSweepIntensity = 0

      // Disintegration particles as the sweep fades
      if (dashSweepIntensity > 0.05 && dashSweepPath.length > 1) {
        const count = Math.ceil(dashSweepIntensity * 16)
        for (let p = 0; p < count; p++) {
          const pt = dashSweepPath[Math.floor(Math.random() * dashSweepPath.length)]!
          const angle = Math.random() * Math.PI * 2
          const grace2 = 8
          const dist = dashSweepRadius + (Math.random() - 0.5) * grace2 * 2
          const px = pt.x + Math.cos(angle) * dist
          const py = pt.y + Math.sin(angle) * dist
          const speed = 40 + Math.random() * 60
          const outA = angle + (Math.random() - 0.5) * 2.5
          const isRed = Math.random() < 0.4
          spawnParticle(px, py,
            Math.cos(outA) * speed, Math.sin(outA) * speed - 20,
            isRed ? 255 : 255, isRed ? 60 : 200, isRed ? 50 : 60,
            0.2 + Math.random() * 0.15, 3 + Math.random() * 3)
        }
      }
    }

    if (dashSweepIntensity > 0.01 && dashSweepPath.length > 1) {
      const fade = dashSweepIntensity
      const grace = 8
      // Draw along curved path — filled zone with bright edges
      for (let s = 0; s < dashSweepPath.length; s++) {
        const pt = dashSweepPath[s]!
        const sx = pt.x - camX
        const sy = pt.y - camY
        const posT = s / dashSweepPath.length  // 0 = oldest, 1 = newest
        // Bright gold-white fill that fades along the trail
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 200, 60, ${0.45 * fade * (0.3 + posT * 0.7)})`
        ctx.lineWidth = grace * 2
        ctx.stroke()
        // Inner bright core
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 255, 200, ${0.25 * fade * (0.3 + posT * 0.7)})`
        ctx.lineWidth = grace
        ctx.stroke()
      }
      // Crisp edge rings — gold outer, white inner
      for (const edgeR of [dashSweepRadius + grace, Math.max(0, dashSweepRadius - grace)]) {
        ctx.beginPath()
        for (const pt of dashSweepPath) {
          const sx = pt.x - camX
          const sy = pt.y - camY
          ctx.moveTo(sx + edgeR, sy)
          ctx.arc(sx, sy, edgeR, 0, Math.PI * 2)
        }
        ctx.strokeStyle = `rgba(255, 215, 64, ${0.8 * fade})`
        ctx.lineWidth = 2
        ctx.stroke()
      }
      // Red danger fill — every position, drawn on top
      for (let s = 0; s < dashSweepPath.length; s++) {
        const pt = dashSweepPath[s]!
        const sx = pt.x - camX
        const sy = pt.y - camY
        // Red filled band across the sweep zone
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 40, 40, ${0.35 * fade})`
        ctx.lineWidth = grace * 1.6
        ctx.stroke()
        // Bright red edges
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius + grace, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 60, 60, ${0.6 * fade})`
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(sx, sy, Math.max(0, dashSweepRadius - grace), 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 60, 60, ${0.6 * fade})`
        ctx.lineWidth = 2
        ctx.stroke()
      }
      // Center ring — bright white
      ctx.beginPath()
      for (const pt of dashSweepPath) {
        const sx = pt.x - camX
        const sy = pt.y - camY
        ctx.moveTo(sx + dashSweepRadius, sy)
        ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
      }
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 * fade})`
      ctx.lineWidth = 2
      ctx.stroke()
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

  // Aftershock telegraph — ticking pie under the player marking pending detonations
  updateAndDrawPendingDetonations(lastDt)

  // Echo Step anchor + recall visuals — anchor marker on the ground, ghost streak during warp
  drawEchoStep(player)

  // Beat dash AOE flash — drawn BEFORE the player so the player visibly stands on top
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
    // Total-area gold glow flash — extends slightly past the hitbox edge
    {
      const glowR = beatDashRadius * 1.5
      const grad = ctx.createRadialGradient(bsx, bsy, 0, bsx, bsy, glowR)
      grad.addColorStop(0, `rgba(255, 240, 160, ${t * 0.85})`)
      grad.addColorStop(0.38, `rgba(255, 215, 90, ${t * 0.55})`)
      grad.addColorStop(0.85, `rgba(255, 190, 50, ${t * 0.18})`)
      grad.addColorStop(1, `rgba(255, 180, 40, 0)`)
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.arc(bsx, bsy, glowR, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()
      ctx.globalCompositeOperation = prevComp
    }
    // Red danger fill
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 40, 40, ${t * t * 0.42})`
    ctx.fill()
    // Gold shockwave expanding to fill attack range
    const shockExpand = Math.min((1 - t) * 3, 1)
    const shockR = beatDashRadius * shockExpand
    if (shockR > 2) {
      ctx.beginPath()
      ctx.arc(bsx, bsy, shockR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 215, 64, ${t * t * 0.2})`
      ctx.fill()
      ctx.strokeStyle = `rgba(255, 200, 40, ${t * t * 0.6})`
      ctx.lineWidth = 5 * t
      ctx.stroke()
    }
    // Red danger edge
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 60, 60, ${t * 0.78})`
    ctx.lineWidth = 3 * t + 1.5
    ctx.stroke()
    // Cyan border
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(0, 255, 255, ${t * 0.12})`
    ctx.lineWidth = 8 * t
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
          0, 230, 255, 0.18 + Math.random() * 0.10, 7 + Math.random() * 5)
      }
    }
    // Disintegration particles breaking off the edge
    if (Math.random() < 0.6 + (1 - t) * 0.4) {
      const count = Math.ceil(3 + (1 - t) * 4)
      for (let p = 0; p < count; p++) {
        const pa = Math.random() * Math.PI * 2
        const dist = beatDashRadius * (0.6 + Math.random() * 0.4)
        const px = beatDashX + Math.cos(pa) * dist
        const py = beatDashY + Math.sin(pa) * dist
        const speed = 20 + Math.random() * 40
        const outA = pa + (Math.random() - 0.5) * 1.5
        const isBlueP = Math.random() < 0.2
        spawnParticle(px, py,
          Math.cos(outA) * speed, Math.sin(outA) * speed - 15,
          isBlueP ? 0 : 255, isBlueP ? 200 + Math.floor(Math.random() * 55) : 180 + Math.floor(Math.random() * 60), isBlueP ? 255 : 20 + Math.floor(Math.random() * 40),
          0.14 + Math.random() * 0.10, 4 + Math.random() * 3)
      }
    }
  }

  perfStart('player')
  drawPlayer(player)
  perfEnd('player')

  // Enemy rings + revenge rings — drawn on top of player so attacks overlay
  perfStart('e_rings_overlay')
  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    if (!enemy.dying) {
      const arcs = blockedArcsCache.get(enemy) ?? []
      for (const rs of enemy.rings) {
        const pastPeak = rs.attackTimer - rs.expandTime
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
  perfEnd('e_rings_overlay')

  // Chill Zone climax visuals — ice shards flying inward + frost-crack shock-ring. Drawn
  // ABOVE enemies + rings so the ice storm reads as the climactic event of the replacement.
  updateAndDrawChillFX(lastDt)

  // Dash-fail flash timer (just decrements — read by pie render to tint red)
  if (dashFailFlash > 0) { dashFailFlash -= lastDt; if (dashFailFlash < 0) dashFailFlash = 0 }

  updateAndDrawSpawnEffects(lastDt)
  updateAndDrawAbsorbEffects(lastDt, player)

  if (__DEV__) {
    drawDesignerPreview(player)
    drawSpawnPanel()
    drawChallengePlacements()
  }

  // End designer zoom-out transform — HUD and UI render in unscaled screen space below
  if (renderZoom !== 1) {
    ctx.restore()
  }

  drawHUD(player, enemies, fps)
  perfEnd('R_TOTAL')
  perfFlush()

  // Perf overlay — dev only, gated
  if (__DEV__ && debugOverlayVisible) {
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
function drawArcWithGapsResolved(cx: number, cy: number, radius: number, arcs: { start: number; end: number }[]): void {
  if (arcs.length === 0) {
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, Math.PI * 2)
    ctx.stroke()
    return
  }

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

  // Skip per-frame particle spawning when frozen on the death screen. The ring's
  // attackTimer is pinned to expandTime there (see GameManager death-check), which would
  // otherwise re-spawn trail + peak-burst particles every frame and spam the system.
  // Deterministic strokes below still render — the ring stays visible as a static echo.
  const isFrozenDeath = getPhase() === 'dead'

  // Trail particles — reduced count to leave room for explosions
  if (!isFrozenDeath && buildup > 0.3) {
    const trailCount = Math.floor(buildup * 2)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, trailCount, 20 + buildup * 40, 0.3, 2, blockedArcs)
  }

  // Explosion at peak — white-hot sparks racing along the ring circumference
  if (!isFrozenDeath && showRedRing && pastPeak < lastDt * 2 && particles.length < MAX_PARTICLES - 20) {
    const ringScale = Math.max(1, currentRadius / 140)
    const totalCount = Math.round(21 * ringScale)
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
      // Tangential velocity — races along the ring
      const dir = i % 2 === 0 ? 1 : -1  // alternating CW/CCW
      const tangentAngle = angle + (Math.PI / 2) * dir
      const tangentSpeed = 240 + Math.random() * 360
      // Slight inward pull
      const inwardSpeed = -(40 + Math.random() * 40)
      const vx = Math.cos(tangentAngle) * tangentSpeed + Math.cos(angle) * inwardSpeed
      const vy = Math.sin(tangentAngle) * tangentSpeed + Math.sin(angle) * inwardSpeed
      const isRed = i % 10 === 0
      const isWhite = !isRed && i % 4 === 0
      const lt = 0.16 + Math.random() * 0.12  // short life — punchy
      const sz = (isWhite ? 7.7 : 6.5) * (0.9 + Math.random() * 0.3)
      const pr = isRed ? 255 : isWhite ? 255 : Math.min(255, ri + 100)
      const pg = isRed ? 60 + Math.floor(Math.random() * 40) : isWhite ? 255 : Math.min(255, gi + 60)
      const pb = isRed ? 50 + Math.floor(Math.random() * 30) : isWhite ? 255 : Math.min(255, bi + 60)
      // Tint target drives BOTH the color blend AND the glow halo color.
      // Player ring particles tint to red or gold (sweep-dash combo).
      // Enemy ring particles tint to their own color (no visible shift, but glow still fires).
      const isPlayerRing = ring.owner === 'player'
      const tintGold = Math.random() < 0.5
      let tR: number, tG: number, tB: number
      if (isRed) { tR = -1; tG = 0; tB = 0 }   // already pure red, skip
      else if (isPlayerRing) { tR = 255; tG = tintGold ? 200 : 50; tB = tintGold ? 60 : 50 }
      else { tR = pr; tG = pg; tB = pb }   // enemy: glow only, no color shift
      spawnParticle(px, py, vx, vy, pr, pg, pb, lt, sz, 0, tR, tG, tB)
    }
  }

  // Resolve blocked arcs once — reuse for all draw passes
  const resolvedArcs = blockedArcs.length > 0 ? resolveArcs(blockedArcs) : []

  // Soft outer glow
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${alpha * 0.15})`
  ctx.lineWidth = lineW + 8
  drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)

  // Mid glow
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${alpha * 0.3})`
  ctx.lineWidth = lineW + 3
  drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)

  // Main ring — sharp crisp stroke
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${Math.min(1, alpha * 1.2)})`
  ctx.lineWidth = lineW + 0.5
  drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)

  // White-gold flash at exact peak — bright, unmissable (tuned up: extra wide halo + denser glow)
  if (showRedRing && pastPeak < 0.05) {
    const peakFlash = 1 - (pastPeak / 0.05)
    // Extra wide outer halo — softens the peak into the surrounding space
    ctx.strokeStyle = `rgba(255, 230, 130, ${peakFlash * 0.22})`
    ctx.lineWidth = lineW * 7
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
    // Wide hot glow (bumped alpha + slightly wider)
    ctx.strokeStyle = `rgba(255, 220, 100, ${peakFlash * 0.65})`
    ctx.lineWidth = lineW * 4.5
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
    // Bright white core ring
    ctx.strokeStyle = `rgba(255, 255, 255, ${peakFlash * 0.95})`
    ctx.lineWidth = lineW * 2
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
    // Sharp edge
    ctx.strokeStyle = `rgba(255, 255, 255, ${peakFlash})`
    ctx.lineWidth = 1.5
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
  }

  // Red flash at peak
  if (showRedRing) {
    const redAlpha = 0.8 * (1 - pastPeak / 0.2)
    // Wide outer glow
    ctx.strokeStyle = `rgba(255, 100, 100, ${redAlpha * 0.08})`
    ctx.lineWidth = 26
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
    // Soft red glow
    ctx.strokeStyle = `rgba(255, 100, 100, ${redAlpha * 0.18})`
    ctx.lineWidth = 10
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
    // Mid red
    ctx.strokeStyle = `rgba(255, 80, 80, ${redAlpha * 0.5})`
    ctx.lineWidth = 5
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
    // Sharp red core
    ctx.strokeStyle = `rgba(255, 80, 80, ${redAlpha})`
    ctx.lineWidth = 3
    drawArcWithGapsResolved(sx, sy, currentRadius, resolvedArcs)
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

    // Soft outer glow — flat circle, no gradient
    const glowR = r + (isDouble ? 6 : 4)
    ctx.beginPath()
    ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
    if (ringOver) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
    } else {
      ctx.fillStyle = `rgba(${orbR}, ${orbG}, ${orbB}, ${isDouble ? 0.06 : 0.04})`
    }
    ctx.fill()

    // Orb body — outer ring + bright inner core (replaces per-frame gradient)
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${orbR}, ${orbG}, ${orbB}, 0.55)`
    ctx.fill()
    // Bright highlight — full body, brighter center
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${Math.min(255, orbR + 80)}, ${Math.min(255, orbG + 40)}, ${Math.min(255, orbB + 40)}, 0.2)`
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
    const iconAlpha = ringOver ? 0.95 : (0.8 + globalBeatPulse * 0.15)
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, iconAlpha)})`
    ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, iconAlpha)})`
    if (isHP) {
      // Heart — single combined path
      const hs = iconScale * 2.2
      const cy = sy - hs * 0.1
      const humpR = hs * 0.45
      const lx = sx - humpR * 0.9  // left hump center
      const rx = sx + humpR * 0.9  // right hump center
      const hy = cy - hs * 0.15    // hump center y
      // Cached white glow sprite under the heart — large + low alpha so the bright sprite
      // center disappears and only a soft halo remains around the heart shape.
      {
        const sprite = getGlowSprite(255, 255, 255)
        const dim = hs * 7
        const prevComp = ctx.globalCompositeOperation
        const prevAlpha = ctx.globalAlpha
        ctx.globalCompositeOperation = 'lighter'
        ctx.globalAlpha = Math.min(1, 0.32 + orbBeat * 0.45)
        ctx.drawImage(sprite, sx - dim / 2, cy - dim / 2, dim, dim)
        ctx.globalAlpha = prevAlpha
        ctx.globalCompositeOperation = prevComp
      }
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

  // Glow aura — soft radial gradient behind player, pulses on beat.
  // On hit, swap to red glow with more brightness held in the "past the body" band so
  // the halo reads reliably outside the player (inner stops sit closer to body edge,
  // and use `lighter` composite on hit to punch through whatever's underneath).
  {
    const beatPulse = globalBeatPulse
    const hitT = player.hitFlash > 0 ? player.hitFlash / HIT_FLASH_DURATION : 0
    const glowRadius = baseRadius * (2.5 + beatPulse * 0.8 + hitT * 1.6)
    const glowAlpha = 0.18 + beatPulse * 0.22 + hitT * 0.7
    const r = hitT > 0 ? 255 : 79
    const g = hitT > 0 ? Math.floor(50 + 145 * (1 - hitT)) : 195
    const b = hitT > 0 ? Math.floor(50 + 197 * (1 - hitT)) : 247
    const innerR = hitT > 0 ? baseRadius * 0.55 : baseRadius * 0.3
    const grad = ctx.createRadialGradient(sx, sy, innerR, sx, sy, glowRadius)
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glowAlpha})`)
    grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${glowAlpha * 0.55})`)
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
    const prevComp = ctx.globalCompositeOperation
    if (hitT > 0) ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.globalCompositeOperation = prevComp
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

  // Ghost dash — semi-transparent + white shimmer. Echo Step's recall traversal piggybacks
  // on the same visual (it's also unconditionally invulnerable), so we treat any active
  // recall as "ghost dashing" for rendering purposes regardless of the upgrade flag.
  const isGhostDashing = (player.dashTimer >= 0 && hasBonus('ghostDash')) || player.recallTimer >= 0
  if (isGhostDashing) {
    ctx.globalAlpha = 0.4 + Math.sin(performance.now() / 50) * 0.15
  }

  // Hit shrink + color fade
  let drawRadius = baseRadius
  let fillColor = isGhostDashing ? 'rgba(255, 255, 255, 0.2)' : 'rgba(0, 255, 255, 0.22)'
  let strokeColor = isGhostDashing ? '#FFFFFF' : COLOR_PLAYER
  if (player.hitFlash > 0) {
    const t = player.hitFlash / HIT_FLASH_DURATION // 1 = just hit, 0 = recovered
    const isDead = getPhase() === 'dead'
    drawRadius = isDead ? baseRadius : baseRadius * (0.67 + 0.33 * (1 - t)) // no shrink on death
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

  // Slipstream water-wave ribbon — three offset sine waves trailing along the dash path,
  // perpendicular to motion direction. Tapers to zero at both endpoints so the wave reads as
  // "ripples in the wake" rather than starting/ending abruptly. Only drawn on chained dashes
  // (dashChainBoost > 1), which is how Slipstream announces itself visually.
  if (player.dashTimer >= 0 && player.dashChainBoost > 1 && player.dashPath.length >= 2) {
    const path = player.dashPath
    const fade = player.dashTimer / player.dashDuration
    const time = performance.now() / 1000
    // Precompute arclength + tangent perpendicular per point — both loops below reuse them.
    const perpX: number[] = new Array(path.length)
    const perpY: number[] = new Array(path.length)
    const arc: number[] = new Array(path.length)
    let accum = 0
    for (let i = 0; i < path.length; i++) {
      const pt = path[i]!
      let tx: number, ty: number
      if (i === 0 && path.length > 1) {
        const nx = path[1]!
        tx = nx.x - pt.x; ty = nx.y - pt.y
      } else if (i > 0) {
        const pv = path[i - 1]!
        tx = pt.x - pv.x; ty = pt.y - pv.y
        accum += Math.sqrt(tx * tx + ty * ty)
      } else {
        tx = 1; ty = 0
      }
      const len = Math.sqrt(tx * tx + ty * ty) || 1
      perpX[i] = -ty / len
      perpY[i] = tx / len
      arc[i] = accum
    }
    // Layers, deepest-to-brightest. Outer halo is intentionally wide + soft for the "cresting
    // foam" glow; inner layers carry the actual wave shape.
    const layers = [
      { amp: 38, freq: 0.040, phaseOff: 0,   r: 0,   g: 160, b: 200, a: 0.40, w: 18 },  // outer halo
      { amp: 34, freq: 0.048, phaseOff: 0,   r: 38,  g: 198, b: 218, a: 0.95, w: 8  },  // deep teal body
      { amp: 24, freq: 0.070, phaseOff: 1.4, r: 130, g: 230, b: 248, a: 0.85, w: 4.5 }, // mid highlight
      { amp: 15, freq: 0.105, phaseOff: 2.8, r: 240, g: 252, b: 255, a: 0.85, w: 2.2 }, // bright core
    ]
    ctx.lineCap = 'round'
    const prevComp = ctx.globalCompositeOperation
    for (const L of layers) {
      // Outer halo uses 'lighter' so multiple wave crests bloom into each other; tighter
      // strands keep 'source-over' so they read as crisp ribbon edges.
      ctx.globalCompositeOperation = L.w >= 18 ? 'lighter' : 'source-over'
      ctx.beginPath()
      for (let i = 0; i < path.length; i++) {
        const pt = path[i]!
        // Taper to 0 amplitude at the start (oldest point) and end (player); peaks mid-trail.
        const u = path.length > 1 ? i / (path.length - 1) : 0
        const taper = Math.sin(u * Math.PI)
        const w = Math.sin(arc[i]! * L.freq + time * 13 + L.phaseOff) * L.amp * taper
        const ox = pt.x - camX + perpX[i]! * w
        const oy = pt.y - camY + perpY[i]! * w
        if (i === 0) ctx.moveTo(ox, oy)
        else ctx.lineTo(ox, oy)
      }
      ctx.strokeStyle = `rgba(${L.r}, ${L.g}, ${L.b}, ${L.a * fade})`
      ctx.lineWidth = L.w
      ctx.stroke()
    }
    // A second pass MIRRORED (negative amplitude) gives the ribbon a symmetric "stream" look
    // — two waves cross-weaving along the path like a braid.
    for (const L of layers) {
      ctx.globalCompositeOperation = L.w >= 18 ? 'lighter' : 'source-over'
      ctx.beginPath()
      for (let i = 0; i < path.length; i++) {
        const pt = path[i]!
        const u = path.length > 1 ? i / (path.length - 1) : 0
        const taper = Math.sin(u * Math.PI)
        const w = -Math.sin(arc[i]! * L.freq + time * 13 + L.phaseOff) * L.amp * taper
        const ox = pt.x - camX + perpX[i]! * w
        const oy = pt.y - camY + perpY[i]! * w
        if (i === 0) ctx.moveTo(ox, oy)
        else ctx.lineTo(ox, oy)
      }
      ctx.strokeStyle = `rgba(${L.r}, ${L.g}, ${L.b}, ${L.a * fade})`
      ctx.lineWidth = L.w
      ctx.stroke()
    }
    ctx.globalCompositeOperation = prevComp
    ctx.lineCap = 'butt'
    // Dense droplet spray fanning off both sides — chunky enough to read as splash, not mist.
    const sprayCount = 3
    for (let s = 0; s < sprayCount; s++) {
      if (Math.random() < 0.9 * fade) {
        const dirAngle = Math.atan2(player.dashDirY, player.dashDirX)
        const side = Math.random() < 0.5 ? 1 : -1
        const offA = dirAngle + side * (Math.PI / 2 + (Math.random() - 0.5) * 0.6)
        const sp = 160 + Math.random() * 160
        const dropSize = 4 + Math.random() * 4
        spawnParticle(player.x, player.y,
          Math.cos(offA) * sp, Math.sin(offA) * sp,
          150 + Math.floor(Math.random() * 70), 225 + Math.floor(Math.random() * 30), 255,
          0.32 + Math.random() * 0.22, dropSize)
      }
    }
    // Periodic splash ring at the player's current position — a brief expanding circle every
    // few frames that "blooms" off the leading edge of the dash. Cheap and very legible.
    if (Math.random() < 0.28 * fade) {
      const baseR = drawRadius * (0.9 + Math.random() * 0.6)
      ctx.beginPath()
      ctx.arc(player.x - camX, player.y - camY, baseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(180, 235, 255, ${0.55 * fade})`
      ctx.lineWidth = 2.5
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(player.x - camX, player.y - camY, baseR * 0.65, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(230, 250, 255, ${0.75 * fade})`
      ctx.lineWidth = 1.6
      ctx.stroke()
    }
  }

  // HP fractions — needed by both blood particles and pie chart
  const hpFraction = player.displayHp / player.maxHp
  const actualPlayerHp = player.hp / player.maxHp
  const hpStart = -Math.PI / 2
  const hpEnd = hpStart + hpFraction * Math.PI * 2

  // Hit particles — burst from inside the damage wedge
  if (player.hitFlash > HIT_FLASH_DURATION - 0.02 && player.shieldBreakFlash <= 0) {
    // Player velocity estimate for blood momentum
    const pvx = (player.x - player.prevX) / Math.max(frameDt, 0.001)
    const pvy = (player.y - player.prevY) / Math.max(frameDt, 0.001)
    const bloodOffPX = pvx * 0.08
    const bloodOffPY = pvy * 0.08
    const dmgFraction = 1 / player.maxHp
    const intensity = Math.min(Math.max(dmgFraction / 0.05, 1), 3)
    const count = Math.floor(16 * intensity)
    const dmgArcStart = hpStart + actualPlayerHp * Math.PI * 2
    const dmgArcEnd = dmgArcStart + dmgFraction * Math.PI * 2
    const arcSpan = dmgArcEnd - dmgArcStart
    for (let i = 0; i < count; i++) {
      const angle = dmgArcStart + Math.random() * arcSpan
      const dist = Math.random() * drawRadius
      const px = player.x + bloodOffPX + Math.cos(angle) * dist
      const py = player.y + bloodOffPY + Math.sin(angle) * dist
      const speed = (274 + Math.random() * 430) * (0.8 + intensity * 0.2)
      const outAngle = Math.atan2(py - player.y, px - player.x)
      const spread = (Math.random() - 0.5) * speed * 0.2
      const size = (2.4 + Math.random() * 2.4) * (0.8 + intensity * 0.2)
      const isBlue = Math.random() < 0.2
      spawnParticle(px, py,
        Math.cos(outAngle) * speed + spread + pvx, Math.sin(outAngle) * speed + spread + pvy,
        isBlue ? 79 : 255, isBlue ? 195 : 60 + Math.floor(Math.random() * 45), isBlue ? 247 : 55,
        0.31 + Math.random() * 0.22, size)
    }
    // Extra center spray — white-hot core burst
    for (let i = 0; i < 6; i++) {
      const angle = dmgArcStart + Math.random() * arcSpan
      const speed = 147 + Math.random() * 317
      spawnParticle(player.x + bloodOffPX, player.y + bloodOffPY,
        Math.cos(angle) * speed + pvx, Math.sin(angle) * speed + pvy,
        255, 200 + Math.floor(Math.random() * 55), 180, 0.31 + Math.random() * 0.22, 3 + Math.random() * 2)
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
    // Red draining wedge — same vocabulary as enemy red drain, brightened so it reads clearly
    if (hpFraction > actualPlayerHp) {
      const actualEnd = hpStart + actualPlayerHp * Math.PI * 2
      const redGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      redGrad.addColorStop(0, 'rgba(255, 90, 90, 0.85)')
      redGrad.addColorStop(0.7, 'rgba(255, 50, 50, 0.7)')
      redGrad.addColorStop(1, 'rgba(220, 30, 30, 0.55)')
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, actualEnd, hpEnd)
      ctx.closePath()
      ctx.fillStyle = redGrad
      ctx.fill()
    }

    // Main HP fill — radial gradient for depth
    const fillFraction = Math.min(hpFraction, actualPlayerHp)
    const mainEnd = hpStart + fillFraction * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
    ctx.closePath()
    if (isGhostDashing) {
      ctx.fillStyle = fillColor
    } else if (player.hitFlash > 0) {
      const t = player.hitFlash / HIT_FLASH_DURATION
      const bodyGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      bodyGrad.addColorStop(0, `rgba(255, ${Math.floor(220 * (1 - t))}, ${Math.floor(220 * (1 - t))}, ${0.7 + t * 0.3})`)
      bodyGrad.addColorStop(0.35, `rgba(255, ${Math.floor(80 * (1 - t))}, ${Math.floor(60 * (1 - t))}, ${0.55 + t * 0.25})`)
      bodyGrad.addColorStop(1, `rgba(240, ${Math.floor(40 * (1 - t))}, ${Math.floor(20 * (1 - t))}, ${0.35 + t * 0.2})`)
      ctx.fillStyle = bodyGrad
    } else {
      const bp = globalBeatPulse * 0.4
      const shielded = player.shieldCharges > 0
      const bodyGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      if (shielded) {
        bodyGrad.addColorStop(0, `rgba(255, 220, 255, ${0.6 + bp})`)
        bodyGrad.addColorStop(0.35, `rgba(230, 170, 255, ${0.48 + bp * 0.5})`)
        bodyGrad.addColorStop(1, `rgba(190, 120, 245, ${0.32 + bp * 0.3})`)
      } else {
        bodyGrad.addColorStop(0, `rgba(210, 255, 255, ${0.58 + bp})`)
        bodyGrad.addColorStop(0.35, `rgba(80, 240, 255, ${0.45 + bp * 0.5})`)
        bodyGrad.addColorStop(1, `rgba(40, 200, 245, ${0.28 + bp * 0.3})`)
      }
      ctx.fillStyle = bodyGrad
    }
    ctx.fill()

    // Low HP beat pulse — when HP is at 30% or less, the remaining HP wedge flashes white
    // on every beat. Uses a radial gradient (white center → faded edge) so it layers with
    // the HP's existing radial-gradient texture instead of flattening it.
    if (actualPlayerHp > 0 && actualPlayerHp <= 0.3 && globalBeatPulse > 0.02 && player.hitFlash <= 0) {
      const a = Math.min(1, globalBeatPulse * 1.0)
      const pulseGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      pulseGrad.addColorStop(0, `rgba(255, 255, 255, ${a})`)
      pulseGrad.addColorStop(0.35, `rgba(255, 255, 255, ${a * 0.85})`)
      pulseGrad.addColorStop(1, `rgba(255, 255, 255, ${a * 0.5})`)
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
      ctx.closePath()
      ctx.fillStyle = pulseGrad
      ctx.fill()
    }

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

    // HP segment lines — across full pie including missing health
    if (player.maxHp <= 40) {
      const now = performance.now()
      const segBeat = player.attackTimer >= 0 && player.attackTimer < ATTACK_EXPAND_TIME
        ? Math.min(player.attackTimer / (ATTACK_EXPAND_TIME * 0.80), 0.6)
        : globalBeatPulse
      const segInner = drawRadius * (0.60 - segBeat * 0.30)
      for (let i = 0; i < player.maxHp; i++) {
        const phase = (i / player.maxHp) * Math.PI * 2
        const wave = 0.5 + 0.5 * Math.sin(now / 800 - phase * 1.5)
        const isMissing = i >= player.hp
        const segAlpha = isMissing ? 0.15 + wave * 0.15 : 0.12 + wave * 0.18
        const segAngle = hpStart + (i / player.maxHp) * Math.PI * 2
        const ix = sx + Math.cos(segAngle) * segInner
        const iy = sy + Math.sin(segAngle) * segInner
        const ox = sx + Math.cos(segAngle) * drawRadius
        const oy = sy + Math.sin(segAngle) * drawRadius
        // Glow layer
        const shielded = player.shieldCharges > 0
        ctx.beginPath()
        ctx.moveTo(ix, iy)
        ctx.lineTo(ox, oy)
        ctx.strokeStyle = isMissing
          ? shielded
            ? `rgba(255, 50, 200, ${segAlpha + 0.15})`
            : `rgba(255, 80, 80, ${segAlpha})`
          : shielded
            ? `rgba(255, 50, 200, ${segAlpha + 0.35})`
            : `rgba(180, 230, 255, ${segAlpha * 0.6})`
        ctx.lineWidth = isMissing ? (shielded ? 5 : 3) : shielded ? 6 : 4
        ctx.stroke()
        // Core line
        ctx.beginPath()
        ctx.moveTo(ix, iy)
        ctx.lineTo(ox, oy)
        ctx.strokeStyle = isMissing
          ? shielded
            ? `rgba(255, 180, 255, ${segAlpha + 0.25})`
            : `rgba(255, 150, 150, ${segAlpha + 0.1})`
          : shielded
            ? `rgba(255, 180, 255, ${segAlpha + 0.5})`
            : `rgba(230, 210, 255, ${segAlpha + 0.12})`
        ctx.lineWidth = isMissing ? (shielded ? 2 : 1) : shielded ? 2.5 : 1.5
        ctx.stroke()
        // Hit flash — bright red overlay on every segment line (filled + missing).
        // Uses 'lighter' so it punches over whatever color was drawn underneath.
        if (player.hitFlash > 0) {
          const hitT = player.hitFlash / HIT_FLASH_DURATION
          const prevComp = ctx.globalCompositeOperation
          ctx.globalCompositeOperation = 'lighter'
          ctx.beginPath()
          ctx.moveTo(ix, iy)
          ctx.lineTo(ox, oy)
          ctx.strokeStyle = `rgba(255, 40, 40, ${hitT * 0.95})`
          ctx.lineWidth = 4.5
          ctx.stroke()
          ctx.globalCompositeOperation = prevComp
        }
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

    // Persistent scan glare — pink band ping-ponging top↔bottom, beat-synced
    // (1 beat top→bottom, next beat bottom→top — full cycle = 2 beats).
    {
      const cycle = (getLoopPosition() * 2) % 2        // 0→2 over 1 beat (double-time)
      const scanT = cycle < 1 ? cycle : 2 - cycle      // ping-pong 0→1→0
      const scanY = sy - drawRadius + scanT * drawRadius * 2
      const bandH = drawRadius * 0.55
      ctx.save()
      ctx.beginPath()
      ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
      ctx.clip()
      const grad = ctx.createLinearGradient(sx, scanY - bandH, sx, scanY + bandH)
      grad.addColorStop(0, 'rgba(255, 50, 200, 0)')
      grad.addColorStop(0.5, 'rgba(255, 200, 250, 0.28)')
      grad.addColorStop(1, 'rgba(255, 50, 200, 0)')
      ctx.fillStyle = grad
      ctx.fillRect(sx - drawRadius, scanY - bandH, drawRadius * 2, bandH * 2)
      ctx.restore()
    }

    // Core energy ring
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 50, 200, ${0.85 + fastPulse * 0.15})`
    ctx.lineWidth = 4 + pulse * 0.5
    ctx.stroke()

    // Hot inner edge
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius - 0.5, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 180, 240, ${0.25 + fastPulse * 0.15})`
    ctx.lineWidth = 1
    ctx.stroke()


    // Ambient shield sparks — edge + interior
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
    // Interior shield particles — float inside the body, solid pink
    if (Math.random() < 0.6) {
      const ia = Math.random() * Math.PI * 2
      const idist = Math.random() * drawRadius * 0.85
      spawnParticle(
        player.x + Math.cos(ia) * idist,
        player.y + Math.sin(ia) * idist,
        (Math.random() - 0.5) * 20, -12 - Math.random() * 25,
        255, 50, 200,
        0.2 + Math.random() * 0.15, 2.5 + Math.random() * 2)
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
      // Pulse: same white intensity throughout, just speeds up near end
      const period = 1500 - visProgress * 1300  // 1500ms at start → 200ms at end
      // Accumulate phase to avoid discontinuities
      shieldPulsePhase += frameDt * 1000 / period * Math.PI * 2
      const pulse = 0.5 + 0.5 * Math.sin(shieldPulsePhase)
      const flash = pulse
      ctx.beginPath()
      ctx.arc(sx, sy, drawRadius, -Math.PI / 2, -Math.PI / 2 - visProgress * Math.PI * 2, true)
      const r = 255
      const g = Math.round(50 + flash * 200)
      const b = Math.round(200 + flash * 55)

      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.6 + progress * 0.35 + flash * 0.1})`
      ctx.lineWidth = 3 + flash * 0.5 + progress * 1.5
      ctx.stroke()

      // Outer glow that grows with progress
      if (progress > 0.2) {
        ctx.beginPath()
        ctx.arc(sx, sy, drawRadius + 1, -Math.PI / 2, -Math.PI / 2 - visProgress * Math.PI * 2, true)
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${progress * 0.2})`
        ctx.lineWidth = 3 + progress * 3
        ctx.stroke()
      }

      // Leading tip glow + sparks
      const tipAngle = -Math.PI / 2 - visProgress * Math.PI * 2
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
    for (let i = 0; i < 28; i++) {
      const angle = (i / 28) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
      const px = player.x + Math.cos(angle) * drawRadius
      const py = player.y + Math.sin(angle) * drawRadius
      const speed = 950 + Math.random() * 700
      spawnParticle(px, py,
        Math.cos(angle) * speed + (Math.random() - 0.5) * 120,
        Math.sin(angle) * speed + (Math.random() - 0.5) * 120,
        255, 50 + Math.floor(Math.random() * 60), 200,
        0.26 + Math.random() * 0.17, 7.5 + Math.random() * 8.75)
    }
    // Hot white core sparks — fast, far
    for (let i = 0; i < 10; i++) {
      const angle = Math.random() * Math.PI * 2
      const px = player.x + Math.cos(angle) * drawRadius * 0.5
      const py = player.y + Math.sin(angle) * drawRadius * 0.5
      const speed = 1050 + Math.random() * 700
      spawnParticle(px, py,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        255, 220, 255, 0.24 + Math.random() * 0.14, 5 + Math.random() * 3.75)
    }
    // Slow drifting embers — linger after the burst
    for (let i = 0; i < 8; i++) {
      const angle = Math.random() * Math.PI * 2
      const dist = drawRadius * (0.5 + Math.random() * 0.5)
      const speed = 40 + Math.random() * 80
      spawnParticle(
        player.x + Math.cos(angle) * dist,
        player.y + Math.sin(angle) * dist,
        Math.cos(angle) * speed + (Math.random() - 0.5) * 20,
        Math.sin(angle) * speed - 20 - Math.random() * 30,
        255, 100, 220, 0.34 + Math.random() * 0.2, 3.75 + Math.random() * 3.75)
    }
  }

  // Shield break shockwave — expanding ring over the flash duration
  if (player.shieldBreakFlash > 0) {
    const bt = player.shieldBreakFlash / SHIELD_BREAK_FLASH  // 1→0
    const shockR = drawRadius + (1 - bt) * 240
    ctx.beginPath()
    ctx.arc(sx, sy, shockR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 80, 220, ${bt * bt * 0.6})`
    ctx.lineWidth = 5 * bt + 1
    ctx.stroke()
    // Second inner ring
    const innerR = drawRadius + (1 - bt) * 110
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
    shieldRestoreAnim = 0.59
    shieldActivateSweep = 0.36
    shieldFuseCompletionFlash = 0.55

    // Burst particles from the top (12 o'clock) where fuse completes
    const topX = player.x
    const topY = player.y - drawRadius
    for (let p = 0; p < 14; p++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8
      const speed = 100 + Math.random() * 150
      spawnParticle(topX, topY,
        Math.cos(a) * speed, Math.sin(a) * speed,
        255, 150 + Math.floor(Math.random() * 80), 230,
        0.2 + Math.random() * 0.15, 3.5 + Math.random() * 3)
    }
    // White-hot center sparks
    for (let p = 0; p < 6; p++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.5
      const speed = 140 + Math.random() * 100
      spawnParticle(topX, topY,
        Math.cos(a) * speed, Math.sin(a) * speed,
        255, 240, 255, 0.15 + Math.random() * 0.1, 2.5 + Math.random() * 2)
    }
  }
  prevShieldCharges = player.shieldCharges

  // Shield restore — spiral converge + impact shockwave
  if (shieldRestoreAnim > 0) {
    shieldRestoreAnim -= frameDt
    const totalDur = 0.59
    const convergeDur = 0.35  // spiral phase
    const shockDur = 0.24     // shockwave phase
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

  // Shield activation sweep — pink band top to bottom
  if (shieldActivateSweep > 0) {
    shieldActivateSweep -= frameDt
    const sweepT = 1 - (shieldActivateSweep / 0.36)  // 0→1
    const sweepY = sy - drawRadius + sweepT * drawRadius * 2  // top to bottom
    const bandH = drawRadius * 0.75  // band thickness

    ctx.save()
    // Clip to player body circle
    ctx.beginPath()
    ctx.arc(sx, sy, drawRadius + 1, 0, Math.PI * 2)
    ctx.clip()

    const fadeA = 1 - sweepT * 0.5

    // Top-to-bottom band
    const bandGrad = ctx.createLinearGradient(sx, sweepY - bandH, sx, sweepY + bandH)
    bandGrad.addColorStop(0, 'rgba(255, 50, 200, 0)')
    bandGrad.addColorStop(0.3, `rgba(255, 100, 220, ${0.75 * fadeA})`)
    bandGrad.addColorStop(0.5, `rgba(255, 220, 255, ${0.9 * fadeA})`)
    bandGrad.addColorStop(0.7, `rgba(255, 100, 220, ${0.75 * fadeA})`)
    bandGrad.addColorStop(1, 'rgba(255, 50, 200, 0)')
    ctx.fillStyle = bandGrad
    ctx.fillRect(sx - drawRadius, sweepY - bandH, drawRadius * 2, bandH * 2)

    // Bottom-to-top band
    const sweepY2 = sy + drawRadius - sweepT * drawRadius * 2
    const bandGrad2 = ctx.createLinearGradient(sx, sweepY2 - bandH, sx, sweepY2 + bandH)
    bandGrad2.addColorStop(0, 'rgba(255, 50, 200, 0)')
    bandGrad2.addColorStop(0.3, `rgba(255, 100, 220, ${0.75 * fadeA})`)
    bandGrad2.addColorStop(0.5, `rgba(255, 220, 255, ${0.9 * fadeA})`)
    bandGrad2.addColorStop(0.7, `rgba(255, 100, 220, ${0.75 * fadeA})`)
    bandGrad2.addColorStop(1, 'rgba(255, 50, 200, 0)')
    ctx.fillStyle = bandGrad2
    ctx.fillRect(sx - drawRadius, sweepY2 - bandH, drawRadius * 2, bandH * 2)

    // Sharp leading edge lines
    ctx.beginPath()
    ctx.moveTo(sx - drawRadius, sweepY)
    ctx.lineTo(sx + drawRadius, sweepY)
    ctx.moveTo(sx - drawRadius, sweepY2)
    ctx.lineTo(sx + drawRadius, sweepY2)
    ctx.strokeStyle = `rgba(255, 220, 255, ${0.9 * (1 - sweepT * 0.6)})`
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.restore()
  }

  // Fuse completion flash at 12 o'clock — draws on top of everything
  if (shieldFuseCompletionFlash > 0) {
    shieldFuseCompletionFlash -= frameDt
    const ft = Math.max(0, shieldFuseCompletionFlash / 0.55)  // 1→0 over 0.55s
    const topX = sx
    const topY = sy - drawRadius
    // Big expanding ring
    const ringR = 30 + (1 - ft) * 100
    ctx.beginPath()
    ctx.arc(topX, topY, Math.max(0, ringR), 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(200, 80, 255, ${ft * ft * 0.9})`
    ctx.lineWidth = Math.max(0.1, 7 * ft)
    ctx.stroke()
    // Bright glow dot
    ctx.beginPath()
    ctx.arc(topX, topY, Math.max(0, 40 * ft), 0, Math.PI * 2)
    ctx.fillStyle = `rgba(220, 140, 255, ${ft * 0.9})`
    ctx.fill()
    // Second smaller ring
    const ringR2 = 15 + (1 - ft) * 55
    ctx.beginPath()
    ctx.arc(topX, topY, Math.max(0, ringR2), 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(180, 100, 255, ${ft * ft * 0.6})`
    ctx.lineWidth = Math.max(0.1, 2 * ft)
    ctx.stroke()
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
      // Green burst — trails opposite of dash direction
      const dashAngle = Math.atan2(player.dashDirY, player.dashDirX)
      const backAngle = dashAngle + Math.PI
      for (let p = 0; p < 50; p++) {
        const a = backAngle + (Math.random() - 0.5) * 1.3
        const speed = 350 + Math.random() * 400
        spawnParticle(worldX, worldY,
          Math.cos(a) * speed + (Math.random() - 0.5) * 60,
          Math.sin(a) * speed + (Math.random() - 0.5) * 60,
          100, 255, 120, 0.3 + Math.random() * 0.2, 3.75 + Math.random() * 3.75)
      }
      // White-hot core sparks — also trail back
      for (let p = 0; p < 12; p++) {
        const a = backAngle + (Math.random() - 0.5) * 0.8
        const speed = 500 + Math.random() * 350
        spawnParticle(worldX, worldY,
          Math.cos(a) * speed, Math.sin(a) * speed,
          220, 255, 230, 0.2 + Math.random() * 0.15, 2.5 + Math.random() * 2.5)
      }
    }

    // Dash charge just became ready — converge burst + flash
    if (player.dashJustReady[i]) {
      player.dashJustReady[i] = false
      dashReadyFlash.push({ slotIndex: i, timer: 0.6, duration: 0.6 })
      playDashReady()
      const worldX = player.x + Math.cos(baseAngle) * orbitR
      const worldY = player.y + Math.sin(baseAngle) * orbitR
      // Converge particles — three waves at different speeds
      // Wave 1: fast outer (arrives first)
      for (let p = 0; p < 6; p++) {
        const a = (p / 6) * Math.PI * 2
        const dist = 70
        const px = worldX + Math.cos(a) * dist
        const py = worldY + Math.sin(a) * dist
        const toAngle = Math.atan2(worldY - py, worldX - px)
        spawnParticle(px, py,
          Math.cos(toAngle) * 140, Math.sin(toAngle) * 140,
          100, 255, 120, 0.25, 4)
      }
      // Wave 2: medium mid (arrives second)
      for (let p = 0; p < 6; p++) {
        const a = (p / 6) * Math.PI * 2 + Math.PI / 6  // offset 30°
        const dist = 55
        const px = worldX + Math.cos(a) * dist
        const py = worldY + Math.sin(a) * dist
        const toAngle = Math.atan2(worldY - py, worldX - px)
        spawnParticle(px, py,
          Math.cos(toAngle) * 90, Math.sin(toAngle) * 90,
          150, 255, 160, 0.3, 4.5)
      }
      // Wave 3: slow close (arrives last, brightest)
      for (let p = 0; p < 4; p++) {
        const a = (p / 4) * Math.PI * 2 + Math.PI / 4  // offset 45°
        const dist = 35
        const px = worldX + Math.cos(a) * dist
        const py = worldY + Math.sin(a) * dist
        const toAngle = Math.atan2(worldY - py, worldX - px)
        spawnParticle(px, py,
          Math.cos(toAngle) * 55, Math.sin(toAngle) * 55,
          200, 255, 220, 0.35, 5)
      }
      // Outward pop — evenly spaced
      for (let p = 0; p < 8; p++) {
        const a = (p / 8) * Math.PI * 2
        const speed = 75
        spawnParticle(worldX, worldY,
          Math.cos(a) * speed, Math.sin(a) * speed,
          200, 255, 210, 0.2, 3.5)
      }
    }

    if (timer <= 0) {
      // Bounce effect — check if this slot has an active ready flash (in shockwave phase)
      let bounce = 1.0
      for (const f of dashReadyFlash) {
        if (f.slotIndex === i) {
          const ft = 1 - (f.timer / f.duration)
          if (ft >= 0.5) {
            const shockT = (ft - 0.5) / 0.5  // 0→1
            bounce = 1 + (1 - shockT) * 0.8  // 1.8x → 1.0x
          }
        }
      }

      // Trail particles behind orbiting dot
      if (Math.random() < 0.7) {
        const worldDotX = player.x + Math.cos(baseAngle) * orbitR
        const worldDotY = player.y + Math.sin(baseAngle) * orbitR
        const spread = orbitR * 0.15
        spawnParticle(
          worldDotX + (Math.random() - 0.5) * spread,
          worldDotY + (Math.random() - 0.5) * spread,
          (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12,
          100, 255, 120, 0.22 + Math.random() * 0.18, 2.5 + Math.random() * 1.5)
      }
      // Ready — green dot with radial-gradient body, swimming inner sparks, beat-pulsing core
      const dotR = 11.87 * bounce
      // D: Radial gradient body — bright center, slightly darker edge (glowing bead look)
      const bodyGrad = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, dotR)
      if (bounce > 1.1) {
        bodyGrad.addColorStop(0, 'rgba(240, 255, 245, 0.98)')
        bodyGrad.addColorStop(1, 'rgba(180, 255, 200, 0.92)')
      } else {
        bodyGrad.addColorStop(0, 'rgba(180, 255, 200, 0.98)')
        bodyGrad.addColorStop(1, 'rgba(80, 235, 100, 0.92)')
      }
      ctx.beginPath()
      ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2)
      ctx.fillStyle = bodyGrad
      ctx.fill()
      // White-hot core pulse on top
      const coreR = dotR * (0.45 + globalBeatPulse * 1.65)
      const coreAlpha = 0.55 + globalBeatPulse * 0.45
      ctx.beginPath()
      ctx.arc(dotX, dotY, coreR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(170, 255, 190, ${coreAlpha})`
      ctx.fill()
      ctx.strokeStyle = 'rgba(100, 255, 120, 0.6)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else {
      // Charging — bright white pie on dark backing (NOT green — green = ready)
      const fill = 1 - (timer / (player.dashChargeTime * player.modifiers.dashChargeMult))
      const pieR = 11.87   // 10.32 * 1.15 — 15% bigger than the ready dot for visibility
      ctx.beginPath()
      ctx.arc(dotX, dotY, pieR, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
      ctx.fill()
      if (fill > 0) {
        ctx.beginPath()
        ctx.moveTo(dotX, dotY)
        ctx.arc(dotX, dotY, pieR, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2)
        ctx.closePath()
        // Flash red when player tried to dash with no charges (triggered from Player.ts)
        if (dashFailFlash > 0) {
          const fa = dashFailFlash / 0.25   // 1→0
          const fr = 255
          const fg = Math.round(255 - 255 * fa)
          const fb = Math.round(255 - 255 * fa)
          ctx.fillStyle = `rgba(${fr}, ${fg}, ${fb}, 1)`
        } else {
          ctx.fillStyle = 'rgba(255, 255, 255, 1)'
        }
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(dotX, dotY, pieR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, 0.5)`
      ctx.lineWidth = 1.2
      ctx.stroke()
    }
  }
  prevDashSlots = player.dashSlots.map(t => t)

  // Dash ready flash — spiral converge + shockwave, follows orbiting dot
  for (let i = dashReadyFlash.length - 1; i >= 0; i--) {
    const f = dashReadyFlash[i]!
    f.timer -= frameDt
    if (f.timer <= 0) { dashReadyFlash.splice(i, 1); continue }

    // Compute current dot position (follows player)
    const fAngle = orbitSpeed + (Math.PI * 2 * f.slotIndex) / player.dashSlots.length
    const fx = sx + Math.cos(fAngle) * orbitR
    const fy = sy + Math.sin(fAngle) * orbitR

    const t = 1 - (f.timer / f.duration)  // 0→1 (progress)
    const fadeT = f.timer / f.duration    // 1→0 (fade)

    if (t < 0.5) {
      // Phase 1: spiral converge
      const spiralT = t / 0.5  // 0→1
      const count = 4
      const outerR = 112 * (1 - spiralT * spiralT)  // shrinks inward
      const spiralRot = spiralT * Math.PI * 2  // 2 clean rotations

      // Contracting ring — clear "closing in" signal
      ctx.beginPath()
      ctx.arc(fx, fy, outerR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(100, 255, 120, ${0.4 + spiralT * 0.3})`
      ctx.lineWidth = 2 + spiralT * 1.5
      ctx.stroke()

      for (let s = 0; s < count; s++) {
        const a = (s / count) * Math.PI * 2 + spiralRot
        const px = fx + Math.cos(a) * outerR
        const py = fy + Math.sin(a) * outerR
        const dotSize = 5 + spiralT * 4  // bigger, grows as it converges
        // Dim green → white-hot as they converge
        const dr = Math.floor(100 + spiralT * 155)
        const dg = 255
        const db = Math.floor(120 + spiralT * 135)
        ctx.beginPath()
        ctx.arc(px, py, dotSize, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${dr}, ${dg}, ${db}, ${0.6 + spiralT * 0.35})`
        ctx.fill()
      }
    } else {
      // Phase 2: shockwave ring
      const shockT = (t - 0.5) / 0.5  // 0→1
      const ringR = 18 + shockT * 68
      ctx.beginPath()
      ctx.arc(fx, fy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(100, 255, 120, ${(1 - shockT) * 0.7})`
      ctx.lineWidth = 3 * (1 - shockT)
      ctx.stroke()

      // Bright center flash
      if (shockT < 0.4) {
        ctx.beginPath()
        ctx.arc(fx, fy, 26 * (1 - shockT), 0, Math.PI * 2)
        ctx.fillStyle = `rgba(200, 255, 220, ${(1 - shockT * 2.5) * 0.6})`
        ctx.fill()
      }
    }
  }

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

function drawShrine(enemy: Enemy, player: Player): void {
  const sx = enemy.x - camX
  const sy = enemy.y - camY
  const r = enemy.radius
  const hpFrac = enemy.hp / enemy.maxHp

  // Color from enemy designer
  const hr = parseInt(enemy.color.slice(1, 3), 16)
  const hg = parseInt(enemy.color.slice(3, 5), 16)
  const hb = parseInt(enemy.color.slice(5, 7), 16)

  // Check if player is fully inside
  const dx = enemy.x - player.x
  const dy = enemy.y - player.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  const playerR = PLAYER_RADIUS * player.modifiers.sizeMult
  const playerInside = dist + playerR <= r

  const bp = globalBeatPulse
  const alive = enemy.hp > 0

  // Ground fill — subtle zone indicator
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${alive ? 0.05 + bp * 0.02 : 0.02})`
  ctx.fill()

  // Segmented outer ring ��� each HP is a distinct arc with gaps
  // Segmented outer ring — inset so outer edge aligns with collision boundary
  const strokeW = 7.5
  const drawR = r - strokeW / 2

  if (alive && enemy.maxHp <= 30) {
    const segments = enemy.maxHp
    const gapAngle = segments > 1 ? 0.08 : 0
    const segAngle = (Math.PI * 2 - gapAngle * segments) / segments
    const startAngle = -Math.PI / 2

    for (let i = 0; i < segments; i++) {
      const segStart = startAngle + i * (segAngle + gapAngle)
      const segEnd = segStart + segAngle
      const isDead = i >= enemy.hp

      ctx.beginPath()
      ctx.arc(sx, sy, drawR, segStart, segEnd)

      if (isDead) {
        // Glow behind dotted line
        ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.1)`
        ctx.lineWidth = strokeW + 4
        ctx.stroke()
        // Fast animated dotted line
        ctx.save()
        ctx.setLineDash([4, 4])
        ctx.lineDashOffset = -gameTimeMs / 20
        const redMix = 0.5
        const deadR = Math.min(255, Math.floor(hr + (255 - hr) * redMix))
        const deadG = Math.floor(hg * (1 - redMix * 0.7))
        const deadB = Math.floor(hb * (1 - redMix * 0.7))
        ctx.strokeStyle = `rgba(${deadR}, ${deadG}, ${deadB}, 0.5)`
        ctx.lineWidth = strokeW
        ctx.stroke()
        ctx.restore()
        continue
      } else if (playerInside) {
        ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.8 + bp * 0.2})`
        ctx.lineWidth = strokeW + 1
      } else {
        ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.5 + bp * 0.15})`
        ctx.lineWidth = strokeW
      }
      ctx.stroke()
    }
  } else if (alive) {
    ctx.save()
    ctx.setLineDash([8, 6])
    ctx.lineDashOffset = -gameTimeMs / 40
    ctx.beginPath()
    ctx.arc(sx, sy, drawR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${playerInside ? 0.7 + bp * 0.2 : 0.3 + bp * 0.1})`
    ctx.lineWidth = playerInside ? strokeW + 1 : strokeW
    ctx.stroke()
    ctx.restore()
  }

  // Idle — inviting pulse when player is NOT inside
  if (alive && !playerInside) {
    const spin = gameTimeMs / 1500  // faster base spin

    // Rotating arc segments — 3 arcs at different radii, ripple outward on beat
    for (let ring = 0; ring < 3; ring++) {
      const rippleDelay = ring * 0.12
      const rippleBp = Math.max(0, bp - rippleDelay) / (1 - rippleDelay)
      const ringR = r * (0.1 + ring * 0.15 + rippleBp * 0.45)

      // 2 arc segments per ring, rotating in alternating directions
      const arcLen = Math.PI * 0.5
      const rot = spin * (ring % 2 === 0 ? 1.5 : -1.2) + ring * 1.2
      for (let a = 0; a < 2; a++) {
        const arcStart = rot + a * Math.PI + rippleBp * 1.2
        const arcEnd = arcStart + arcLen + rippleBp * 0.3  // arcs stretch on beat
        // Glow
        ctx.beginPath()
        ctx.arc(sx, sy, ringR, arcStart, arcEnd)
        ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.04 + rippleBp * 0.12})`
        ctx.lineWidth = 5 - ring * 0.8
        ctx.stroke()
        // Core
        ctx.beginPath()
        ctx.arc(sx, sy, ringR, arcStart, arcEnd)
        ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.1 + rippleBp * 0.25})`
        ctx.lineWidth = 1.8 - ring * 0.3
        ctx.stroke()
      }
    }

    // Inward pulse ring — ripple from edge to center
    const pulseT = (gameTimeMs % 1500) / 1500
    const pulseR = drawR * (1 - pulseT * 0.7)
    const pulseAlpha = (1 - pulseT) * (1 - pulseT) * 0.15
    ctx.beginPath()
    ctx.arc(sx, sy, pulseR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${pulseAlpha})`
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // Player-inside targeting reticle — spinning, pulsing lock-on
  if (alive && playerInside) {
    const spinSpeed = gameTimeMs / 2000  // slow rotation
    const reticleCount = 6
    const innerR = r * 0.2
    const outerR = r * 0.9

    // Sharp beat flash — spikes to 1 then drops fast
    const beatHit = bp > 0.3 ? Math.pow(bp, 0.3) : bp * 2  // sharp spike

    // Glow fill when inside — flashes on beat
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.06 + beatHit * 0.12})`
    ctx.fill()

    // Spinning radial lines with glow — flash on beat
    for (let i = 0; i < reticleCount; i++) {
      const a = (i / reticleCount) * Math.PI * 2 + spinSpeed
      const lineOuter = outerR - beatHit * r * 0.15
      const lineInner = innerR + beatHit * r * 0.1
      // Glow behind line
      ctx.beginPath()
      ctx.moveTo(sx + Math.cos(a) * lineInner, sy + Math.sin(a) * lineInner)
      ctx.lineTo(sx + Math.cos(a) * lineOuter, sy + Math.sin(a) * lineOuter)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.05 + beatHit * 0.2})`
      ctx.lineWidth = 6
      ctx.stroke()
      // Core line
      ctx.beginPath()
      ctx.moveTo(sx + Math.cos(a) * lineInner, sy + Math.sin(a) * lineInner)
      ctx.lineTo(sx + Math.cos(a) * lineOuter, sy + Math.sin(a) * lineOuter)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.2 + beatHit * 0.5})`
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Inner ring — contracts sharply on beat, glowing
    const innerRingR = r * (0.38 - beatHit * 0.12)
    ctx.beginPath()
    ctx.arc(sx, sy, innerRingR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.1 + beatHit * 0.3})`
    ctx.lineWidth = 4
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(sx, sy, innerRingR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.2 + beatHit * 0.5})`
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Mid radius dashed ring — slow spin
    ctx.save()
    ctx.setLineDash([4, 8])
    ctx.beginPath()
    ctx.arc(sx, sy, r * 0.6, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.1 + beatHit * 0.2})`
    ctx.lineWidth = 1.5
    ctx.lineDashOffset = -gameTimeMs / 100
    ctx.stroke()
    ctx.restore()

    // Red "HIT NOW" flash — targeting reticle goes red at ring peak
    const peakTarget = ATTACK_EXPAND_TIME - 0.05  // 50ms earlier
    const nearPeak = player.attackTimer >= 0 && Math.abs(player.attackTimer - peakTarget) < 0.15
    if (nearPeak) {
      const peakDist = Math.abs(player.attackTimer - peakTarget) / 0.15
      const redAlpha = (1 - peakDist)
      // Inner ring goes bright red with glow
      ctx.beginPath()
      ctx.arc(sx, sy, innerRingR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 40, 40, ${redAlpha * 0.3})`
      ctx.lineWidth = 12
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(sx, sy, innerRingR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 60, 50, ${redAlpha * 0.9})`
      ctx.lineWidth = 3
      ctx.stroke()
      // Radial lines flash bright red with glow
      for (let i = 0; i < reticleCount; i++) {
        const a = (i / reticleCount) * Math.PI * 2 + spinSpeed
        ctx.beginPath()
        ctx.moveTo(sx + Math.cos(a) * innerR, sy + Math.sin(a) * innerR)
        ctx.lineTo(sx + Math.cos(a) * outerR, sy + Math.sin(a) * outerR)
        ctx.strokeStyle = `rgba(255, 40, 40, ${redAlpha * 0.25})`
        ctx.lineWidth = 8
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(sx + Math.cos(a) * innerR, sy + Math.sin(a) * innerR)
        ctx.lineTo(sx + Math.cos(a) * outerR, sy + Math.sin(a) * outerR)
        ctx.strokeStyle = `rgba(255, 60, 50, ${redAlpha * 0.7})`
        ctx.lineWidth = 2.5
        ctx.stroke()
      }
    }
  }

  // Hit impact animation — multi-layered
  if (enemy.hitFlash > 0) {
    const ft = enemy.hitFlash / 0.75  // 1→0
    // Color transition: red early (ft > 0.5) → white late (ft < 0.5)
    const redPhase = Math.max(0, (ft - 0.4) / 0.6)  // 1 at start, 0 at 40%
    const whitePhase = Math.max(0, (0.5 - ft) / 0.5)  // 0 until halfway, 1 at end
    const fr = 255
    const fg = Math.floor(50 + whitePhase * 205)  // 50→255
    const fb = Math.floor(40 + whitePhase * 215)  // 40→255

    // 1. Ground flash — red→white
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${fr}, ${fg}, ${fb}, ${ft * 0.4})`
    ctx.fill()

    // Center explosion pop — bright core expanding outward
    const popT = 1 - ft  // 0→1
    const popR = r * 0.15 + popT * r * 0.4
    const popAlpha = ft * ft
    // Warm glow
    ctx.beginPath()
    ctx.arc(sx, sy, popR + 10, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${fr}, ${Math.floor(fg * 0.6)}, ${Math.floor(fb * 0.5)}, ${popAlpha * 0.35})`
    ctx.fill()
    // White-red core
    ctx.beginPath()
    ctx.arc(sx, sy, popR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${fr}, ${fg}, ${fb}, ${popAlpha * 0.5})`
    ctx.fill()
    // Hot center dot
    if (ft > 0.5) {
      const dotAlpha = (ft - 0.5) * 2
      ctx.beginPath()
      ctx.arc(sx, sy, r * 0.1, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${dotAlpha * 0.9})`
      ctx.fill()
    }

    // 2. Expanding shockwave — thick, bright
    const shockT = 1 - ft  // 0→1
    const shockR = shockT * drawR
    // Wide glow ring
    ctx.beginPath()
    ctx.arc(sx, sy, Math.max(1, shockR), 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${ft * 0.5})`
    ctx.lineWidth = 10 * ft
    ctx.stroke()
    // White-red core ring
    ctx.beginPath()
    ctx.arc(sx, sy, Math.max(1, shockR), 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${fr}, ${fg}, ${fb}, ${ft * 0.8})`
    ctx.lineWidth = 3 * ft + 1
    ctx.stroke()

    // 3. Alive segments flash white — full opacity
    if (alive && enemy.maxHp <= 30) {
      const segments = enemy.maxHp
      const gapAngle = segments > 1 ? 0.08 : 0
      const segAngle = (Math.PI * 2 - gapAngle * segments) / segments
      const startAngle = -Math.PI / 2
      for (let i = 0; i < enemy.hp; i++) {
        const segStart = startAngle + i * (segAngle + gapAngle)
        const segEnd = segStart + segAngle
        ctx.beginPath()
        ctx.arc(sx, sy, drawR, segStart, segEnd)
        ctx.strokeStyle = `rgba(${fr}, ${fg}, ${fb}, ${ft * 0.9})`
        ctx.lineWidth = strokeW + 3
        ctx.stroke()
      }
    }

    // 4. Reticle collapse + white flash
    if (playerInside) {
      const collapse = ft > 0.6 ? (1 - ft) * 5 : 1
      const reticleCount = 6
      const spinSpeed = gameTimeMs / 2000
      for (let i = 0; i < reticleCount; i++) {
        const a = (i / reticleCount) * Math.PI * 2 + spinSpeed
        const lineInner = r * 0.1 * collapse
        const lineOuter = r * 0.9 * collapse
        // Glow
        ctx.beginPath()
        ctx.moveTo(sx + Math.cos(a) * lineInner, sy + Math.sin(a) * lineInner)
        ctx.lineTo(sx + Math.cos(a) * lineOuter, sy + Math.sin(a) * lineOuter)
        ctx.strokeStyle = `rgba(255, 255, 255, ${ft * 0.3})`
        ctx.lineWidth = 7
        ctx.stroke()
        // Core
        ctx.beginPath()
        ctx.moveTo(sx + Math.cos(a) * lineInner, sy + Math.sin(a) * lineInner)
        ctx.lineTo(sx + Math.cos(a) * lineOuter, sy + Math.sin(a) * lineOuter)
        ctx.strokeStyle = `rgba(255, 255, 255, ${ft * 0.7})`
        ctx.lineWidth = 2.5
        ctx.stroke()
      }
      // Inner ring flash
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(1, r * 0.3 * collapse), 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${ft * 0.8})`
      ctx.lineWidth = 4
      ctx.stroke()
    }
  }

  // Summoning animation — energy converging to center before spawns release
  if (enemy.shrineSummonTimer > 0) {
    const sumDur = BEAT_SEC * 0.5
    const st = 1 - (enemy.shrineSummonTimer / sumDur)  // 0→1

    // Two rings of converging dots — outer fast, inner slower
    for (let ring = 0; ring < 2; ring++) {
      const dotCount = ring === 0 ? 10 : 6
      const spiralRot = st * Math.PI * (ring === 0 ? 2.5 : -1.5)
      const ringDelay = ring * 0.15
      const ringT = Math.max(0, st - ringDelay) / (1 - ringDelay)
      const outerR = drawR * (1 - ringT * ringT)
      for (let d = 0; d < dotCount; d++) {
        const a = (d / dotCount) * Math.PI * 2 + spiralRot
        const dx2 = sx + Math.cos(a) * outerR
        const dy2 = sy + Math.sin(a) * outerR
        const dotSize = 3 + ringT * 5
        const cMix = ringT * ringT
        const dr = Math.floor(hr + (255 - hr) * cMix)
        const dg = Math.floor(hg + (255 - hg) * cMix)
        const db = Math.floor(hb + (255 - hb) * cMix)
        // Glow behind dot
        ctx.beginPath()
        ctx.arc(dx2, dy2, dotSize + 5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${dr}, ${dg}, ${db}, ${ringT * 0.15})`
        ctx.fill()
        // Bright dot
        ctx.beginPath()
        ctx.arc(dx2, dy2, dotSize, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${dr}, ${dg}, ${db}, ${0.5 + ringT * 0.45})`
        ctx.fill()
      }
    }

    // Two contracting rings — staggered
    for (let cr = 0; cr < 2; cr++) {
      const crT = Math.max(0, st - cr * 0.1) / (1 - cr * 0.1)
      const contractR = drawR * (1 - crT)
      ctx.beginPath()
      ctx.arc(sx, sy, Math.max(1, contractR), 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${(0.2 + crT * 0.4) * (1 - cr * 0.3)})`
      ctx.lineWidth = 2 + crT * 3
      ctx.stroke()
    }

    // Center buildup glow — intensifies
    const glowR = r * 0.15 + st * r * 0.25
    ctx.beginPath()
    ctx.arc(sx, sy, glowR + 10, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${st * st * 0.2})`
    ctx.fill()
    ctx.beginPath()
    ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 255, 255, ${st * st * 0.3})`
    ctx.fill()

    // Final flash right before spawns
    if (st > 0.85) {
      const finalT = (st - 0.85) / 0.15
      ctx.beginPath()
      ctx.arc(sx, sy, r * 0.4, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${finalT * 0.5})`
      ctx.fill()
    }

    // Spawn trail particles converging to center
    if (Math.random() < 0.5 + st * 0.5) {
      const a = Math.random() * Math.PI * 2
      const dist = drawR * (1 - st) * (0.5 + Math.random() * 0.5)
      const toCenter = Math.atan2(sy - (sy + Math.sin(a) * dist), sx - (sx + Math.cos(a) * dist))
      const speed = 60 + st * 100
      spawnParticle(
        enemy.x + Math.cos(a) * dist,
        enemy.y + Math.sin(a) * dist,
        Math.cos(toCenter) * speed, Math.sin(toCenter) * speed,
        Math.min(255, hr + Math.floor(st * 80)),
        Math.min(255, hg + Math.floor(st * 80)),
        Math.min(255, hb + Math.floor(st * 80)),
        0.15 + st * 0.15, 2.5 + st * 2)
    }
  }
}

function drawEnemy(enemy: Enemy, player: Player): void {
  let sx = enemy.x - camX
  let sy = enemy.y - camY
  // Pusher visual pulse — matches the wall-spring pillar pulse math (instant peak at fire,
  // (1-t)² decay, 10% max amplitude). Affects RENDERED radius only — actual collision and
  // push trigger geometry still use enemy.radius (see GameManager.processPusherEnemies).
  let pusherVisScale = 1
  if (enemy.pusher && enemy.pusherLastFireBeat != null && !enemy.dying) {
    const cycle = enemy.pusherBeats
    const pulseDur = Math.min(0.20, cycle * 0.30)   // matches grace window — keeps visual alive for the full active push time
    const pulseAmpl = Math.min(0.13, cycle * 0.13)
    const beatsSinceFire = getAbsoluteBeats() - enemy.pusherLastFireBeat
    if (beatsSinceFire >= 0 && beatsSinceFire < pulseDur) {
      const t = beatsSinceFire / pulseDur
      const ease = (1 - t) * (1 - t)
      pusherVisScale = 1 + ease * pulseAmpl
    }
  }
  let r = enemy.radius * pusherVisScale

  // Hit jitter — random position offset while flash is active
  if (enemy.hitFlash > 0) {
    const jitterStrength = 6 * (enemy.hitFlash / HIT_FLASH_DURATION)
    sx += (Math.random() - 0.5) * 2 * jitterStrength
    sy += (Math.random() - 0.5) * 2 * jitterStrength
  }

  // Spawn lightning bolts on the first frame of beat-dash hit (one-shot, dt-race-immune).
  // Done BEFORE the dying-branch return so killing-blow hits still spawn lightning.
  if (enemy.beatDashJustHit) {
    enemy.beatDashJustHit = false
    const baseAngle = Math.random() * Math.PI * 2
    const COUNT = 8
    const boltScale = Math.min(2.5, Math.max(1, r / 22))
    for (let i = 0; i < COUNT; i++) {
      const angle = baseAngle + (i / COUNT) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
      spawnLightningBolt(enemy, angle, r * (1.45 + Math.random() * 0.55), boltScale)
    }
  }

  // Death animation
  if (enemy.dying) {
    const dt = enemy.deathTimer
    const sizeScale = 1 + Math.max(0, (r - 60) / 60) * 0.5  // floor at 1x, gentle scale above radius 60
    const deathDur = 0.21
    const t = Math.min(dt / deathDur, 1)

    const hr = enemy.cr, hg = enemy.cg, hb = enemy.cb

    // Death ripples + red hit particles on first frame
    if (dt < 0.02) {
      spawnDeathRipples(enemy.x, enemy.y, r, enemy.color)
    }
    if (dt < 0.02) {
      const redCount = Math.max(4, Math.floor(10 * sizeScale))
      for (let i = 0; i < redCount; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = r * Math.random() * 0.5
        const px = enemy.x + Math.cos(angle) * dist
        const py = enemy.y + Math.sin(angle) * dist
        const speed = (300 + Math.random() * 350) * sizeScale
        const pSize = (5 + Math.random() * 4) * sizeScale
        spawnParticle(px, py, Math.cos(angle) * speed, Math.sin(angle) * speed,
          255, 60 + Math.floor(Math.random() * 45), 55, 0.21 + Math.random() * 0.14, pSize)
      }
    }

    if (dt < deathDur) {
      const burstBase = t < 0.1 ? 15 : 4
      const count = Math.max(2, Math.floor(burstBase * sizeScale))
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = Math.random() * r
        const px = enemy.x + Math.cos(angle) * dist
        const py = enemy.y + Math.sin(angle) * dist
        const speed = (400 + Math.random() * 500) * sizeScale
        const vx = Math.cos(angle) * speed + (Math.random() - 0.5) * 80
        const vy = Math.sin(angle) * speed + (Math.random() - 0.5) * 80 - 20
        const isWhite = Math.random() < 0.3
        const pSize = (3 + Math.random() * 3) * sizeScale
        spawnParticle(px, py, vx, vy,
          isWhite ? 255 : hr, isWhite ? 255 : hg, isWhite ? 255 : hb,
          0.21 + Math.random() * 0.21, pSize)
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
  const startAngle = -Math.PI / 2
  const endAngle = startAngle + hpFraction * Math.PI * 2

  // Red glow halo on hit — radial gradient extends past enemy edge (matches player hit glow).
  // Drawn under pie/body so the enemy color still reads; only a red halo spills past the edge.
  if (enemy.hitFlash > 0) {
    const flashT = enemy.hitFlash / HIT_FLASH_DURATION
    const glowR = r * 1.3
    const a = flashT * 0.85
    const grad = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, glowR)
    grad.addColorStop(0, `rgba(255, 60, 50, ${a})`)
    grad.addColorStop(0.45, `rgba(255, 50, 40, ${a * 0.6})`)
    grad.addColorStop(1, 'rgba(255, 40, 30, 0)')
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.globalCompositeOperation = prevComp
  }
  // Yellow glow halo when hit by the beat-dash AOE — stacks additively with the red glow
  // so a sweep + beat-dash on the same frame reads as "extra hard hit". Same gradient shape.
  if (enemy.beatDashFlash > 0) {
    const flashT = enemy.beatDashFlash / HIT_FLASH_DURATION
    const glowR = r * 1.3
    const a = flashT * 0.9
    const grad = ctx.createRadialGradient(sx, sy, r * 0.2, sx, sy, glowR)
    grad.addColorStop(0, `rgba(255, 230, 90, ${a})`)
    grad.addColorStop(0.45, `rgba(255, 200, 50, ${a * 0.65})`)
    grad.addColorStop(1, 'rgba(255, 180, 30, 0)')
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.arc(sx, sy, glowR, 0, Math.PI * 2)
    ctx.fillStyle = grad
    ctx.fill()
    ctx.globalCompositeOperation = prevComp
  }

  // Background — solid fill
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  if (isTotem) {
    ctx.fillStyle = 'rgba(15, 15, 20, 0.75)'  // neutral dark, heavier
    ctx.fill()

    // Totem inner texture — rotating rune segments
    ctx.save()
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.clip()

    const gt = gameTimeMs / 1000  // seconds
    const gbp = globalBeatPulse

    // 4 layers of arc segments at different radii, rotating in alternating directions
    const layers = [
      { radius: 0.85, segments: 8, width: 1.5, speed: 0.4, gap: 0.25 },
      { radius: 0.62, segments: 6, width: 2.0, speed: -0.7, gap: 0.3 },
      { radius: 0.40, segments: 5, width: 1.8, speed: 1.1, gap: 0.35 },
      { radius: 0.22, segments: 3, width: 2.5, speed: -1.6, gap: 0.2 },
    ]

    // Beat alignment — on beat, segments briefly snap toward aligned positions
    const beatSnap = gbp * gbp * 0.4  // sharp snap, fast decay

    for (const layer of layers) {
      const lr = layer.radius * r
      const baseAngle = gt * layer.speed
      // On beat, lerp toward nearest aligned angle
      const alignedAngle = Math.round(baseAngle / (Math.PI / 4)) * (Math.PI / 4)
      const angle = baseAngle + (alignedAngle - baseAngle) * beatSnap
      const segArc = (Math.PI * 2 / layer.segments) * (1 - layer.gap)
      const alpha = 0.04 + gbp * 0.3

      for (let s = 0; s < layer.segments; s++) {
        const segStart = angle + (s / layer.segments) * Math.PI * 2
        ctx.beginPath()
        ctx.arc(sx, sy, lr + gbp * r * 0.08, segStart, segStart + segArc)
        ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${alpha})`
        ctx.lineWidth = layer.width + gbp * 1.2
        ctx.stroke()
      }
    }

    // Center flash — pulses dramatically with beat
    const dotR = r * (0.1 + gbp * 0.15)
    // Outer glow bloom on beat
    if (gbp > 0.1) {
      ctx.beginPath()
      ctx.arc(sx, sy, dotR + r * gbp * 0.2, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${gbp * 0.15})`
      ctx.fill()
    }
    // Core dot
    ctx.beginPath()
    ctx.arc(sx, sy, dotR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.1 + gbp * 0.55})`
    ctx.fill()
    // White-hot center on beat
    if (gbp > 0.3) {
      ctx.beginPath()
      ctx.arc(sx, sy, dotR * 0.5, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 255, 255, ${(gbp - 0.3) * 0.7})`
      ctx.fill()
    }

    // Radial lines — 8 spokes, very subtle, rotate slowly
    const spokeAngle = gt * 0.2
    for (let s = 0; s < 8; s++) {
      const a = spokeAngle + (s / 8) * Math.PI * 2
      const innerR = r * 0.1
      const outerR = r * (0.9 + gbp * 0.08)
      ctx.beginPath()
      ctx.moveTo(sx + Math.cos(a) * innerR, sy + Math.sin(a) * innerR)
      ctx.lineTo(sx + Math.cos(a) * outerR, sy + Math.sin(a) * outerR)
      ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${0.02 + gbp * 0.06})`
      ctx.lineWidth = 1
      ctx.stroke()
    }

    ctx.restore()
  } else {
    ctx.fillStyle = `rgba(${Math.floor(hr * 0.08)}, ${Math.floor(hg * 0.08)}, ${Math.floor(hb * 0.08)}, 0.55)`
  }
  ctx.fill()

  // Hit particles — burst from the pie edge, intensity scales with damage fraction + enemy size.
  // Skip when a shield break is happening this frame — the shield shockwave is the hit feedback.
  if (enemy.hitFlash > HIT_FLASH_DURATION - 0.02 && enemy.shieldBreakFlash <= 0) {
    const hitFraction = damageFraction  // fraction of maxHp dealt
    const dmgIntensity = Math.min(Math.max(hitFraction / 0.20, 1), 4)  // 1x at <=20%, up to 4x at 80%+
    const sizeBonus = Math.min(r / 44, 3)  // bigger enemies = more blood (up to 3x)
    const intensity = Math.max(dmgIntensity, sizeBonus)
    const count = Math.floor(12 * intensity)
    // Only the fresh bite — from actual HP to where displayHp is (the red drain wedge)
    const damageArcStart = startAngle + (enemy.hp / enemy.maxHp) * Math.PI * 2
    const damageArcEnd = damageArcStart + damageFraction * Math.PI * 2
    const arcSpan = damageArcEnd - damageArcStart
    // Spawn blood offset in movement direction so it stays with moving enemies
    const bloodOffX = enemy.vx * 0.08  // ~5 frames ahead
    const bloodOffY = enemy.vy * 0.08
    const bloodCx = enemy.x + bloodOffX
    const bloodCy = enemy.y + bloodOffY
    for (let i = 0; i < count; i++) {
      const angle = damageArcStart + Math.random() * arcSpan
      const dist = Math.random() * r
      const px = bloodCx + Math.cos(angle) * dist
      const py = bloodCy + Math.sin(angle) * dist
      const speed = (274 + Math.random() * 430) * (0.8 + intensity * 0.2)
      const outAngle = Math.atan2(py - bloodCy, px - bloodCx)
      const vx = Math.cos(outAngle) * speed + (Math.random() - 0.5) * speed * 0.2 + enemy.vx
      const vy = Math.sin(outAngle) * speed + (Math.random() - 0.5) * speed * 0.2 + enemy.vy
      const sizeScale = Math.min(r / 44, 1)
      const size = (3.2 + Math.random() * 3.2) * (0.8 + intensity * 0.2) * sizeScale * sizeScale
      spawnParticle(px, py, vx, vy, 255, 60 + Math.floor(Math.random() * 45), 55, 0.31 + Math.random() * 0.22, size)
    }
    // Blood spray from center — enemy colored
    const sprayCount = Math.floor(1.5 * intensity)
    for (let i = 0; i < sprayCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 118 + Math.random() * 254 * intensity
      const sizeScale2 = Math.min(r / 44, 1)
      const size = (2.8 + Math.random() * 3.2) * (0.8 + intensity * 0.2) * sizeScale2 * sizeScale2
      spawnParticle(enemy.x + bloodOffX, enemy.y + bloodOffY,
        Math.cos(angle) * speed + enemy.vx, Math.sin(angle) * speed + enemy.vy,
        235 + Math.floor(Math.random() * 20), 30 + Math.floor(Math.random() * 35), 30, 0.31 + Math.random() * 0.22, size)
    }
  }

  const actualHpFraction = enemy.hp / enemy.maxHp

  if (enemy.summon) {
    // Phase pie — shows remaining phases like HP, bites on each spawn
    const totalPhases = enemy.summonPhases.length
    if (totalPhases > 0) {
      // Smooth display phase — drains toward actual
      if (enemy.summonDisplayPhase < enemy.summonCurrentPhase) {
        enemy.summonDisplayPhase += (enemy.summonCurrentPhase - enemy.summonDisplayPhase) * HP_DRAIN_SPEED * 1.0 * frameDt
        if (enemy.summonCurrentPhase - enemy.summonDisplayPhase < 0.01) enemy.summonDisplayPhase = enemy.summonCurrentPhase
      }
      const phasesRemaining = totalPhases - enemy.summonDisplayPhase
      const actualRemaining = totalPhases - enemy.summonCurrentPhase
      const phaseFrac = phasesRemaining / totalPhases
      const actualFrac = actualRemaining / totalPhases
      const damageFrac = phaseFrac - actualFrac  // the red drain wedge

      // Dark background
      const sbgGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
      sbgGrad.addColorStop(0, `rgba(${Math.floor(hr * 0.08)}, ${Math.floor(hg * 0.08)}, ${Math.floor(hb * 0.08)}, 0.55)`)
      sbgGrad.addColorStop(1, 'rgba(0, 0, 0, 0.4)')
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = sbgGrad
      ctx.fill()

      // Red drain wedge — between actual and display
      if (damageFrac > 0.001) {
        const drainStart = startAngle + actualFrac * Math.PI * 2
        const drainEnd = startAngle + phaseFrac * Math.PI * 2
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.arc(sx, sy, r, drainStart, drainEnd)
        ctx.closePath()
        ctx.fillStyle = `rgba(255, 60, 60, 0.5)`
        ctx.fill()
      }

      // Filled phase wedge — actual remaining
      if (actualFrac > 0) {
        const phaseEnd = startAngle + actualFrac * Math.PI * 2
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

    // Helper: draw a two-tone filled segment with grid texture
    const gbp = globalBeatPulse

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
      // Beat flash on inner area
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, midR, sStart, sEnd)
      ctx.closePath()
      ctx.fillStyle = `rgba(${Math.min(255, hr + 120)}, ${Math.min(255, hg + 100)}, ${Math.min(255, hb + 100)}, ${gbp * 0.5})`
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

  // Red tint over the enemy body — layered on top with `lighter` so it punches red
  // through whatever the enemy color is. Pairs with the red halo glow drawn under.
  if (enemy.hitFlash > 0) {
    const flashT = enemy.hitFlash / HIT_FLASH_DURATION
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 50, 40, ${0.55 * flashT})`
    ctx.fill()
    ctx.globalCompositeOperation = prevComp
  }
  // Yellow body tint when hit by beat-dash AOE — stacks with the red tint above.
  if (enemy.beatDashFlash > 0) {
    const flashT = enemy.beatDashFlash / HIT_FLASH_DURATION
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 210, 60, ${0.55 * flashT})`
    ctx.fill()
    ctx.globalCompositeOperation = prevComp
  }

  // Chill overlay — blue tint inside the enemy body. Three sources can contribute:
  //   1. Frostbite stacks (existing) — intensity scales with chillStacks/5
  //   2. Chill Zone presence (zoneSlowFrac > 0) — flat moderate tint
  //   3. Chill Zone immobility (immobileTimer > 0) — full tint + hex snowflake overlay
  // We pick the strongest visual treatment of the three so they don't double-up alpha.
  const stackIntensity = enemy.chillStacks / 5
  const zoneTint = enemy.zoneSlowFrac > 0 ? 0.7 : 0
  const isImmobile = enemy.immobileTimer > 0
  const chillIntensity = Math.max(stackIntensity, zoneTint, isImmobile ? 1 : 0)
  if (chillIntensity > 0) {
    // Heavier saturated tint — was 0.06 + 0.18 (cap 0.24); now 0.14 + 0.42 (cap 0.56).
    // Plus a brighter overlay layer for the strong frozen state so it really pops.
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(80, 200, 255, ${0.14 + chillIntensity * 0.42})`
    ctx.fill()
    if (chillIntensity >= 0.6) {
      // Inner deeper-blue glow at high chill so the body reads as "frozen through"
      ctx.beginPath()
      ctx.arc(sx, sy, r * 0.9, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(40, 150, 230, ${(chillIntensity - 0.6) * 0.45})`
      ctx.fill()
    }
    // Ice crystal spikes around the perimeter — readable indicator of chilled state.
    // Count and size scale with intensity. Slow rotation so they look "alive."
    if (chillIntensity >= 0.4) {
      const spikeCount = isImmobile ? 8 : 6
      const spikeBase = isImmobile ? 7 : 4
      const slowRot = performance.now() / (isImmobile ? 1200 : 2400)
      ctx.fillStyle = `rgba(220, 245, 255, ${0.7 + chillIntensity * 0.25})`
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.85})`
      ctx.lineWidth = 1
      for (let i = 0; i < spikeCount; i++) {
        const a = slowRot + (i / spikeCount) * Math.PI * 2
        const baseX = sx + Math.cos(a) * r
        const baseY = sy + Math.sin(a) * r
        const tipX = sx + Math.cos(a) * (r + spikeBase)
        const tipY = sy + Math.sin(a) * (r + spikeBase)
        const wingX = Math.cos(a + Math.PI / 2) * (spikeBase * 0.5)
        const wingY = Math.sin(a + Math.PI / 2) * (spikeBase * 0.5)
        ctx.beginPath()
        ctx.moveTo(tipX, tipY)
        ctx.lineTo(baseX + wingX, baseY + wingY)
        ctx.lineTo(baseX - wingX, baseY - wingY)
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }
    // Hex snowflake — only for immobilized enemies. Six-armed crystalline overlay covering
    // the enemy: a main arm out to ~1.5r, two small "V" branches at the midpoint and outer
    // third of each arm, plus a small central hexagon hub. Slow rotation.
    if (isImmobile) {
      const flakeRot = performance.now() / 1800
      // Grow-in: ease-out-back scale over the first ~0.18s so the snowflake "snaps" into
      // place with a satisfying overshoot, not an instant pop-in. Stays at scale 1 afterward.
      const elapsed = BEAT_SEC - enemy.immobileTimer
      const growT = Math.min(elapsed / 0.18, 1.0)
      let growScale = 1
      if (growT < 1) {
        // easeOutBack — overshoots ~1.1 around growT=0.6, settles at 1
        const c1 = 1.70158
        const c3 = c1 + 1
        growScale = 1 + c3 * Math.pow(growT - 1, 3) + c1 * Math.pow(growT - 1, 2)
      }
      const flakeR = r * 1.55 * growScale
      ctx.save()
      ctx.translate(sx, sy)
      ctx.rotate(flakeRot)
      // Halo backdrop — soft cyan glow so the snowflake's white strokes pop against the enemy
      const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, flakeR * 1.1)
      halo.addColorStop(0, `rgba(180, 230, 255, 0.32)`)
      halo.addColorStop(0.7, `rgba(140, 210, 250, 0.18)`)
      halo.addColorStop(1, `rgba(120, 200, 250, 0)`)
      ctx.beginPath()
      ctx.arc(0, 0, flakeR * 1.1, 0, Math.PI * 2)
      ctx.fillStyle = halo
      ctx.fill()
      // The six arms — drawn as one path then stroked twice (wide glow + thin white core)
      const drawArms = (strokeStyle: string, width: number) => {
        ctx.strokeStyle = strokeStyle
        ctx.lineWidth = width
        ctx.lineCap = 'round'
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2
          const ax2 = Math.cos(a) * flakeR
          const ay2 = Math.sin(a) * flakeR
          // Main arm
          ctx.beginPath()
          ctx.moveTo(0, 0)
          ctx.lineTo(ax2, ay2)
          ctx.stroke()
          // Mid-arm V branch (at 50% along the arm)
          {
            const bx = ax2 * 0.5
            const by = ay2 * 0.5
            const bl = flakeR * 0.22
            ctx.beginPath()
            ctx.moveTo(bx, by)
            ctx.lineTo(bx + Math.cos(a + 0.7) * bl, by + Math.sin(a + 0.7) * bl)
            ctx.moveTo(bx, by)
            ctx.lineTo(bx + Math.cos(a - 0.7) * bl, by + Math.sin(a - 0.7) * bl)
            ctx.stroke()
          }
          // Outer-arm V branch (at 75% along the arm)
          {
            const bx = ax2 * 0.75
            const by = ay2 * 0.75
            const bl = flakeR * 0.14
            ctx.beginPath()
            ctx.moveTo(bx, by)
            ctx.lineTo(bx + Math.cos(a + 0.7) * bl, by + Math.sin(a + 0.7) * bl)
            ctx.moveTo(bx, by)
            ctx.lineTo(bx + Math.cos(a - 0.7) * bl, by + Math.sin(a - 0.7) * bl)
            ctx.stroke()
          }
        }
      }
      // Wide soft glow layer underneath
      drawArms(`rgba(140, 210, 250, 0.55)`, 6)
      // Crisp white core on top
      drawArms(`rgba(240, 250, 255, 0.95)`, 2)
      // Central hex hub — also grows with growScale so everything snaps in together
      const hubR = r * 0.22 * growScale
      ctx.beginPath()
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2
        const hx = Math.cos(a) * hubR
        const hy = Math.sin(a) * hubR
        if (i === 0) ctx.moveTo(hx, hy)
        else ctx.lineTo(hx, hy)
      }
      ctx.closePath()
      ctx.fillStyle = `rgba(240, 250, 255, 0.9)`
      ctx.fill()
      ctx.strokeStyle = `rgba(180, 230, 255, 0.9)`
      ctx.lineWidth = 1.4
      ctx.stroke()
      ctx.lineCap = 'butt'
      ctx.restore()
      // Occasional "frozen breath" particle drifting up
      if (Math.random() < 0.18) {
        spawnParticle(enemy.x + (Math.random() - 0.5) * r * 0.5, enemy.y - r * 0.4,
          (Math.random() - 0.5) * 12, -25 - Math.random() * 15,
          220, 240, 255, 0.5 + Math.random() * 0.3, 2 + Math.random() * 1.5)
      }
    }
  }
  // Snowflake "shatter free" — one-shot trigger when immobility ends. Set in updateEnemy
  // when immobileTimer crosses 0; consumed here so we only spawn the effect once.
  if (enemy.immobileJustBroke) {
    enemy.immobileJustBroke = false
    spawnSnowflakeShatter(enemy.x, enemy.y, r * 1.55)
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

  // Pusher shockwave — same inner-pulse visual as wall springs but tinted to the enemy's
  // identity color. Concentric ring expands from the enemy's center to its rim, clipped
  // to the body so it never spills outside. Three layers (glow / core / hot) matching the
  // wall shockwave aesthetic; layer widths scale with enemy radius via the same formula.
  if (enemy.pusher && !enemy.dying && enemy.pusherLastFireBeat != null && r > 4) {
    const cycle = enemy.pusherBeats
    const shockDur = Math.min(0.22, cycle * 0.32)   // matches wall shockwave duration
    const beatsSinceFire = getAbsoluteBeats() - enemy.pusherLastFireBeat
    if (beatsSinceFire >= 0 && beatsSinceFire < shockDur) {
      const progress = beatsSinceFire / shockDur   // 0 at fire → 1 at rim
      const alpha = (1 - progress * progress)
      if (alpha > 0.01) {
        const rEff = Math.max(2, r - 1)
        const ringR = progress * rEff
        const glowW = Math.max(8, rEff * 0.60)
        const coreW = Math.max(3, rEff * 0.24)
        const hotW = Math.max(1, rEff * 0.08)
        // Tinted colors — glow is the pure enemy color, core lerps 40% toward gold, hot
        // is near-white. Gives "energy from within, lit hot at the leading edge."
        const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t)
        const glowColor = `rgba(${hr}, ${hg}, ${hb}, ${alpha * 0.55})`
        const coreColor = `rgba(${lerp(hr, 255, 0.4)}, ${lerp(hg, 245, 0.4)}, ${lerp(hb, 200, 0.4)}, ${alpha})`
        const hotColor = `rgba(255, 255, 245, ${alpha * 0.9})`
        ctx.save()
        ctx.beginPath()
        ctx.arc(sx, sy, rEff, 0, Math.PI * 2)
        ctx.clip()
        ctx.beginPath()
        ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = glowColor; ctx.lineWidth = glowW; ctx.stroke()
        ctx.strokeStyle = coreColor; ctx.lineWidth = coreW; ctx.stroke()
        ctx.strokeStyle = hotColor; ctx.lineWidth = hotW; ctx.stroke()
        ctx.restore()
      }
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

      // Glow — bumped alpha for more presence without widening the silhouette.
      ctx.beginPath()
      ctx.moveTo(baseX + Math.cos(angle + Math.PI / 2) * glowWidth, baseY + Math.sin(angle + Math.PI / 2) * glowWidth)
      ctx.lineTo(tipX, tipY)
      ctx.lineTo(baseX + Math.cos(angle - Math.PI / 2) * glowWidth, baseY + Math.sin(angle - Math.PI / 2) * glowWidth)
      ctx.closePath()
      ctx.fillStyle = `rgba(${fR}, ${fG}, ${fB}, ${0.18 + pulse * 0.15 + fireFlash * 0.3})`
      ctx.fill()

      // Core spike — brighter saturated red.
      ctx.beginPath()
      ctx.moveTo(baseX + Math.cos(angle + Math.PI / 2) * coreWidth, baseY + Math.sin(angle + Math.PI / 2) * coreWidth)
      ctx.lineTo(tipX, tipY)
      ctx.lineTo(baseX + Math.cos(angle - Math.PI / 2) * coreWidth, baseY + Math.sin(angle - Math.PI / 2) * coreWidth)
      ctx.closePath()
      ctx.fillStyle = `rgba(${fR}, ${fG}, ${fB}, ${0.45 + pulse * 0.25 + fireFlash * 0.4})`
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
    const lockCr = 0, lockCg = 220, lockCb = 255  // electric cyan when locked

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
                  255, 215, 64, 0.25 + Math.random() * 0.15, 4 + Math.random() * 3)
              }
            }
          }
        } else if (isActive) {
          // Active — bright pulsing plus with clear hitbox ring
          const flash = Math.max(0, 1 - beatFrac * 2.5)
          // Glow halo — bigger and brighter
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR + 6 + flash * 8, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.12 + flash * 0.2})`
          ctx.fill()
          // BG circle
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.2 + flash * 0.25})`
          ctx.fill()
          // Hitbox ring
          ctx.beginPath()
          ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.6 + flash * 0.35})`
          ctx.lineWidth = 2.5 + flash * 1.5
          ctx.stroke()
          // Plus — pulses
          const activeSize = plusSize + flash * 3
          const activeW = plusW + flash * 2
          ctx.lineCap = 'round'
          ctx.lineWidth = activeW
          ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.8 + flash * 0.2})`
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

        // Inner radial glow — bright, covers underlying color
        const lockGrad = ctx.createRadialGradient(nx, ny, 0, nx, ny, nodeR)
        lockGrad.addColorStop(0, `rgba(200, 255, 255, ${0.9 + lockPulse * 0.1})`)
        lockGrad.addColorStop(0.3, `rgba(${cr}, ${cg}, ${cb}, ${0.75 + lockPulse * 0.15})`)
        lockGrad.addColorStop(0.7, `rgba(${cr}, ${cg}, ${cb}, 0.5)`)
        lockGrad.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0.3)`)
        ctx.beginPath()
        ctx.arc(nx, ny, nodeR, 0, Math.PI * 2)
        ctx.fillStyle = lockGrad
        ctx.fill()

        // Counter-rotating arc layers
        drawRitualNodeArcs(nx, ny, nodeR * 0.7, cr, cg, cb, 0.6, 2, lockSpin, 2, 0.35)
        drawRitualNodeArcs(nx, ny, nodeR * 0.45, 255, 255, 255, 0.25, 1.5, -lockSpin * 1.3, 3, 0.3)

        // Bright white core dot — big and glowy
        ctx.beginPath()
        ctx.arc(nx, ny, 8 + lockPulse * 5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${0.85 + lockPulse * 0.15})`
        ctx.fill()
        // Soft glow halo behind core
        ctx.beginPath()
        ctx.arc(nx, ny, 10 + lockPulse * 5, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(200, 255, 255, ${0.15 + lockPulse * 0.1})`
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
                255, 215, 64, 0.25 + Math.random() * 0.15, 5 + Math.random() * 3.5)
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

      // Coalescing core — grows from nothing during activation, then ruptures
      // Phase 1 (0→0.5): core forms from node energy converging to center
      // Phase 2 (0.5→1): core ruptures outward
      const formPhase = Math.min(explodeT / 0.5, 1)  // 0→1 over first half
      const burstPhase = Math.max(0, (explodeT - 0.5) / 0.5)  // 0→1 over second half

      const coreR = r * 0.35 * formPhase * Math.max(0, 1 - burstPhase * burstPhase)  // grows then shrinks fast on burst
      const corePulse = 0.5 + 0.5 * Math.sin(now / 150)

      // Nodes get sucked toward center
      for (let i = 0; i < N; i++) {
        const a = baseRot + (i / N) * Math.PI * 2
        const pullR = orbitR * (1 - formPhase * 0.8)  // pull inward as core forms
        const anx = sx + Math.cos(a) * pullR
        const any = sy + Math.sin(a) * pullR
        const dissolveSize = nodeR * (1 - formPhase)  // shrink to nothing
        if (dissolveSize > 0.5) {
          ctx.beginPath()
          ctx.arc(anx, any, dissolveSize, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${(1 - formPhase) * 0.5})`
          ctx.fill()
        }
        // Energy stream from node to center during form phase
        if (formPhase < 1) {
          ctx.beginPath()
          ctx.moveTo(anx, any)
          ctx.lineTo(sx, sy)
          ctx.strokeStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${formPhase * 0.3})`
          ctx.lineWidth = 2 + formPhase * 3
          ctx.lineCap = 'round'
          ctx.stroke()
          ctx.lineCap = 'butt'
        }
      }

      // Core glow halo
      if (coreR > 1) {
        ctx.beginPath()
        ctx.arc(sx, sy, coreR + 10 + corePulse * 4, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${formPhase * 0.15 * (1 - burstPhase * 0.5)})`
        ctx.fill()

        // Core body
        ctx.beginPath()
        ctx.arc(sx, sy, coreR + corePulse * 2, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${0.3 + formPhase * 0.4 - burstPhase * 0.4})`
        ctx.fill()

        // White-hot center
        const hotR = coreR * 0.5 * (1 - burstPhase * 0.6)
        ctx.beginPath()
        ctx.arc(sx, sy, hotR + corePulse, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${formPhase * 0.5 - burstPhase * 0.3})`
        ctx.fill()

        // Spinning arcs around core
        const coreSpin = now / 300
        const arcCount = 4
        const arcLen = (Math.PI * 2 / arcCount) * 0.6
        for (let a = 0; a < arcCount; a++) {
          const aStart = coreSpin + (a / arcCount) * Math.PI * 2
          ctx.beginPath()
          ctx.arc(sx, sy, coreR + 3, aStart, aStart + arcLen)
          ctx.strokeStyle = `rgba(255, 255, 255, ${formPhase * 0.3 * (1 - burstPhase)})`
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }

      // Burst phase — shockwave + radial lines
      if (burstPhase > 0) {
        const shock1R = coreR + burstPhase * r * 0.4
        ctx.beginPath()
        ctx.arc(sx, sy, shock1R, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${(1 - burstPhase) * 0.6})`
        ctx.lineWidth = 4 * (1 - burstPhase)
        ctx.stroke()

        const lineCount = 10
        for (let i = 0; i < lineCount; i++) {
          const la = (i / lineCount) * Math.PI * 2 + burstPhase * 0.8
          const innerR = coreR * 0.3
          const outerR = coreR + burstPhase * r * 0.5
          ctx.beginPath()
          ctx.moveTo(sx + Math.cos(la) * innerR, sy + Math.sin(la) * innerR)
          ctx.lineTo(sx + Math.cos(la) * outerR, sy + Math.sin(la) * outerR)
          ctx.strokeStyle = `rgba(${lockCr}, ${lockCg}, ${lockCb}, ${(1 - burstPhase) * 0.35})`
          ctx.lineWidth = 2.5 * (1 - burstPhase)
          ctx.stroke()
        }
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
            const speed = 150 + Math.random() * 120
            spawnParticle(pnx, pny,
              Math.cos(toAngle) * speed + (Math.random() - 0.5) * 40,
              Math.sin(toAngle) * speed + (Math.random() - 0.5) * 40,
              lockCr, lockCg, lockCb, 0.25 + Math.random() * 0.15, 5 + Math.random() * 4)
          }
        }
        // Core rupture burst outward
        for (let p = 0; p < 24; p++) {
          const a = (p / 24) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
          const speed = 250 + Math.random() * 300
          spawnParticle(enemy.x, enemy.y,
            Math.cos(a) * speed, Math.sin(a) * speed,
            255, 255, 255, 0.2 + Math.random() * 0.15, 4.5 + Math.random() * 3.5)
        }
        // Pink energy burst
        for (let p = 0; p < 14; p++) {
          const a = Math.random() * Math.PI * 2
          const speed = 180 + Math.random() * 250
          spawnParticle(enemy.x, enemy.y,
            Math.cos(a) * speed, Math.sin(a) * speed,
            lockCr, lockCg, lockCb, 0.3 + Math.random() * 0.2, 5 + Math.random() * 4)
        }
      }
    }
  }

  if (enemy.blink && enemy.blinkPreview > 0) ctx.globalAlpha = 1

  // Shield visuals — distinct cyan visual language (player shield is pink). Mirrors the
  // shape of Renderer.ts:2742-3019 (passive ring, fuse-style recharge arc, break shards).
  // Color: bright electric cyan = "defensive". Constant across all enemy shields for
  // unified visual language.
  if (enemy.shield && enemy.alive && !enemy.dying) {
    const sr = r
    const SR = 0, SG = 220, SB = 255   // shield base color (cyan)
    if (enemy.shieldCharges > 0) {
      // Active shield — pulsing cyan ring + ambient sparks
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300)
      const fastPulse = 0.5 + 0.5 * Math.sin(performance.now() / 120)
      // Activation flash — bright outer ring fading over ~0.55s after restore
      if (enemy.shieldActivateTimer > 0) {
        const af = enemy.shieldActivateTimer / 0.55   // 1→0
        ctx.beginPath()
        ctx.arc(sx, sy, sr + 1, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(200, 245, 255, ${af * 0.55})`
        ctx.lineWidth = 5 + af * 4
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(sx, sy, sr, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${SR}, ${SG}, ${SB}, ${0.85 + fastPulse * 0.15})`
      ctx.lineWidth = 4.5 + pulse * 0.6
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(sx, sy, sr - 0.7, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(180, 240, 255, ${0.3 + fastPulse * 0.15})`
      ctx.lineWidth = 1.5
      ctx.stroke()
      // Persistent scan glare — same as player, in cyan, beat-synced ping-pong
      {
        const cycle = (getLoopPosition() * 2) % 2        // 0→2 over 1 beat (double-time)
        const scanT = cycle < 1 ? cycle : 2 - cycle      // ping-pong 0→1→0
        const scanY = sy - sr + scanT * sr * 2
        const bandH = sr * 0.55
        ctx.save()
        ctx.beginPath()
        ctx.arc(sx, sy, sr, 0, Math.PI * 2)
        ctx.clip()
        const grad = ctx.createLinearGradient(sx, scanY - bandH, sx, scanY + bandH)
        grad.addColorStop(0, `rgba(${SR}, ${SG}, ${SB}, 0)`)
        grad.addColorStop(0.5, 'rgba(180, 245, 255, 0.28)')
        grad.addColorStop(1, `rgba(${SR}, ${SG}, ${SB}, 0)`)
        ctx.fillStyle = grad
        ctx.fillRect(sx - sr, scanY - bandH, sr * 2, bandH * 2)
        ctx.restore()
      }
      const sparkBudget = Math.max(1, Math.floor(r * 0.04))
      const sparkCount = globalBeatPulse > 0.5 ? sparkBudget * 2 : sparkBudget
      for (let s = 0; s < sparkCount; s++) {
        if (Math.random() < 0.6) {
          const a = Math.random() * Math.PI * 2
          const out = a + (Math.random() - 0.5) * 1.2
          const speed = 40 + Math.random() * 60
          spawnParticle(
            enemy.x + Math.cos(a) * sr, enemy.y + Math.sin(a) * sr,
            Math.cos(out) * speed, Math.sin(out) * speed,
            100 + Math.floor(Math.random() * 100), 230, 255,
            0.14 + Math.random() * 0.1, Math.max(1.5, r * 0.05))
        }
      }
    } else if (enemy.shieldRechargeTimer > 0) {
      // Recharging — fuse-style: arc fills counterclockwise from top + leading tip glow + sparks
      // (matches player shield fuse direction)
      const progress = 1 - (enemy.shieldRechargeTimer / enemy.shieldRechargeTime)
      const pulseRate = 1500 - progress * 1300   // 1500ms early → 200ms near completion
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / pulseRate * Math.PI)
      // Filling arc — counterclockwise (true flag, matches player at Renderer.ts:2827)
      ctx.beginPath()
      ctx.arc(sx, sy, sr, -Math.PI / 2, -Math.PI / 2 - progress * Math.PI * 2, true)
      const ag = Math.round(SG + pulse * 35)
      const ab = Math.round(SB)
      ctx.strokeStyle = `rgba(80, ${ag}, ${ab}, ${0.6 + progress * 0.3 + pulse * 0.1})`
      ctx.lineWidth = 2.5 + progress * 1.5 + pulse * 0.5
      ctx.stroke()
      if (progress > 0.2) {
        ctx.beginPath()
        ctx.arc(sx, sy, sr + 1, -Math.PI / 2, -Math.PI / 2 - progress * Math.PI * 2, true)
        ctx.strokeStyle = `rgba(${SR}, ${SG}, ${SB}, ${progress * 0.2})`
        ctx.lineWidth = 2 + progress * 3
        ctx.stroke()
      }
      // Leading tip — fuse glow + sparks (counterclockwise = subtract from start angle)
      const tipAngle = -Math.PI / 2 - progress * Math.PI * 2
      const tipX = sx + Math.cos(tipAngle) * sr
      const tipY = sy + Math.sin(tipAngle) * sr
      const tipGlowR = (3 + progress * 8) * Math.max(1, r / 40)
      ctx.beginPath()
      ctx.arc(tipX, tipY, tipGlowR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(150, 240, 255, ${0.2 + progress * 0.4})`
      ctx.fill()
      // Spark trail off the tip — more as it approaches completion
      const sparkCount = Math.floor(1 + progress * 3)
      for (let s = 0; s < sparkCount; s++) {
        if (Math.random() < 0.25 + progress * 0.5) {
          const sparkAngle = tipAngle + (Math.random() - 0.5) * 1.5
          const speed = (40 + Math.random() * 70) * (1 + progress * 0.5)
          const sparkSize = (3 + Math.random() * 2) * Math.max(0.6, r * 0.04)
          spawnParticle(
            enemy.x + Math.cos(tipAngle) * sr,
            enemy.y + Math.sin(tipAngle) * sr,
            Math.cos(sparkAngle) * speed, Math.sin(sparkAngle) * speed,
            100 + Math.floor(Math.random() * 100), 230, 255,
            0.18 + Math.random() * 0.1, sparkSize)
        }
      }
    }
    // Break shockwave + shard burst (one-shot on the first frame of break).
    // Dramatic treatment: primary shockwave expands further/thicker, a second delayed
    // echo ring follows, white core blooms longer, and a ring of static lightning bolts
    // radiates outward — same visual language as the beat-dash AOE so the connection reads.
    if (enemy.shieldBreakFlash > 0) {
      const bt = enemy.shieldBreakFlash / SHIELD_BREAK_FLASH
      // Primary shockwave — bigger reach, thicker, gold-tinged white core for "snap"
      const shockR = sr + (1 - bt) * 300
      ctx.beginPath()
      ctx.arc(sx, sy, shockR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${SR}, ${SG}, ${SB}, ${bt * bt * 0.75})`
      ctx.lineWidth = 8 * bt + 1.5
      ctx.stroke()
      // Echo ring — lags behind primary, fades on a different curve so two distinct shells read
      const echoT = Math.max(0, bt - 0.15)
      if (echoT > 0) {
        const echoR = sr + (1 - echoT) * 200
        ctx.beginPath()
        ctx.arc(sx, sy, echoR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(180, 240, 255, ${echoT * 0.45})`
        ctx.lineWidth = 4 * echoT + 1
        ctx.stroke()
      }
      const innerR = sr + (1 - bt) * 110
      ctx.beginPath()
      ctx.arc(sx, sy, innerR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(220, 250, 255, ${bt * 0.55})`
      ctx.lineWidth = 4 * bt
      ctx.stroke()
      // Solid white-core flash — longer-lived than before (was bt > 0.7 → 0.3s of life)
      if (bt > 0.5) {
        ctx.beginPath()
        ctx.arc(sx, sy, sr + 2, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(200, 245, 255, ${(bt - 0.5) * 1.4})`
        ctx.fill()
      }
      // Shard burst — one-shot on the frame the shield breaks. Uses a transient flag
      // instead of `bt > 0.95` because updateEnemy ticks shieldBreakFlash down by dt
      // before render, so on first render bt is already ~0.917 at 60fps and shards never fired.
      if (enemy.shieldJustBroken) {
        enemy.shieldJustBroken = false
        const partScale = Math.max(2, r * 0.1)
        // More shards, faster, varied size for chunkier "shatter" read
        const shardCount = Math.floor(30 + r * 0.32)
        for (let i = 0; i < shardCount; i++) {
          const angle = (i / shardCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
          const px = enemy.x + Math.cos(angle) * sr
          const py = enemy.y + Math.sin(angle) * sr
          const speed = 900 + Math.random() * 700
          spawnParticle(px, py,
            Math.cos(angle) * speed + (Math.random() - 0.5) * 130,
            Math.sin(angle) * speed + (Math.random() - 0.5) * 130,
            80 + Math.floor(Math.random() * 80), 220, 255,
            0.28 + Math.random() * 0.22, partScale * (0.7 + Math.random() * 1.0))
        }
        // White-hot core sparks — beefier
        for (let i = 0; i < 14; i++) {
          const angle = Math.random() * Math.PI * 2
          const px = enemy.x + Math.cos(angle) * sr * 0.5
          const py = enemy.y + Math.sin(angle) * sr * 0.5
          const speed = 1000 + Math.random() * 700
          spawnParticle(px, py,
            Math.cos(angle) * speed, Math.sin(angle) * speed,
            230, 250, 255, 0.24 + Math.random() * 0.16, partScale * (0.55 + Math.random() * 0.5))
        }
        // Lightning burst — short jagged bolts radiating out from the break point.
        // Recolored implicitly by the shared bolt drawing (yellow/white), which still reads
        // as "electric discharge" against the cyan shell debris.
        const boltCount = 7
        const boltLen = sr * 1.6
        const boltScale = Math.min(2.2, Math.max(1.0, r / 26))
        for (let i = 0; i < boltCount; i++) {
          const a = (i / boltCount) * Math.PI * 2 + Math.random() * 0.5
          spawnStaticLightningBolt(enemy.x, enemy.y, a, boltLen * (0.7 + Math.random() * 0.5), boltScale, 0.22 + Math.random() * 0.06)
        }
      }
    }
    // Restore — small outward "punch" from the top + the spiral converge overlay handles the rest
    if (enemy.shieldJustRestored) {
      enemy.shieldJustRestored = false
      const partScale = Math.max(1.5, r * 0.08)
      ctx.beginPath()
      ctx.arc(sx, sy, sr + 1, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(200, 245, 255, 0.5)`
      ctx.lineWidth = 5
      ctx.stroke()
      const topX = enemy.x, topY = enemy.y - sr
      for (let p = 0; p < 8; p++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8
        const speed = 80 + Math.random() * 110
        spawnParticle(topX, topY, Math.cos(a) * speed, Math.sin(a) * speed,
          150 + Math.floor(Math.random() * 80), 230, 255,
          0.18 + Math.random() * 0.12, partScale)
      }
    }
    // Activation sweep — direct port of player's shieldActivateSweep (Renderer.ts:3108-3152),
    // recolored cyan. Two vertical gradient bands sweep top↓ and bottom↑ through the body.
    if (enemy.shieldActivateTimer > 0) {
      const sweepDur = 0.55
      const sweepT = 1 - (enemy.shieldActivateTimer / sweepDur)   // 0→1
      const sweepY = sy - sr + sweepT * sr * 2          // top to bottom
      const sweepY2 = sy + sr - sweepT * sr * 2         // bottom to top
      const bandH = sr * 0.75
      ctx.save()
      // Clip to enemy body circle
      ctx.beginPath()
      ctx.arc(sx, sy, sr + 1, 0, Math.PI * 2)
      ctx.clip()
      const fadeA = 1 - sweepT * 0.5
      // Top→bottom band
      const bandGrad = ctx.createLinearGradient(sx, sweepY - bandH, sx, sweepY + bandH)
      bandGrad.addColorStop(0, `rgba(${SR}, ${SG}, ${SB}, 0)`)
      bandGrad.addColorStop(0.3, `rgba(100, 235, 255, ${0.75 * fadeA})`)
      bandGrad.addColorStop(0.5, `rgba(220, 250, 255, ${0.9 * fadeA})`)
      bandGrad.addColorStop(0.7, `rgba(100, 235, 255, ${0.75 * fadeA})`)
      bandGrad.addColorStop(1, `rgba(${SR}, ${SG}, ${SB}, 0)`)
      ctx.fillStyle = bandGrad
      ctx.fillRect(sx - sr, sweepY - bandH, sr * 2, bandH * 2)
      // Bottom→top band
      const bandGrad2 = ctx.createLinearGradient(sx, sweepY2 - bandH, sx, sweepY2 + bandH)
      bandGrad2.addColorStop(0, `rgba(${SR}, ${SG}, ${SB}, 0)`)
      bandGrad2.addColorStop(0.3, `rgba(100, 235, 255, ${0.75 * fadeA})`)
      bandGrad2.addColorStop(0.5, `rgba(220, 250, 255, ${0.9 * fadeA})`)
      bandGrad2.addColorStop(0.7, `rgba(100, 235, 255, ${0.75 * fadeA})`)
      bandGrad2.addColorStop(1, `rgba(${SR}, ${SG}, ${SB}, 0)`)
      ctx.fillStyle = bandGrad2
      ctx.fillRect(sx - sr, sweepY2 - bandH, sr * 2, bandH * 2)
      // Sharp leading edge lines
      ctx.beginPath()
      ctx.moveTo(sx - sr, sweepY)
      ctx.lineTo(sx + sr, sweepY)
      ctx.moveTo(sx - sr, sweepY2)
      ctx.lineTo(sx + sr, sweepY2)
      ctx.strokeStyle = `rgba(220, 250, 255, ${0.9 * (1 - sweepT * 0.6)})`
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.restore()
    }
  }

  // (Dodge trail silhouettes + trail particles are rendered in a separate pass after all
  //  enemy bodies — see drawDodgeTrails — so they layer on top of every enemy's body.)

  // Dodge charge orbit dots — same visual language as player dash slots, scaled with enemy size.
  // Floor dot size at the player's 8.6 so small enemies still show readable dots.
  // Dot color is the COMPLEMENT of the enemy body — like player blue / dots green — so they pop.
  if (enemy.dodge && enemy.alive && !enemy.dying && enemy.dodgeSlots.length > 0) {
    const type = getEnemyType(enemy.typeName)
    const chargeTime = type?.dodgeChargeTime ?? 1.5
    const orbitR = r   // dot center sits on body edge, mirroring player's drawRadius orbit
    const orbitSpeed = performance.now() / 800
    const dotR = Math.max(10.32, r * 0.216)   // 20% larger than before (was 8.6 / r*0.18)
    const burstScale = Math.max(0.4, r * 0.04)   // particle size scale for consume/ready bursts
    // Use player's dash green for all dodge visuals — unified visual language
    const dr = 100, dg = 255, db = 120
    for (let i = 0; i < enemy.dodgeSlots.length; i++) {
      const angle = orbitSpeed + (Math.PI * 2 * i) / enemy.dodgeSlots.length
      const dx = sx + Math.cos(angle) * orbitR
      const dy = sy + Math.sin(angle) * orbitR
      const wx = enemy.x + Math.cos(angle) * orbitR    // world coords for particle spawning
      const wy = enemy.y + Math.sin(angle) * orbitR
      const timer = enemy.dodgeSlots[i]!

      // Consume burst — fires when slot was just consumed (mirrors player's dash-slot consume,
      // scaled smaller and tinted with the complement color)
      if (enemy.dodgeJustConsumed[i]) {
        enemy.dodgeJustConsumed[i] = false
        const dashAngle = Math.atan2(enemy.dashDirY, enemy.dashDirX)
        const backAngle = dashAngle + Math.PI
        for (let p = 0; p < 25; p++) {
          const a = backAngle + (Math.random() - 0.5) * 1.3
          const speed = 250 + Math.random() * 300
          spawnParticle(wx, wy,
            Math.cos(a) * speed + (Math.random() - 0.5) * 50,
            Math.sin(a) * speed + (Math.random() - 0.5) * 50,
            dr, dg, db, 0.25 + Math.random() * 0.15, burstScale * (3 + Math.random() * 2))
        }
        for (let p = 0; p < 6; p++) {
          const a = backAngle + (Math.random() - 0.5) * 0.8
          const speed = 380 + Math.random() * 250
          spawnParticle(wx, wy,
            Math.cos(a) * speed, Math.sin(a) * speed,
            220, 255, 230, 0.18 + Math.random() * 0.12, burstScale * (1.5 + Math.random() * 1.2))
        }
      }

      // Ready converge — kicks off the spiral+shockwave overlay (which tracks the orbit each frame).
      // Outward "punch" pop spawns from the orbit position; short-lived so the lag is invisible.
      if (enemy.dodgeJustReady[i]) {
        enemy.dodgeJustReady[i] = false
        enemy.dodgeReadyFlash[i] = 0.6
        for (let p = 0; p < 8; p++) {
          const a = (p / 8) * Math.PI * 2
          spawnParticle(wx, wy,
            Math.cos(a) * 75, Math.sin(a) * 75,
            200, 255, 210, 0.18, burstScale * 2.8)
        }
      }

      if (timer <= 0) {
        // Ready — radial gradient bead + swimming inner sparks + beat-pulsing core
        const readyR = dotR * 1.15
        // D: Radial gradient body
        const edgeR = Math.max(0, dr - 40)
        const edgeG = Math.max(0, dg - 40)
        const edgeB = Math.max(0, db - 40)
        const cr = Math.min(255, dr + 70)
        const cg = Math.min(255, dg + 70)
        const cb = Math.min(255, db + 70)
        const bodyGrad = ctx.createRadialGradient(dx, dy, 0, dx, dy, readyR)
        bodyGrad.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.98)`)
        bodyGrad.addColorStop(1, `rgba(${edgeR}, ${edgeG}, ${edgeB}, 0.92)`)
        ctx.beginPath()
        ctx.arc(dx, dy, readyR, 0, Math.PI * 2)
        ctx.fillStyle = bodyGrad
        ctx.fill()
        const coreR = readyR * (0.45 + globalBeatPulse * 1.65)
        const coreAlpha = 0.55 + globalBeatPulse * 0.45
        ctx.beginPath()
        ctx.arc(dx, dy, coreR, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${coreAlpha})`
        ctx.fill()
        ctx.strokeStyle = `rgba(${dr}, ${dg}, ${db}, 0.6)`
        ctx.lineWidth = 1.5
        ctx.stroke()
        if (Math.random() < 0.7) {
          const spread = orbitR * 0.15
          spawnParticle(
            wx + (Math.random() - 0.5) * spread,
            wy + (Math.random() - 0.5) * spread,
            (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 12,
            dr, dg, db, 0.22 + Math.random() * 0.18, Math.max(1.5, readyR * 0.25))
        }
      } else {
        // Recharging — cream pie on dark backing (15% bigger than ready dot for visibility)
        const fill = 1 - (timer / chargeTime)
        const pieR = dotR * 1.15
        ctx.beginPath()
        ctx.arc(dx, dy, pieR, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
        ctx.fill()
        if (fill > 0) {
          ctx.beginPath()
          ctx.moveTo(dx, dy)
          ctx.arc(dx, dy, pieR, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2)
          ctx.closePath()
          ctx.fillStyle = 'rgba(255, 255, 255, 1)'
          ctx.fill()
        }
        ctx.beginPath()
        ctx.arc(dx, dy, pieR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 255, 255, 0.5)`
        ctx.lineWidth = 1.2
        ctx.stroke()
      }
    }

    // Ready flash overlay — spiral converge → shockwave, follows the orbiting dot.
    // Same structure as player at Renderer.ts:3320-3380, scaled smaller and complement-tinted.
    const flashDuration = 0.6
    const flashScale = Math.max(0.45, r * 0.022)   // overall radii scale with enemy size
    for (let i = 0; i < enemy.dodgeReadyFlash.length; i++) {
      const ft = enemy.dodgeReadyFlash[i]!
      if (ft <= 0) continue
      enemy.dodgeReadyFlash[i] = ft - frameDt
      const fAngle = orbitSpeed + (Math.PI * 2 * i) / enemy.dodgeSlots.length
      const fx = sx + Math.cos(fAngle) * orbitR
      const fy = sy + Math.sin(fAngle) * orbitR
      const t = 1 - (ft / flashDuration)   // 0→1 progress
      if (t < 0.5) {
        // Phase 1: spiral converge
        const spiralT = t / 0.5
        const outerR = 112 * flashScale * (1 - spiralT * spiralT)
        const spiralRot = spiralT * Math.PI * 2
        ctx.beginPath()
        ctx.arc(fx, fy, outerR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${dr}, ${dg}, ${db}, ${0.4 + spiralT * 0.3})`
        ctx.lineWidth = (2 + spiralT * 1.5)
        ctx.stroke()
        const count = 4
        for (let s = 0; s < count; s++) {
          const a = (s / count) * Math.PI * 2 + spiralRot
          const px = fx + Math.cos(a) * outerR
          const py = fy + Math.sin(a) * outerR
          const dotSize = (5 + spiralT * 4) * flashScale
          // Dim complement → white-hot as they converge
          const tr = Math.floor(dr + spiralT * (255 - dr))
          const tg = Math.floor(dg + spiralT * (255 - dg))
          const tb = Math.floor(db + spiralT * (255 - db))
          ctx.beginPath()
          ctx.arc(px, py, dotSize, 0, Math.PI * 2)
          ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, ${0.6 + spiralT * 0.35})`
          ctx.fill()
        }
      } else {
        // Phase 2: shockwave ring
        const shockT = (t - 0.5) / 0.5
        const ringR = (18 + shockT * 68) * flashScale
        ctx.beginPath()
        ctx.arc(fx, fy, ringR, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${dr}, ${dg}, ${db}, ${(1 - shockT) * 0.7})`
        ctx.lineWidth = 3 * (1 - shockT)
        ctx.stroke()
        if (shockT < 0.4) {
          ctx.beginPath()
          ctx.arc(fx, fy, 26 * flashScale * (1 - shockT), 0, Math.PI * 2)
          ctx.fillStyle = `rgba(220, 255, 230, ${(1 - shockT * 2.5) * 0.6})`
          ctx.fill()
        }
      }
    }
  }
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

  // Volatile range — clear blast radius indicator in builder
  if (preview.volatile) {
    // Filled danger zone
    ctx.beginPath()
    ctx.arc(sx, sy, preview.volatileRange, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 80, 0, 0.06)'
    ctx.fill()

    // Dashed outer ring — bright and visible
    ctx.save()
    ctx.setLineDash([8, 5])
    ctx.beginPath()
    ctx.arc(sx, sy, preview.volatileRange, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255, 120, 0, 0.4)'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()

    // "BLAST RADIUS" label
    ctx.font = 'bold 11px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = 'rgba(255, 120, 0, 0.5)'
    ctx.fillText('BLAST RADIUS', sx, sy - preview.volatileRange - 10)
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
      ctx.fillStyle = `rgba(255, 60, 40, ${0.18 + pulse * 0.15})`
      ctx.fill()

      ctx.beginPath()
      ctx.moveTo(bx + Math.cos(a + Math.PI / 2) * cw, by + Math.sin(a + Math.PI / 2) * cw)
      ctx.lineTo(tx, ty)
      ctx.lineTo(bx + Math.cos(a - Math.PI / 2) * cw, by + Math.sin(a - Math.PI / 2) * cw)
      ctx.closePath()
      ctx.fillStyle = `rgba(255, 80, 60, ${0.45 + pulse * 0.25})`
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
  csWasDrawn = false
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
  const rcx = width / 2, rcy = height / 2 - 70
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

    // Trail particles during buildup — race along ring
    if (buildup > 0.3) {
      const trailCount = Math.floor(buildup * 2)
      const worldCxT = rcx + camX
      const worldCyT = rcy + camY
      spawnRingParticles(worldCxT, worldCyT, ringR, 100, 255, 255, trailCount, 20 + buildup * 40, 0.3, 2)
    }

    // White-gold flash at exact peak
    if (pastPeak >= 0 && pastPeak < 0.05) {
      const peakFlash = 1 - (pastPeak / 0.05)
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 220, 100, ${peakFlash * 0.5})`
      ctx.lineWidth = 14
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${peakFlash * 0.95})`
      ctx.lineWidth = 7
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${peakFlash})`
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Red flash at peak
    if (pastPeak >= 0 && pastPeak < 0.2) {
      const redT = 1 - pastPeak / 0.2
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 100, 100, ${redT * 0.08})`
      ctx.lineWidth = 20
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 80, 80, ${redT * 0.18})`
      ctx.lineWidth = 8
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ringR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 80, 80, ${redT * 0.5})`
      ctx.lineWidth = 3
      ctx.stroke()
    }

    // Tangential streak explosion at peak — particles race along ring circumference
    if (pastPeak >= 0 && pastPeak < lastDt * 2) {
      const worldCx = rcx + camX
      const worldCy = rcy + camY
      const ringScale = Math.max(1, ringR / 140)
      const totalCount = Math.round(21 * ringScale)
      const angleOffset = Math.random() * Math.PI * 2
      for (let i = 0; i < totalCount; i++) {
        const angle = angleOffset + (i / totalCount) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI * 2 / totalCount) * 0.3
        const px = worldCx + Math.cos(angle) * ringR
        const py = worldCy + Math.sin(angle) * ringR
        const dir = i % 2 === 0 ? 1 : -1
        const tangentAngle = angle + (Math.PI / 2) * dir
        const tangentSpeed = 240 + Math.random() * 360
        const inwardSpeed = -(40 + Math.random() * 40)
        const vx = Math.cos(tangentAngle) * tangentSpeed + Math.cos(angle) * inwardSpeed
        const vy = Math.sin(tangentAngle) * tangentSpeed + Math.sin(angle) * inwardSpeed
        const isRed = i % 10 === 0
        const isWhite = !isRed && i % 4 === 0
        const lt = 0.16 + Math.random() * 0.12
        const sz = (isWhite ? 7.7 : 6.5) * (0.9 + Math.random() * 0.3)
        const pr = isRed ? 255 : isWhite ? 255 : 100
        const pg = isRed ? 60 + Math.floor(Math.random() * 40) : isWhite ? 255 : 255
        const pb = isRed ? 50 + Math.floor(Math.random() * 30) : isWhite ? 255 : 255
        spawnParticle(px, py, vx, vy, pr, pg, pb, lt, sz)
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

    // Trail particles during buildup
    if (buildup2 > 0.3) {
      const trailCount = Math.floor(buildup2 * 2)
      const worldCxT = rcx + camX
      const worldCyT = rcy + camY
      spawnRingParticles(worldCxT, worldCyT, ring2R, 255, 150, 230, trailCount, 20 + buildup2 * 40, 0.3, 2)
    }

    // White-gold flash at exact peak
    if (pastPeak2 >= 0 && pastPeak2 < 0.05) {
      const peakFlash = 1 - (pastPeak2 / 0.05)
      ctx.beginPath()
      ctx.arc(rcx, rcy, ring2R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 220, 100, ${peakFlash * 0.5})`
      ctx.lineWidth = 14
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ring2R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${peakFlash * 0.95})`
      ctx.lineWidth = 7
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(rcx, rcy, ring2R, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 255, 255, ${peakFlash})`
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Pink flash at peak
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

    // Tangential streak explosion at peak
    if (pastPeak2 >= 0 && pastPeak2 < lastDt * 2) {
      const worldCx2 = rcx + camX
      const worldCy2 = rcy + camY
      const ringScale = Math.max(1, ring2R / 140)
      const totalCount = Math.round(18 * ringScale)
      const angleOffset = Math.random() * Math.PI * 2
      for (let i = 0; i < totalCount; i++) {
        const angle = angleOffset + (i / totalCount) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI * 2 / totalCount) * 0.3
        const px = worldCx2 + Math.cos(angle) * ring2R
        const py = worldCy2 + Math.sin(angle) * ring2R
        const dir = i % 2 === 0 ? 1 : -1
        const tangentAngle = angle + (Math.PI / 2) * dir
        const tangentSpeed = 220 + Math.random() * 340
        const inwardSpeed = -(40 + Math.random() * 40)
        const vx = Math.cos(tangentAngle) * tangentSpeed + Math.cos(angle) * inwardSpeed
        const vy = Math.sin(tangentAngle) * tangentSpeed + Math.sin(angle) * inwardSpeed
        const isPink = i % 10 === 0
        const isWhite = !isPink && i % 4 === 0
        const lt = 0.16 + Math.random() * 0.12
        const sz = (isWhite ? 7.7 : 6.5) * (0.9 + Math.random() * 0.3)
        const pr = isPink ? 255 : isWhite ? 255 : 255
        const pg = isPink ? 80 + Math.floor(Math.random() * 40) : isWhite ? 255 : 150
        const pb = isPink ? 180 + Math.floor(Math.random() * 30) : isWhite ? 255 : 230
        spawnParticle(px, py, vx, vy, pr, pg, pb, lt, sz)
      }
    }

  }

  // Particles drawn before title so letters render on top of streaks
  updateParticles(dt)
  drawParticles()

  // Vignette
  const vigGrad = ctx.createRadialGradient(width / 2, height / 2, height * 0.3, width / 2, height / 2, height * 0.8)
  vigGrad.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vigGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)')
  ctx.fillStyle = vigGrad
  ctx.fillRect(0, 0, width, height)

  const cx = width / 2
  const titleY = height * 0.44 - 50

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
  const btnY = height * 0.52 - 60
  const btnW = 230
  const btnH = 58
  const btnPulse = 0.5 + 0.5 * Math.sin(now * 3)
  const btnBeat = titleBeatPulse

  // Start button hover
  const startHov = checkHover('title_start', pauseMouseX >= cx - btnW / 2 && pauseMouseX <= cx + btnW / 2 && pauseMouseY >= btnY && pauseMouseY <= btnY + btnH)
  const hovB = startHov ? 0.15 : 0

  const sr = startHov ? 255 : 0, sg = startHov ? 50 : 255, sb = startHov ? 200 : 255

  // Button glow
  ctx.beginPath()
  ctx.roundRect(cx - btnW / 2 - 4, btnY - 4, btnW + 8, btnH + 8, 8)
  ctx.fillStyle = `rgba(${sr}, ${sg}, ${sb}, ${0.03 + btnBeat * 0.06 + hovB})`
  ctx.fill()

  // Button border
  ctx.beginPath()
  ctx.roundRect(cx - btnW / 2, btnY, btnW, btnH, 6)
  ctx.strokeStyle = `rgba(${sr}, ${sg}, ${sb}, ${0.4 + btnPulse * 0.2 + btnBeat * 0.3 + hovB * 2})`
  ctx.lineWidth = 2 + btnBeat + (startHov ? 1 : 0)
  ctx.stroke()

  // Button fill
  ctx.fillStyle = `rgba(${sr}, ${sg}, ${sb}, ${0.06 + btnBeat * 0.08 + hovB})`
  ctx.fill()

  // Button text
  ctx.font = 'bold 30px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = `rgba(${sr}, ${sg}, ${sb}, ${0.7 + btnPulse * 0.15 + btnBeat * 0.15 + hovB})`
  ctx.fillText('S T A R T', cx, btnY + btnH / 2 + 9)

  // Fullscreen button
  const fsY = btnY + btnH + 160
  const fsW = 240
  const fsH = 50
  const fsHov = checkHover('title_fs', pauseMouseX >= cx - fsW / 2 && pauseMouseX <= cx + fsW / 2 && pauseMouseY >= fsY && pauseMouseY <= fsY + fsH)
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

  drawPortalButton()
  finalizeHoverCheck()
}

// ── Challenge Select Screen ──
let csSelectedIndex = 0
export function getCsSelectedIndex(): number { return csSelectedIndex }
export function setCsSelectedIndex(idx: number): void { csSelectedIndex = idx }
export function navigateChallenge(dir: number): boolean {
  const challenges = getChallenges()
  const newIdx = csSelectedIndex + dir
  if (newIdx < 0 || newIdx >= challenges.length || csSlideDir !== 0) return false
  csSlideDir = dir
  csSlideTimer = 0
  return true
}
let csAnimTimer = 0
let csWasDrawn = false
let csSlideDir = 0    // -1 left, 1 right, 0 none
let csSlideTimer = 0
let csSlideFrom = 0
const CS_SLIDE_DUR = 0.18
let victoryScroll = 0
let victoryScrollbarRect: { x: number; y: number; w: number; h: number; thumbH: number; maxScroll: number } | null = null
let victoryScrollDragging = false
let victoryAutoScrolled = false
let lastSubmittedName = ''
let lastSubmittedTime = 0
let lastProjectedRank = 0
let lastDisplayedBeatCount = -1
let timerFlash = 0

// ── Toast System — popup text messages ──
interface Toast {
  text: string
  timer: number
  duration: number
  fadeIn: number
  fadeOut: number
  y: number         // 0-1 screen fraction
  size: number
  color: [number, number, number]
  id: string
  style: 'normal' | 'combo' | 'glow' | 'sad' | 'wave' | 'heavy' | 'zigzag' | 'explosive'
  glowWords: string[] | undefined
  glowColor: [number, number, number] | undefined
}

const toasts: Toast[] = []
const MAX_TOASTS = 2

export interface ToastOptions {
  duration: number
  fadeIn: number
  fadeOut: number
  y: number
  size: number
  color: [number, number, number]
  id: string
  style: 'normal' | 'combo' | 'glow' | 'sad' | 'wave' | 'heavy' | 'zigzag' | 'explosive'
  glowWords: string[]
  glowColor: [number, number, number]
}

export function showToast(text: string, opts?: Partial<ToastOptions>): void {
  const id = opts?.id ?? text
  // Skip if already showing
  if (toasts.some(t => t.id === id)) return
  // Push out old ones if at max
  while (toasts.length >= MAX_TOASTS) {
    const oldest = toasts[0]!
    oldest.timer = Math.min(oldest.timer, oldest.fadeOut)  // force into fade-out
    toasts.shift()
  }
  // Reduce size if stacking on an active toast
  const baseSize = opts?.size ?? 42
  const actualSize = toasts.length > 0 ? Math.round(baseSize * 0.9) : baseSize
  toasts.push({
    text,
    timer: 0,
    duration: opts?.duration ?? 3,
    fadeIn: opts?.fadeIn ?? 0.15,
    fadeOut: opts?.fadeOut ?? 0.5,
    y: opts?.y ?? 0.35,
    size: actualSize,
    color: opts?.color ?? [255, 255, 255],
    id,
    style: opts?.style ?? 'normal',
    glowWords: opts?.glowWords,
    glowColor: opts?.glowColor,
  })
}

export function clearToasts(): void {
  toasts.length = 0
}

function updateAndDrawToasts(dt: number): void {
  let stackOffset = 0
  for (let i = 0; i < toasts.length; i++) {
    const t = toasts[i]!
    t.timer += dt

    // Typewriter: chars per second, fast
    const typeSpeed = 60  // characters per second
    const totalChars = t.text.length
    const typeTime = totalChars / typeSpeed
    const visibleChars = Math.min(totalChars, Math.floor(t.timer * typeSpeed))

    // Duration starts counting after typewriter finishes
    const holdStart = typeTime
    const totalDur = holdStart + t.duration + t.fadeOut
    if (t.timer >= totalDur) {
      toasts.splice(i, 1)
      i--
      continue
    }

    // Alpha: type phase = 1, hold = 1, fade out
    let alpha: number
    if (t.timer < holdStart + t.duration) {
      alpha = 1
    } else {
      alpha = 1 - (t.timer - holdStart - t.duration) / t.fadeOut
    }

    // Slide up during first 0.3s
    const slideY = t.timer < 0.3 ? (1 - t.timer / 0.3) * 12 : 0

    const tx = width / 2
    const ty = height * t.y + slideY + stackOffset
    const displayText = t.text.slice(0, visibleChars)

    const cr = t.color[0], cg = t.color[1], cb = t.color[2]

    if (t.style === 'combo') {
      // ── Combo style: scale bounce + per-letter shake ──
      const now = performance.now() / 1000
      // Scale bounce: starts 2x, slams to 1x over 0.2s, slight overshoot
      const bounceT = Math.min(t.timer / 0.2, 1)
      const bounce = bounceT < 1 ? 2 - bounceT * 1.15 : 1 + (1 - Math.min((t.timer - 0.2) / 0.1, 1)) * 0.15
      const scale = Math.max(0.8, bounce)

      ctx.save()
      ctx.translate(tx, ty)
      ctx.scale(scale * alpha, scale * alpha)
      ctx.translate(-tx, -ty)

      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(displayText).width
      const letterW = fullW / Math.max(displayText.length, 1)
      const startX = tx - fullW / 2

      // Shake intensity — strong for first 0.8s, then dies
      const shakeAmt = Math.max(0, 1 - t.timer / 0.8) * 6

      for (let li = 0; li < displayText.length; li++) {
        const lx = startX + li * letterW
        const sx = Math.sin(now * 50 + li * 2.3) * shakeAmt
        const sy = Math.cos(now * 45 + li * 1.7) * shakeAmt

        // Glow
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.1 * alpha})`
        ctx.textAlign = 'left'
        ctx.fillText(displayText[li]!, lx + sx + 1, ty + t.size * 0.35 + sy)
        ctx.fillText(displayText[li]!, lx + sx - 1, ty + t.size * 0.35 + sy)

        // Shadow
        ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`
        ctx.fillText(displayText[li]!, lx + sx + 1, ty + t.size * 0.35 + sy + 2)

        // Letter
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.95 * alpha})`
        ctx.fillText(displayText[li]!, lx + sx, ty + t.size * 0.35 + sy)
      }

      ctx.restore()
    } else if (t.style === 'glow' && t.glowWords && t.glowColor) {
      // ── Glow style: certain words pulse with highlight color ──
      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(t.text).width
      const leftX = tx - fullW / 2
      ctx.textAlign = 'left'
      const textY = ty + t.size * 0.35
      const now = performance.now() / 1000
      const glowPulse = 0.4 + 0.3 * Math.sin(now * 10)
      const gr = t.glowColor[0], gg = t.glowColor[1], gb = t.glowColor[2]

      // Split text into words and draw each
      const words = displayText.split(' ')
      let curX = leftX
      for (let wi = 0; wi < words.length; wi++) {
        const word = words[wi]!
        const wordW = ctx.measureText(word).width
        const spaceW = ctx.measureText(' ').width
        const isGlow = t.glowWords.some(gw => word.toLowerCase().includes(gw.toLowerCase()))

        if (isGlow) {
          // Scale bounce + motion on glow words
          const wordCx = curX + wordW / 2
          const glowScale = 1 + glowPulse * 0.06
          // Dash motion for glow words on dash-related toasts, shake for others
          const isDashWord = t.id.includes('dash')
          const shakeAmt = glowPulse * 3
          const motionX = isDashWord ? Math.max(0, Math.sin(now * 8)) * 12 * glowPulse : Math.sin(now * 45) * shakeAmt
          const motionY = isDashWord ? 0 : Math.cos(now * 40) * shakeAmt
          ctx.save()
          ctx.translate(wordCx + motionX, textY + motionY)
          ctx.scale(glowScale, glowScale)
          ctx.translate(-wordCx, -textY)

          // Big glow halo
          ctx.fillStyle = `rgba(${gr}, ${gg}, ${gb}, ${0.12 * glowPulse * alpha})`
          for (let g = 0; g < 4; g++) {
            const angle = (g / 4) * Math.PI * 2
            ctx.fillText(word, curX + Math.cos(angle) * 2, textY + Math.sin(angle) * 2)
          }
          // Shadow
          ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`
          ctx.fillText(word, curX + 1, textY + 2)
          // Glowing word — bright
          ctx.fillStyle = `rgba(${gr}, ${gg}, ${gb}, ${(0.85 + glowPulse * 0.15) * alpha})`
          ctx.fillText(word, curX, textY)

          ctx.restore()
        } else {
          // Shadow
          ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`
          ctx.fillText(word, curX + 1, textY + 2)
          // Normal word
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.95 * alpha})`
          ctx.fillText(word, curX, textY)
        }
        curX += wordW + spaceW
      }

      // Typing cursor
      if (visibleChars < totalChars) {
        const cursorBlink = Math.floor(t.timer * 8) % 2 === 0
        if (cursorBlink) {
          const partialW = ctx.measureText(displayText).width
          const cursorX = leftX + partialW + 4
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.8 * alpha})`
          ctx.fillRect(cursorX, ty - t.size * 0.3, 3, t.size * 0.8)
        }
      }
    } else if (t.style === 'sad') {
      // ── Sad style: sinks down + drains to grey ──
      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(t.text).width
      const leftX = tx - fullW / 2
      ctx.textAlign = 'left'

      // Progress through display (0→1)
      const sadProgress = Math.min(t.timer / (typeTime + t.duration), 1)

      // Sink down over time
      const sinkY = sadProgress * 10
      const textY = ty + t.size * 0.35 + sinkY

      // Shrink slightly
      const sadScale = 1 - sadProgress * 0.15
      ctx.save()
      ctx.translate(tx, textY)
      ctx.scale(sadScale, sadScale)
      ctx.translate(-tx, -textY)

      // Drain from pink to grey
      const drainR = Math.floor(cr + (140 - cr) * sadProgress)
      const drainG = Math.floor(cg + (140 - cg) * sadProgress)
      const drainB = Math.floor(cb + (140 - cb) * sadProgress)

      // Dim alpha over time
      const sadAlpha = alpha * (1 - sadProgress * 0.4)

      // Shadow
      ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * sadAlpha})`
      ctx.fillText(displayText, leftX + 1, textY + 2)

      // Main text — draining color
      ctx.fillStyle = `rgba(${drainR}, ${drainG}, ${drainB}, ${0.95 * sadAlpha})`
      ctx.fillText(displayText, leftX, textY)

      ctx.restore()

      // Typing cursor
      if (visibleChars < totalChars) {
        const cursorBlink = Math.floor(t.timer * 8) % 2 === 0
        if (cursorBlink) {
          const partialW = ctx.measureText(displayText).width
          const cursorX = leftX + partialW + 4
          ctx.fillStyle = `rgba(${drainR}, ${drainG}, ${drainB}, ${0.8 * sadAlpha})`
          ctx.fillRect(cursorX, ty - t.size * 0.3, 3, t.size * 0.8)
        }
      }
    } else if (t.style === 'explosive') {
      // ── Explosive style: starts stable, shake intensifies, then letters fly apart ──
      const now = performance.now() / 1000
      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(displayText).width
      const letterW = fullW / Math.max(displayText.length, 1)
      const startX = tx - fullW / 2
      const textY = ty + t.size * 0.35
      const totalTime = typeTime + t.duration
      const progress = Math.min(t.timer / totalTime, 1)

      // Shake builds over time — starts calm, gets shaky
      const shakeIntensity = progress * progress * 6
      // In last 20%, letters drift outward slightly
      const explodeT = progress > 0.8 ? (progress - 0.8) / 0.2 : 0
      const centerX = tx
      const centerY = textY

      for (let li = 0; li < displayText.length; li++) {
        const lx = startX + li * letterW
        const sx = Math.sin(now * 40 + li * 2.3) * shakeIntensity
        const sy = Math.cos(now * 35 + li * 1.7) * shakeIntensity

        // Explode outward from center in last phase
        const exDx = (lx - centerX) * explodeT * 0.6
        const exDy = (Math.random() - 0.5) * explodeT * 12

        // Shadow
        ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`
        ctx.textAlign = 'left'
        ctx.fillText(displayText[li]!, lx + sx + exDx + 1, textY + sy + exDy + 2)

        // Letter — gets redder as it builds
        const ramp = Math.min(progress * 1.5, 1)
        const lr = Math.floor(cr + (255 - cr) * ramp)
        const lg = Math.floor(cg * (1 - ramp * 0.5))
        const lb = Math.floor(cb * (1 - ramp * 0.7))
        ctx.fillStyle = `rgba(${lr}, ${lg}, ${lb}, ${0.95 * alpha})`
        ctx.fillText(displayText[li]!, lx + sx + exDx, textY + sy + exDy)
      }
    } else if (t.style === 'zigzag') {
      // ── Zigzag style: letters alternate up/down, sliding side to side ──
      const now = performance.now() / 1000
      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(displayText).width
      const letterW = fullW / Math.max(displayText.length, 1)
      const startX = tx - fullW / 2
      const textY = ty + t.size * 0.35

      // Slide in from left
      const slideT = Math.min(t.timer / 0.2, 1)
      const slideX = (1 - slideT) * -100

      for (let li = 0; li < displayText.length; li++) {
        // Zigzag: odd letters go up, even go down, oscillating
        const zigDir = li % 2 === 0 ? 1 : -1
        const zigAmt = Math.sin(now * 4 + li * 0.8) * 5 * zigDir
        const lateralZig = Math.cos(now * 3 + li * 1.2) * 2
        const lx = startX + li * letterW + slideX + lateralZig

        // Shadow
        ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`
        ctx.textAlign = 'left'
        ctx.fillText(displayText[li]!, lx + 1, textY + zigAmt + 2)

        // Letter
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.95 * alpha})`
        ctx.fillText(displayText[li]!, lx, textY + zigAmt)
      }
    } else if (t.style === 'heavy') {
      // ── Heavy style: slams down, slow beefy shake, scale pulses ──
      const now = performance.now() / 1000
      // Slam: starts 80px above, drops with bounce
      const slamT = Math.min(t.timer / 0.25, 1)
      const bounce = slamT < 1 ? (1 - slamT) * -80 : Math.sin((t.timer - 0.25) * 8) * 6 * Math.max(0, 1 - (t.timer - 0.25) * 1.5)
      // Scale: big on slam, settles
      const scale = slamT < 1 ? 1.3 - slamT * 0.3 : 1 + Math.sin((t.timer - 0.25) * 6) * 0.05 * Math.max(0, 1 - (t.timer - 0.25))

      ctx.save()
      ctx.translate(tx, ty + bounce)
      ctx.scale(scale * alpha, scale * alpha)
      ctx.translate(-tx, -(ty + bounce))

      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(displayText).width
      const letterW = fullW / Math.max(displayText.length, 1)
      const startX = tx - fullW / 2

      // Slow, wide shake per letter
      const shakeAmt = Math.max(0, 1 - t.timer * 0.8) * 4

      for (let li = 0; li < displayText.length; li++) {
        const lx = startX + li * letterW
        const sx = Math.sin(now * 15 + li * 2) * shakeAmt
        const sy = Math.cos(now * 12 + li * 1.5) * shakeAmt

        // Heavy shadow — double thick
        ctx.fillStyle = `rgba(0, 0, 0, ${0.6 * alpha})`
        ctx.textAlign = 'left'
        ctx.fillText(displayText[li]!, lx + sx + 2, ty + bounce + t.size * 0.35 + sy + 3)

        // Glow
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.15 * alpha})`
        ctx.fillText(displayText[li]!, lx + sx, ty + bounce + t.size * 0.35 + sy)

        // Letter
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.95 * alpha})`
        ctx.fillText(displayText[li]!, lx + sx, ty + bounce + t.size * 0.35 + sy)
      }

      ctx.restore()
    } else if (t.style === 'wave') {
      // ── Wave style: RuneScape wave2 — each letter bobs with sine offset ──
      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(displayText).width
      const letterW = fullW / Math.max(displayText.length, 1)
      const startX = tx - fullW / 2
      const now = performance.now() / 1000
      const textY = ty + t.size * 0.35

      for (let li = 0; li < displayText.length; li++) {
        const waveY = Math.sin(now * 5 + li * 0.5) * 4
        const lx = startX + li * letterW

        // Shadow
        ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`
        ctx.textAlign = 'left'
        ctx.fillText(displayText[li]!, lx + 1, textY + waveY + 2)

        // Letter
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.95 * alpha})`
        ctx.fillText(displayText[li]!, lx, textY + waveY)
      }
    } else {
      // ── Normal style: typewriter + glow ──
      ctx.font = `bold ${t.size}px monospace`
      const fullW = ctx.measureText(t.text).width
      const leftX = tx - fullW / 2
      ctx.textAlign = 'left'
      const textY = ty + t.size * 0.35

      // Glow
      ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.08 * alpha})`
      for (let g = 0; g < 4; g++) {
        const gx = (g % 2 === 0 ? 1 : -1) * (g < 2 ? 1 : 0)
        const gy = (g < 2 ? 0 : 1) * (g % 2 === 0 ? 1 : -1)
        ctx.fillText(displayText, leftX + gx, textY + gy)
      }

      // Shadow
      ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`
      ctx.fillText(displayText, leftX + 1, textY + 2)

      // Main text
      ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.95 * alpha})`
      ctx.fillText(displayText, leftX, textY)

      // Typing cursor
      if (visibleChars < totalChars) {
        const cursorBlink = Math.floor(t.timer * 8) % 2 === 0
        if (cursorBlink) {
          const partialW = ctx.measureText(displayText).width
          const cursorX = leftX + partialW + 4
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${0.8 * alpha})`
          ctx.fillRect(cursorX, ty - t.size * 0.3, 3, t.size * 0.8)
        }
      }
    }

    stackOffset += t.size + 16
  }
}

// ── Passive Vibe Jam Portal button — bottom right, all screens ──
const PORTAL_W = 220
const PORTAL_H = 38
const PORTAL_PAD = 37

export function drawPortalButton(): void {
  const px = width - PORTAL_W - 4
  const py = height - PORTAL_H - PORTAL_PAD
  const hov = checkHover('portal_btn', pauseMouseX >= px && pauseMouseX <= px + PORTAL_W && pauseMouseY >= py && pauseMouseY <= py + PORTAL_H)
  const beat = globalBeatPulse || (titleBeatPulse ?? 0)

  ctx.globalAlpha = hov ? 1 : 0.7 + beat * 0.25
  ctx.beginPath()
  ctx.roundRect(px, py, PORTAL_W, PORTAL_H, 6)
  ctx.strokeStyle = `rgba(180, 80, 255, ${hov ? 0.9 : 0.5 + beat * 0.2})`
  ctx.lineWidth = hov ? 2 : 1.5
  ctx.stroke()
  ctx.fillStyle = `rgba(180, 80, 255, ${hov ? 0.2 : 0.06 + beat * 0.04})`
  ctx.fill()

  ctx.font = 'bold 18px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = `rgba(180, 80, 255, ${hov ? 1 : 0.85 + beat * 0.15})`
  ctx.fillText('VIBE JAM PORTAL', px + PORTAL_W / 2, py + PORTAL_H / 2 + 6)
  ctx.globalAlpha = 1
  ctx.textAlign = 'left'
}

export function isPortalClick(mx: number, my: number): boolean {
  const px = width - PORTAL_W - 4
  const py = height - PORTAL_H - PORTAL_PAD
  return mx >= px && mx <= px + PORTAL_W && my >= py && my <= py + PORTAL_H
}

// Controls hint — shows at challenge start, fades out
let controlsHintTimer = 0
const CONTROLS_HINT_DURATION = 5.25  // seconds visible
const CONTROLS_HINT_FADE = 1.0      // seconds to fade out
// Pro tips on death screen
const PRO_TIPS = [
  'Dash on the beat to trigger a close-range AOE attack',
  'Dash before the beat to spread out your next attack',
  'Turn while you dash!',
  'Your pink shield absorbs 1 hit - let it activate by not getting hit',
  "Don't summon more enemies than you can handle",
  'Exploding enemies damage other enemies',
  'If you\'re afraid to take damage, your time will suck',
  'A rotating red band means they can eat your hearts',
  'Some enemies can be used for protection',
]
let proTipIndex = 0

export function cycleProTip(dir: number): void {
  proTipIndex = ((proTipIndex + dir) % PRO_TIPS.length + PRO_TIPS.length) % PRO_TIPS.length
}
export function resetProTip(): void {
  proTipIndex = 0
}

let tutorialBeginner = false
let tutorialDashUsed = [false, false]
let tutorialPrevSlots = [0, 0]
let tutorialDashFade = 0  // fade timer for dash section after both used

export function showControlsHint(beginner = false): void {
  controlsHintTimer = CONTROLS_HINT_DURATION + CONTROLS_HINT_FADE
  tutorialBeginner = beginner
  tutorialDashUsed = [false, false]
  tutorialPrevSlots = [0, 0]
  tutorialDashFade = 0
}
let csPlayHover = false

export function getChallengeSelectHover(): number { return csPlayHover ? 0 : -1 }
export function getNameEntryText(): string { return nameEntryText }
export function setNameEntryText(t: string): void { nameEntryText = t }
export function resetNameEntry(): void { nameEntryText = ''; nameEntryStarted = false; nameFireworks.length = 0 }
export function scrollVictoryLeaderboard(delta: number): void { victoryScroll += delta }
let touchScrollActive = false
let touchScrollLastY = 0
export function touchScrollStart(y: number): void {
  if (isRunComplete()) {
    touchScrollActive = true
    touchScrollLastY = y
  }
}
export function touchScrollMove(y: number): void {
  if (touchScrollActive) {
    const delta = touchScrollLastY - y
    victoryScroll += delta * 2  // scale up since canvas coords are larger than screen
    touchScrollLastY = y
  }
}
export function touchScrollEnd(): void { touchScrollActive = false }
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

  // Animation timer — reset when first entering
  if (!csWasDrawn) { csAnimTimer = 0; csSlideDir = 0; titleLastBeat = -1 }
  csWasDrawn = true
  csAnimTimer += dt

  // Beat pulse — same as title screen
  const loopPos = getLoopPosition()
  const beatPhase = loopPos % 1
  const peakPoint = 0.45
  const currentBeat = Math.floor(loopPos)
  const pastPeakThisBeat = beatPhase >= peakPoint
  const beatId = currentBeat * 2 + (pastPeakThisBeat ? 1 : 0)
  if (beatId !== titleLastBeat && titleLastBeat >= 0 && pastPeakThisBeat) {
    titleBeatPulse = 1
  }
  titleLastBeat = beatId
  titleBeatPulse = Math.max(0, titleBeatPulse - dt * 3)
  const csBeat = titleBeatPulse

  // Slide animation update
  if (csSlideDir !== 0) {
    csSlideTimer += dt
    if (csSlideTimer >= CS_SLIDE_DUR) {
      csSelectedIndex = csSelectedIndex + csSlideDir
      csSlideDir = 0
      csSlideTimer = 0
    }
  }

  // Clamp index
  if (csSelectedIndex < 0) csSelectedIndex = 0
  if (csSelectedIndex >= challenges.length) csSelectedIndex = challenges.length - 1

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

  // Intro animation helpers
  const introAlpha = (delay: number, dur: number) => {
    const t = Math.max(0, csAnimTimer - delay)
    return Math.min(t / dur, 1)
  }
  const introEase = (delay: number, dur: number) => {
    const t = Math.min(Math.max(0, csAnimTimer - delay) / dur, 1)
    return 1 - (1 - t) * (1 - t)
  }

  // Back button — fade in
  const backA = introAlpha(0.12, 0.12)
  ctx.globalAlpha = backA
  const backW = 260, backH = 72, backX = 20, backY = 18
  const backHov = checkHover('cs_back', pauseMouseX >= backX && pauseMouseX <= backX + backW && pauseMouseY >= backY && pauseMouseY <= backY + backH)
  ctx.beginPath()
  ctx.roundRect(backX, backY, backW, backH, 12)
  ctx.strokeStyle = `rgba(0, 255, 255, ${backHov ? 0.7 : 0.35})`
  ctx.lineWidth = backHov ? 3 : 2
  ctx.stroke()
  ctx.fillStyle = `rgba(0, 255, 255, ${backHov ? 0.15 : 0.06})`
  ctx.fill()
  ctx.font = 'bold 34px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = `rgba(0, 255, 255, ${backHov ? 0.95 : 0.7})`
  ctx.fillText('\u2190 BACK', backX + backW / 2, backY + backH / 2 + 10)

  // Fullscreen / Windowed toggle
  const csfsW = 260, csfsH = 52
  const csfsX = backX, csfsY = backY + backH + 12
  const csfsHov = checkHover('cs_fs', pauseMouseX >= csfsX && pauseMouseX <= csfsX + csfsW && pauseMouseY >= csfsY && pauseMouseY <= csfsY + csfsH)
  ctx.beginPath()
  ctx.roundRect(csfsX, csfsY, csfsW, csfsH, 10)
  ctx.strokeStyle = `rgba(255, 50, 200, ${csfsHov ? 0.65 : 0.3})`
  ctx.lineWidth = csfsHov ? 2.5 : 1.5
  ctx.stroke()
  ctx.fillStyle = `rgba(255, 50, 200, ${csfsHov ? 0.15 : 0.05})`
  ctx.fill()
  ctx.font = 'bold 22px monospace'
  ctx.fillStyle = `rgba(255, 50, 200, ${csfsHov ? 0.95 : 0.65})`
  ctx.fillText(document.fullscreenElement ? 'WINDOWED' : 'FULLSCREEN', csfsX + csfsW / 2, csfsY + csfsH / 2 + 7)

  // Volume slider
  const csVolRect = drawVolumeSlider(csfsX, csfsY + csfsH + 30, csfsW)
  volumeSliderRect = csVolRect
  ctx.globalAlpha = 1

  if (challenges.length === 0) {
    ctx.font = '24px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)'
    ctx.fillText('No challenges created yet', cx, height / 2)
    ctx.textAlign = 'left'
    return
  }

  // ── Draw challenge card content (name + leaderboard) ──
  function drawCard(idx: number, xOffset: number, alpha: number): void {
    if (idx < 0 || idx >= challenges.length) return
    const ch = challenges[idx]!
    ctx.globalAlpha = alpha

    // Challenge name — drop in animation on initial load
    const nameE = introEase(0.06, 0.18)
    const nameDropY = xOffset === 0 && csSlideDir === 0 ? (1 - nameE) * -40 : 0
    const nameA = xOffset === 0 && csSlideDir === 0 ? nameE : 1
    ctx.globalAlpha = alpha * nameA
    ctx.font = 'bold 79px monospace'
    ctx.textAlign = 'center'
    // Per-letter cyan/pink wave — smooth shift synced to beat
    const nameStr = ch.name
    const letterW = 48
    const totalNameW = nameStr.length * letterW
    const nameStartX = cx + xOffset - totalNameW / 2 + letterW / 2
    const nameY = 140 + nameDropY
    // Smooth wave using beat phase — scrolls continuously through letters
    const wavePhase = loopPos * Math.PI * 2  // full cycle per beat
    for (let li = 0; li < nameStr.length; li++) {
      // Sine wave determines blend: 0=cyan, 1=pink
      const blend = 0.5 + 0.5 * Math.sin(wavePhase + li * 0.8)
      const r = Math.floor(blend * 255)
      const g = Math.floor((1 - blend) * 230 + blend * 50)
      const b = Math.floor((1 - blend) * 255 + blend * 200)
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.95)`
      // Beat shake — each letter bounces on beat with slight stagger
      const shake = csBeat * csBeat * 8
      const shakeX = Math.sin(now * 40 + li * 1.5) * shake
      const shakeY = -csBeat * csBeat * 14 + Math.cos(now * 35 + li * 1.1) * shake * 0.6
      ctx.fillText(nameStr[li]!, nameStartX + li * letterW + shakeX, nameY + shakeY)
    }
    ctx.globalAlpha = alpha

    // Leaderboard — top 10
    const lbW = 500
    const lbX = cx + xOffset - lbW / 2
    const lbStartY = 310
    const rowH = 36

    ctx.font = 'bold 32px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = 'rgba(0, 255, 255, 0.7)'
    ctx.fillText('LEADERBOARD', cx + xOffset, lbStartY - 10)

    const top10 = getScoresForChallenge(ch.name, 10)
    const medalColors = ['rgba(255, 215, 64, 0.9)', 'rgba(120, 220, 255, 0.8)', 'rgba(255, 160, 80, 0.75)']

    for (let s = 0; s < 10; s++) {
      // Cascade animation for initial load
      const rowDelay = 0.12 + s * 0.024
      const rowE = introEase(rowDelay, 0.12)
      const rowDropY = xOffset === 0 && csSlideDir === 0 ? (1 - rowE) * -20 : 0
      const rowA = xOffset === 0 && csSlideDir === 0 ? rowE : 1
      ctx.globalAlpha = alpha * rowA

      const scoreY = lbStartY + 28 + s * rowH + rowDropY
      if (s < top10.length) {
        const sc = top10[s]!
        const isTop3 = s < 3
        const color = isTop3 ? medalColors[s]! : 'rgba(255, 255, 255, 0.55)'

        ctx.font = 'bold 22px monospace'
        ctx.textAlign = 'right'
        ctx.fillStyle = color
        ctx.fillText(`${s + 1}.`, lbX + 45, scoreY)

        ctx.font = '22px monospace'
        ctx.textAlign = 'left'
        ctx.fillStyle = color
        ctx.fillText(sc.playerName, lbX + 60, scoreY)

        ctx.textAlign = 'right'
        ctx.fillStyle = color
        ctx.fillText(formatTime(sc.time), lbX + lbW - 10, scoreY)
      } else {
        ctx.font = '20px monospace'
        ctx.textAlign = 'right'
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)'
        ctx.fillText(`${s + 1}.`, lbX + 45, scoreY)
        ctx.textAlign = 'left'
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
        ctx.fillText('---', lbX + 60, scoreY)
      }
    }
    ctx.globalAlpha = 1
  }

  // Slide animation
  if (csSlideDir !== 0) {
    const t = Math.min(csSlideTimer / CS_SLIDE_DUR, 1)
    const eased = 1 - (1 - t) * (1 - t)
    const outX = eased * -csSlideDir * width * 0.6
    const inX = (1 - eased) * csSlideDir * width * 0.6
    drawCard(csSelectedIndex, outX, 1 - eased)
    drawCard(csSelectedIndex + csSlideDir, inX, eased)
  } else {
    drawCard(csSelectedIndex, 0, 1)
  }

  // Navigation arrows — chevron stacks, beat-synced
  const arrowA = introAlpha(0.24, 0.12)
  const arrowBeat = csBeat
  const arrowY = height / 2 + 40
  const arrowInset = 140
  const chevW = 73   // chevron width (how far the point sticks out)
  const chevH = 130  // chevron half-height
  const chevGap = 57  // spacing between chevrons
  const chevCount = 3
  const chevThick = 13

  function drawChevrons(centerX: number, centerY: number, dir: number, hov: boolean): void {
    const cr = hov ? 0 : 255, cg = hov ? 200 : 50, cb = hov ? 255 : 200
    const glowR = hov ? 100 : 255, glowG = hov ? 220 : 150, glowB = hov ? 255 : 230

    for (let c = 0; c < chevCount; c++) {
      // Ripple: beat pulse hits inner chevron first (c=2), ripples outward with delay
      // dir=1 (right arrow): inner=left, outer=right → pulse travels in arrow direction
      const rippleDelay = (chevCount - 1 - c) * 0.12  // 120ms stagger per chevron
      const chevPulse = Math.max(0, arrowBeat - rippleDelay * 3)  // scale delay to beat decay rate
      const litAmount = Math.min(1, chevPulse * 2)  // 0→1 intensity for this chevron

      const offset = (c - 1) * chevGap * dir
      const px = centerX + offset
      const baseAlpha = hov ? 0.85 : 0.65
      const alpha = baseAlpha + litAmount * 0.5

      ctx.beginPath()
      ctx.moveTo(px + chevW * dir, centerY)
      ctx.lineTo(px - chevW * 0.3 * dir, centerY - chevH)
      ctx.moveTo(px + chevW * dir, centerY)
      ctx.lineTo(px - chevW * 0.3 * dir, centerY + chevH)
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`
      ctx.lineWidth = chevThick + litAmount * 5
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()

      // Glow ripples through
      if (litAmount > 0.1) {
        ctx.beginPath()
        ctx.moveTo(px + chevW * dir, centerY)
        ctx.lineTo(px - chevW * 0.3 * dir, centerY - chevH)
        ctx.moveTo(px + chevW * dir, centerY)
        ctx.lineTo(px - chevW * 0.3 * dir, centerY + chevH)
        ctx.strokeStyle = `rgba(${glowR}, ${glowG}, ${glowB}, ${litAmount * 0.35})`
        ctx.lineWidth = chevThick + 18
        ctx.stroke()
      }
    }
    ctx.lineCap = 'butt'
    ctx.lineJoin = 'miter'
  }

  const hitW = chevCount * chevGap + chevW * 2
  const hitH = chevH * 2 + 30

  if (csSelectedIndex > 0 && csSlideDir === 0) {
    ctx.globalAlpha = arrowA
    const lx = arrowInset + hitW / 2
    const lHov = checkHover('cs_left', pauseMouseX >= arrowInset - 10 && pauseMouseX <= arrowInset + hitW + 10 && pauseMouseY >= arrowY - hitH / 2 && pauseMouseY <= arrowY + hitH / 2)
    drawChevrons(lx, arrowY, -1, lHov)
  }

  if (csSelectedIndex < challenges.length - 1 && csSlideDir === 0) {
    ctx.globalAlpha = arrowA
    const rx = width - arrowInset - hitW / 2
    const rHov = checkHover('cs_right', pauseMouseX >= width - arrowInset - hitW - 10 && pauseMouseX <= width - arrowInset + 10 && pauseMouseY >= arrowY - hitH / 2 && pauseMouseY <= arrowY + hitH / 2)
    drawChevrons(rx, arrowY, 1, rHov)
  }

  // Numbered pips — clickable level select circles
  const pipA = introAlpha(0.24, 0.12)
  ctx.globalAlpha = pipA
  const pipY = height - 60
  const pipR = 22
  const pipGap = 72
  const pipTotalW = (challenges.length - 1) * pipGap
  const activeIdx = csSlideDir !== 0 ? csSelectedIndex + csSlideDir : csSelectedIndex
  for (let i = 0; i < challenges.length; i++) {
    const px = cx - pipTotalW / 2 + i * pipGap
    const isActive = i === activeIdx
    const pipHov = checkHover(`pip_${i}`, pauseMouseX >= px - pipR - 4 && pauseMouseX <= px + pipR + 4 && pauseMouseY >= pipY - pipR - 4 && pauseMouseY <= pipY + pipR + 4)
    const beat = isActive ? csBeat : 0

    ctx.beginPath()
    ctx.arc(px, pipY, pipR + beat * 3, 0, Math.PI * 2)
    if (isActive) {
      ctx.fillStyle = `rgba(0, 255, 255, ${0.85 + beat * 0.15})`
      ctx.fill()
      ctx.strokeStyle = `rgba(0, 255, 255, ${0.6 + beat * 0.3})`
      ctx.lineWidth = 2.5
      ctx.stroke()
    } else {
      ctx.fillStyle = `rgba(0, 0, 0, ${pipHov ? 0.4 : 0.25})`
      ctx.fill()
      ctx.strokeStyle = `rgba(0, 255, 255, ${pipHov ? 0.7 : 0.35})`
      ctx.lineWidth = pipHov ? 2.5 : 1.5
      ctx.stroke()
    }

    // Number label
    ctx.font = 'bold 24px monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (isActive) {
      ctx.fillStyle = `rgba(13, 10, 26, 0.95)`  // dark on bright bg
    } else {
      ctx.fillStyle = `rgba(0, 255, 255, ${pipHov ? 0.9 : 0.5})`
    }
    ctx.fillText(`${i}`, px, pipY + 1)
    ctx.textBaseline = 'alphabetic'
  }

  // PLAY button — pop in at 0.3s, directly under challenge name
  const playT = Math.max(0, csAnimTimer - 0.18)
  const playProgress = Math.min(playT / 0.12, 1)
  const playScale = playProgress < 1 ? playProgress * 1.05 : 1 + (1 - Math.min((playT - 0.12) / 0.06, 1)) * 0.05
  const playA = Math.min(playProgress / 0.5, 1)

  ctx.globalAlpha = playA
  const playW = 416, playH = 94
  const playY = 168
  const playX = cx - playW / 2
  const playHov = checkHover('cs_play', pauseMouseX >= playX && pauseMouseX <= playX + playW && pauseMouseY >= playY && pauseMouseY <= playY + playH)
  csPlayHover = playHov
  const playBeat = csBeat

  ctx.save()
  ctx.translate(cx, playY + playH / 2)
  ctx.scale(playScale, playScale)
  ctx.translate(-cx, -(playY + playH / 2))

  const phr = playHov ? 0 : 255, phg = playHov ? 200 : 50, phb = playHov ? 255 : 200
  ctx.beginPath()
  ctx.roundRect(playX, playY, playW, playH, 12)
  ctx.strokeStyle = `rgba(${phr}, ${phg}, ${phb}, ${playHov ? 1 : 0.6 + playBeat * 0.35})`
  ctx.lineWidth = 2.5 + playBeat * 2 + (playHov ? 1 : 0)
  ctx.stroke()
  ctx.fillStyle = `rgba(${phr}, ${phg}, ${phb}, ${playHov ? 0.2 : 0.06 + playBeat * 0.1})`
  ctx.fill()

  ctx.font = 'bold 48px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = `rgba(${phr}, ${phg}, ${phb}, ${playHov ? 1 : 0.7 + playBeat * 0.3})`
  ctx.fillText('P L A Y', cx, playY + playH / 2 + 14)

  ctx.restore()
  ctx.globalAlpha = 1
  drawPortalButton()
  ctx.textAlign = 'left'
  finalizeHoverCheck()
}

export function handleChallengeSelectClick(mx: number, my: number): Challenge | null {
  const challenges = getChallenges()
  if (challenges.length === 0 || csSlideDir !== 0) return null

  // PLAY button
  const playW = 416, playH = 94
  const playY = 168
  const playX = width / 2 - playW / 2
  if (mx >= playX && mx <= playX + playW && my >= playY && my <= playY + playH) {
    return challenges[csSelectedIndex] ?? null
  }

  // Left arrow — chevron hit area
  const arrowY = height / 2 + 40
  const csArrowInset = 140
  const csHitW = 3 * 57 + 73 * 2  // chevCount * chevGap + chevW * 2
  const csHitH = 130 * 2 + 40     // chevH * 2 + padding
  if (csSelectedIndex > 0 && mx >= csArrowInset - 10 && mx <= csArrowInset + csHitW + 10 && my >= arrowY - csHitH / 2 && my <= arrowY + csHitH / 2) {
    playUIClick()
    csSlideDir = -1
    csSlideTimer = 0
    return null
  }

  // Right arrow
  if (csSelectedIndex < challenges.length - 1 && mx >= width - csArrowInset - csHitW - 10 && mx <= width - csArrowInset + 10 && my >= arrowY - csHitH / 2 && my <= arrowY + csHitH / 2) {
    playUIClick()
    csSlideDir = 1
    csSlideTimer = 0
    return null
  }

  // Numbered pips — click to jump to challenge
  const pipY = height - 60
  const pipR = 22
  const pipGap = 72
  const pipTotalW = (challenges.length - 1) * pipGap
  for (let i = 0; i < challenges.length; i++) {
    const px = width / 2 - pipTotalW / 2 + i * pipGap
    if (mx >= px - pipR - 4 && mx <= px + pipR + 4 && my >= pipY - pipR - 4 && my <= pipY + pipR + 4) {
      if (i !== csSelectedIndex) {
        playUIClick()
        csSlideDir = i > csSelectedIndex ? 1 : -1
        csSlideTimer = 0
        // Jump directly — override the slide to land on target
        csSelectedIndex = i - csSlideDir
      }
      return null
    }
  }

  return null
}

export function handleChallengeSelectHover(mx: number, my: number): void {
  // Hover is handled by checkHover in draw — nothing extra needed here
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

let spawnPanelVisible = false
export function toggleSpawnPanel(): void { spawnPanelVisible = !spawnPanelVisible }
export function isSpawnPanelVisible(): boolean { return spawnPanelVisible }

let debugOverlayVisible = false
export function toggleDebugOverlay(): void { debugOverlayVisible = !debugOverlayVisible }
export function isDebugOverlayVisible(): boolean { return debugOverlayVisible }

function drawSpawnPanel(): void {
  if (!spawnPanelVisible) { spawnPanelRects.length = 0; return }
  const panelX = 10
  const panelY = 10
  const boxW = 140
  const boxH = 28
  const gap = 3
  const cols = 2
  const colW = boxW + 8
  const maxRows = Math.ceil(height / (boxH + gap)) - 2  // fit screen height

  spawnPanelRects.length = 0

  const totalCols = Math.ceil(ENEMY_TYPES.length / maxRows)
  const panelW = colW * Math.min(totalCols, cols) + 4
  const panelH = (boxH + gap) * Math.min(ENEMY_TYPES.length, maxRows) + 8

  ctx.fillStyle = 'rgba(13, 10, 26, 0.85)'
  ctx.fillRect(panelX - 4, panelY - 4, panelW, panelH)

  ctx.font = '11px monospace'
  for (let i = 0; i < ENEMY_TYPES.length; i++) {
    const t = ENEMY_TYPES[i]!
    const col = Math.floor(i / maxRows)
    const row = i % maxRows
    const x = panelX + col * colW
    const y = panelY + row * (boxH + gap)

    if (col >= cols) continue  // don't draw beyond visible columns

    spawnPanelRects.push({ x, y, w: boxW, h: boxH, typeIndex: i })

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
    ctx.fillRect(x, y, boxW, boxH)

    ctx.fillStyle = t.color
    ctx.fillRect(x, y, 4, boxH)

    ctx.fillStyle = t.color
    ctx.globalAlpha = 0.8
    ctx.fillRect(x + 8, y + 5, 18, 18)
    ctx.globalAlpha = 1.0
    ctx.fillStyle = '#0D0A1A'
    ctx.font = 'bold 12px monospace'
    ctx.fillText(t.key, x + 13, y + 18)

    ctx.fillStyle = t.color
    ctx.font = '10px monospace'
    ctx.fillText(`${t.name}`, x + 30, y + 12)
    ctx.fillStyle = 'rgba(255,255,255,0.35)'
    ctx.font = '9px monospace'
    ctx.fillText(t.isShrine ? 'shrine' : t.role, x + 30, y + 23)
  }
}

function drawChallengePlacements(): void {
  if (getPhase() !== 'designer') return
  const placements = getPlacingEnemies()
  const selected = getSelectedPlacement()
  const hovered = getHoveredEnemyIdx()
  const hPulse = 0.5 + 0.5 * Math.sin(performance.now() / 220)
  for (let i = 0; i < placements.length; i++) {
    const e = placements[i]!
    const type = ENEMY_TYPES.find(t => t.name === e.typeName)
    const r = type?.radius ?? 40
    const sx = e.x - camX
    const sy = e.y - camY
    const isSelected = i === selected
    const isHovered = i === hovered
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

    // Hover delete preview — pulsing red overlay matching the wall hover treatment so the
    // user sees a uniform "right-click would delete this" affordance across both kinds of
    // placements. Drawn after the ghost so it sits on top.
    if (isHovered) {
      ctx.beginPath()
      ctx.arc(sx, sy, r + 8, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, 80, 80, ${0.28 + hPulse * 0.12})`
      ctx.fill()
      ctx.beginPath()
      ctx.arc(sx, sy, r + 2, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 100, 100, 0.95)`
      ctx.lineWidth = 2
      ctx.stroke()
    }

    // Name label
    ctx.font = '10px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = isSelected ? '#FFD740' : 'rgba(255,255,255,0.5)'
    ctx.fillText(e.typeName, sx, sy + r + 12)
    ctx.textAlign = 'left'
  }
}

function drawHUD(player: Player, enemies: Enemy[], fps: number): void {
  // Low HP red vignette — fades in below 30% health, intensifies toward death
  const hpRatio = player.hp / player.maxHp
  if (hpRatio < 0.3 && hpRatio > 0 && getPhase() === 'playing') {
    const urgency = 1 - (hpRatio / 0.3)  // 0 at 30%, 1 at 0%
    const beatPulse = globalBeatPulse * (0.5 + urgency * 0.5)  // syncs to beat, stronger near death
    const vigAlpha = urgency * (0.3 + beatPulse * 0.25)
    const vig = ctx.createRadialGradient(width / 2, height / 2, height * 0.15, width / 2, height / 2, height * 0.8)
    vig.addColorStop(0, 'rgba(0, 0, 0, 0)')
    vig.addColorStop(0.4, 'rgba(0, 0, 0, 0)')
    vig.addColorStop(0.65, `rgba(120, 15, 15, ${vigAlpha * 0.3})`)
    vig.addColorStop(0.85, `rgba(160, 20, 20, ${vigAlpha * 0.7})`)
    vig.addColorStop(1, `rgba(180, 20, 20, ${vigAlpha})`)
    ctx.fillStyle = vig
    ctx.fillRect(0, 0, width, height)
  }

  // Hit flash vignette — brief red flash on edges when taking HP damage (not shield break)
  if (player.hitFlash > 0 && player.shieldBreakFlash <= 0 && getPhase() === 'playing') {
    const hitT = Math.min(1, player.hitFlash / (HIT_FLASH_DURATION * 0.75))  // stretches the flash 25% longer
    const flashAlpha = hitT * 0.3
    const hitVig = ctx.createRadialGradient(width / 2, height / 2, height * 0.25, width / 2, height / 2, height * 0.8)
    hitVig.addColorStop(0, 'rgba(0, 0, 0, 0)')
    hitVig.addColorStop(0.55, 'rgba(0, 0, 0, 0)')
    hitVig.addColorStop(0.75, `rgba(200, 20, 20, ${flashAlpha * 0.4})`)
    hitVig.addColorStop(1, `rgba(255, 30, 30, ${flashAlpha})`)
    ctx.fillStyle = hitVig
    ctx.fillRect(0, 0, width, height)
  }

  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
  ctx.font = '12px monospace'
  const x = width - 200
  const pat = getPattern()
  const loopPos = getLoopPosition()
  const loopLen = getLoopLength()
  if (__DEV__) {
    // FPS always shown — small, top right
    ctx.font = '11px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
    ctx.fillText(`${fps} fps`, width - 50, 16)
    ctx.font = '12px monospace'
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
  }
  if (__DEV__ && debugOverlayVisible) {
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

  // Tutorial dash orb drawing helper
  function drawTutorialOrbs(lx: number, ly: number, rx: number, ry: number, a: number, p: Player): void {
    const orbR = 27
    const positions = [{ x: lx, y: ly }, { x: rx, y: ry }]

    for (let i = 0; i < 2; i++) {
      const pos = positions[i]!
      const slot = p.dashSlots[i] ?? 0
      const isReady = slot <= 0
      const rechargeTime = p.dashChargeTime * (p.modifiers?.dashChargeMult ?? 1) || 3

      if (isReady) {
        // Green ready orb — pulsing glow
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 400)
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, orbR + 6 + pulse * 3, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(100, 255, 120, ${(0.12 + pulse * 0.08) * a})`
        ctx.fill()

        ctx.beginPath()
        ctx.arc(pos.x, pos.y, orbR, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(100, 255, 120, ${0.85 * a})`
        ctx.fill()

        // White highlight
        ctx.beginPath()
        ctx.arc(pos.x - orbR * 0.25, pos.y - orbR * 0.25, orbR * 0.35, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255, 255, 255, ${0.3 * a})`
        ctx.fill()
      } else {
        // Recharging — white pie chart
        const progress = 1 - (slot / rechargeTime)

        // Dark bg circle
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, orbR, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(40, 40, 50, ${0.6 * a})`
        ctx.fill()
        ctx.strokeStyle = `rgba(100, 255, 120, ${0.25 * a})`
        ctx.lineWidth = 1.5
        ctx.stroke()

        // White pie showing progress
        if (progress > 0) {
          const startA = -Math.PI / 2
          const endA = startA + progress * Math.PI * 2
          ctx.beginPath()
          ctx.moveTo(pos.x, pos.y)
          ctx.arc(pos.x, pos.y, orbR - 2, startA, endA)
          ctx.closePath()
          ctx.fillStyle = `rgba(255, 255, 255, ${0.5 * a})`
          ctx.fill()
        }
      }

      // Border ring
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, orbR + 1, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(100, 255, 120, ${(isReady ? 0.6 : 0.2) * a})`
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }

  drawPortalButton()

  // Toast messages
  updateAndDrawToasts(frameDt)

  // Controls hint
  const dashTutorialActive = tutorialBeginner && (!(tutorialDashUsed[0] && tutorialDashUsed[1]) || tutorialDashFade > 0)
  if (controlsHintTimer > 0 || dashTutorialActive) {
    controlsHintTimer -= frameDt

    // Track dash slot transitions for tutorial
    if (tutorialBeginner && player.dashSlots.length >= 2) {
      for (let di = 0; di < 2; di++) {
        const slot = player.dashSlots[di] ?? 0
        if (slot > 0 && tutorialPrevSlots[di]! <= 0) {
          tutorialDashUsed[di] = true
        }
        tutorialPrevSlots[di] = slot
      }
    }

    const bothDashesUsed = tutorialBeginner && tutorialDashUsed[0] && tutorialDashUsed[1]

    // Start dash fade timer when both dashes used
    if (bothDashesUsed && tutorialDashFade === 0) {
      tutorialDashFade = CONTROLS_HINT_FADE
    }
    if (tutorialDashFade > 0) {
      tutorialDashFade -= frameDt
    }

    // Movement controls fade on normal timer
    const alpha = controlsHintTimer <= CONTROLS_HINT_FADE
      ? Math.max(0, controlsHintTimer / CONTROLS_HINT_FADE)
      : 1
    // Dash section: own smooth fade after both used, otherwise hold at full
    let dashAlpha: number
    if (!tutorialBeginner) {
      dashAlpha = alpha
    } else if (bothDashesUsed) {
      dashAlpha = Math.max(0, tutorialDashFade / CONTROLS_HINT_FADE)
    } else {
      dashAlpha = 1
    }
    ctx.save()
    const cx = width / 2
    const a = alpha

    if (isTouchMode()) {
      // Touch controls hint — animated joystick graphic + tap instruction
      const hintY = height * 0.82

      // Animated joystick — knob orbits in a circle to show movement
      const joyR = 45
      const animT = (performance.now() % 3000) / 3000  // 0→1 over 3 seconds
      const knobAngle = animT * Math.PI * 2
      const knobDist = joyR * 0.5
      const knobX = cx + Math.cos(knobAngle) * knobDist
      const knobY = hintY + Math.sin(knobAngle) * knobDist

      // Outer ring with tick marks
      ctx.beginPath()
      ctx.arc(cx, hintY, joyR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(0, 0, 0, ${(0.25 * a).toFixed(3)})`
      ctx.fill()
      ctx.strokeStyle = `rgba(0, 255, 255, ${(0.35 * a).toFixed(3)})`
      ctx.lineWidth = 2.5
      ctx.stroke()

      // Tick marks
      for (let i = 0; i < 8; i++) {
        const ta = (i / 8) * Math.PI * 2
        const isMajor = i % 2 === 0
        const inner = joyR - (isMajor ? 7 : 4)
        const outer = joyR + (isMajor ? 2 : 1)
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(ta) * inner, hintY + Math.sin(ta) * inner)
        ctx.lineTo(cx + Math.cos(ta) * outer, hintY + Math.sin(ta) * outer)
        ctx.strokeStyle = `rgba(0, 255, 255, ${((isMajor ? 0.3 : 0.15) * a).toFixed(3)})`
        ctx.lineWidth = isMajor ? 2 : 1
        ctx.stroke()
      }

      // Direction beam
      const beamGrad = ctx.createLinearGradient(cx, hintY, knobX, knobY)
      beamGrad.addColorStop(0, `rgba(255, 50, 200, 0)`)
      beamGrad.addColorStop(1, `rgba(255, 50, 200, ${(0.25 * a).toFixed(3)})`)
      ctx.beginPath()
      ctx.moveTo(cx, hintY)
      ctx.lineTo(knobX, knobY)
      ctx.strokeStyle = beamGrad
      ctx.lineWidth = 6
      ctx.lineCap = 'round'
      ctx.stroke()
      ctx.lineCap = 'butt'

      // Animated knob
      const knobR = 16
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.4 * a).toFixed(3)})`
      ctx.fill()
      ctx.strokeStyle = `rgba(0, 255, 255, ${(0.6 * a).toFixed(3)})`
      ctx.lineWidth = 2
      ctx.stroke()

      // Direction arrow on outer edge
      const arrowDist = joyR + 10
      const arrowTipX = cx + Math.cos(knobAngle) * (arrowDist + 8)
      const arrowTipY = hintY + Math.sin(knobAngle) * (arrowDist + 8)
      const arrowSize = 6
      const arrowL = knobAngle + Math.PI * 0.75
      const arrowR2 = knobAngle - Math.PI * 0.75
      ctx.beginPath()
      ctx.moveTo(arrowTipX, arrowTipY)
      ctx.lineTo(arrowTipX + Math.cos(arrowL) * arrowSize, arrowTipY + Math.sin(arrowL) * arrowSize)
      ctx.lineTo(arrowTipX + Math.cos(arrowR2) * arrowSize, arrowTipY + Math.sin(arrowR2) * arrowSize)
      ctx.closePath()
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.5 * a).toFixed(3)})`
      ctx.fill()

      // "DRAG TO MOVE" label
      ctx.font = 'bold 34px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.7 * a).toFixed(3)})`
      ctx.fillText('DRAG TO MOVE', cx, hintY + joyR + 38)

      // "TAP = DASH" label
      ctx.font = 'bold 34px monospace'
      ctx.fillStyle = `rgba(255, 50, 200, ${(0.7 * dashAlpha).toFixed(3)})`
      const tapDashY = hintY + joyR + 72
      ctx.fillText('TAP = DASH', cx, tapDashY)

      // Tutorial dash orbs — flanking the text
      if (tutorialBeginner) {
        drawTutorialOrbs(cx - 140, tapDashY, cx + 140, tapDashY, dashAlpha, player)
      }
    } else {
      // Keyboard controls hint — arrow keys + spacebar
      const keySize = 48
      const gap = 5
      const baseY = height * 0.82
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
      const da = dashAlpha
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.1 * da).toFixed(3)})`
      ctx.beginPath()
      ctx.roundRect(spaceX, spaceY, spaceW, spaceH, 6)
      ctx.fill()
      ctx.strokeStyle = `rgba(0, 255, 255, ${(0.45 * da).toFixed(3)})`
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(spaceX, spaceY, spaceW, spaceH, 6)
      ctx.stroke()
      ctx.font = 'bold 24px monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = `rgba(0, 255, 255, ${(0.7 * da).toFixed(3)})`
      ctx.fillText('SPACE = DASH', cx, spaceY + spaceH / 2)

      // Tutorial dash orbs — flanking the spacebar
      if (tutorialBeginner) {
        const orbY = spaceY + spaceH / 2
        drawTutorialOrbs(spaceX - 35, orbY, spaceX + spaceW + 35, orbY, da, player)
      }
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
      const visibleHeight = height - listStartY - 160
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
      ctx.rect(0, listStartY - 22, width, visibleHeight + 22)
      ctx.clip()

      for (let i = 0; i < topScores.length; i++) {
        const s = topScores[i]!
        const rowY = listStartY + i * rowH - victoryScroll
        if (rowY < listStartY - rowH || rowY > listStartY + visibleHeight) continue
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

    // Celebration fireworks
    {
      for (let side = 0; side < 2; side++) {
        if (Math.random() < 0.12) {
          const sx = side === 0 ? width * 0.15 + Math.random() * width * 0.1 : width * 0.75 + Math.random() * width * 0.1
          const sy = height * (0.25 + Math.random() * 0.4)
          const colorSet = [[255, 215, 64], [0, 255, 255], [255, 50, 200], [100, 255, 160], [255, 160, 80], [120, 220, 255]]
          const baseColor = colorSet[Math.floor(Math.random() * colorSet.length)]!
          for (let p = 0; p < 18; p++) {
            const angle = Math.random() * Math.PI * 2
            const speed = 100 + Math.random() * 180
            nameFireworks.push({ x: sx, y: sy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 40,
              r: Math.min(255, baseColor[0]! + Math.floor((Math.random() - 0.5) * 50)),
              g: Math.min(255, baseColor[1]! + Math.floor((Math.random() - 0.5) * 50)),
              b: Math.min(255, baseColor[2]! + Math.floor((Math.random() - 0.5) * 50)),
              life: 0, maxLife: 0.6 + Math.random() * 0.5, size: 5 + Math.random() * 5 })
          }
          for (let p = 0; p < 5; p++) {
            const angle = Math.random() * Math.PI * 2
            const speed = 60 + Math.random() * 100
            nameFireworks.push({ x: sx, y: sy, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 30,
              r: 255, g: 255, b: 255, life: 0, maxLife: 0.3 + Math.random() * 0.2, size: 3 + Math.random() * 3 })
          }
        }
      }
    }
    // Draw fireworks on victory screen
    ctx.globalAlpha = 1
    for (let fi = nameFireworks.length - 1; fi >= 0; fi--) {
      const fw = nameFireworks[fi]!
      fw.life += lastDt
      if (fw.life >= fw.maxLife) { nameFireworks.splice(fi, 1); continue }
      fw.x += fw.vx * lastDt
      fw.y += fw.vy * lastDt
      fw.vx *= 0.98
      fw.vy *= 0.98
      const ft = 1 - fw.life / fw.maxLife
      const sz = fw.size * (0.5 + ft * 0.5)
      ctx.beginPath()
      ctx.arc(fw.x, fw.y, sz, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${fw.r}, ${fw.g}, ${fw.b}, ${ft * 0.9})`
      ctx.fill()
    }

    // Buttons at bottom
    const vBtnW = 270
    const vBtnH = 66
    const vBtnGap = 20
    const vBtnY = height - 130
    const retryX = vcx - vBtnW - vBtnGap / 2
    const menuX = vcx + vBtnGap / 2

    // Try Again
    const vRetryHov = checkHover('v_retry', pauseMouseX >= retryX && pauseMouseX <= retryX + vBtnW && pauseMouseY >= vBtnY && pauseMouseY <= vBtnY + vBtnH)
    ctx.beginPath()
    ctx.roundRect(retryX, vBtnY, vBtnW, vBtnH, 8)
    ctx.strokeStyle = `rgba(0, 255, 255, ${vRetryHov ? 0.8 : 0.5})`
    ctx.lineWidth = vRetryHov ? 3 : 2
    ctx.stroke()
    ctx.fillStyle = `rgba(0, 255, 255, ${vRetryHov ? 0.2 : 0.08})`
    ctx.fill()
    ctx.font = 'bold 26px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = `rgba(0, 255, 255, ${vRetryHov ? 1 : 0.8})`
    ctx.fillText('TRY AGAIN', retryX + vBtnW / 2, vBtnY + vBtnH / 2 + 8)

    // Menu
    const vMenuHov = checkHover('v_menu', pauseMouseX >= menuX && pauseMouseX <= menuX + vBtnW && pauseMouseY >= vBtnY && pauseMouseY <= vBtnY + vBtnH)
    ctx.beginPath()
    ctx.roundRect(menuX, vBtnY, vBtnW, vBtnH, 8)
    ctx.strokeStyle = `rgba(255, 255, 255, ${vMenuHov ? 0.6 : 0.3})`
    ctx.lineWidth = vMenuHov ? 3 : 2
    ctx.stroke()
    ctx.fillStyle = `rgba(255, 255, 255, ${vMenuHov ? 0.15 : 0.05})`
    ctx.fill()
    ctx.font = 'bold 24px monospace'
    ctx.fillStyle = `rgba(255, 255, 255, ${vMenuHov ? 0.9 : 0.6})`
    ctx.fillText('MENU', menuX + vBtnW / 2, vBtnY + vBtnH / 2 + 8)

    // Next Challenge arrow — right side, if there's a next challenge
    const challenges = getChallenges()
    const curIdx = challenges.findIndex(c => c.name === ch?.name)
    if (curIdx >= 0 && curIdx < challenges.length - 1) {
      const nextCh = challenges[curIdx + 1]!
      const arrowX = width - 300
      const arrowCY = height / 2 + 115
      const nextHov = checkHover('v_next', pauseMouseX >= arrowX - 30 && pauseMouseX <= arrowX + 120 && pauseMouseY >= arrowCY - 100 && pauseMouseY <= arrowCY + 130)
      // Beat pulse
      const nLoopPos = getLoopPosition()
      const nBeatPhase = nLoopPos % 1
      const nPastPeak = nBeatPhase >= 0.45
      const nBeatId = Math.floor(nLoopPos) * 2 + (nPastPeak ? 1 : 0)
      if (nBeatId !== titleLastBeat && titleLastBeat >= 0 && nPastPeak) titleBeatPulse = 1
      titleLastBeat = nBeatId
      titleBeatPulse = Math.max(0, titleBeatPulse - lastDt * 3)
      const beat = titleBeatPulse

      // Box around everything
      const boxW = 180
      const boxX = arrowX - 50
      const boxY = arrowCY - 75
      const boxH = 210
      ctx.beginPath()
      ctx.roundRect(boxX, boxY, boxW, boxH, 12)
      ctx.strokeStyle = nextHov ? `rgba(255, 50, 200, ${nextHov ? 0.7 : 0.3 + beat * 0.2})` : `rgba(0, 255, 255, ${0.25 + beat * 0.15})`
      ctx.lineWidth = nextHov ? 2.5 : 1.5
      ctx.stroke()
      // Dark backing to block noise
      ctx.fillStyle = `rgba(13, 10, 26, 0.7)`
      ctx.fill()
      // Tinted overlay
      ctx.fillStyle = nextHov ? `rgba(255, 50, 200, 0.1)` : `rgba(0, 255, 255, ${0.04 + beat * 0.03})`
      ctx.fill()

      // Arrow chevrons — big
      const chevCount = 3
      for (let c = 0; c < chevCount; c++) {
        const offset = (c - 1) * 36
        const chevAlpha = nextHov ? 0.95 : 0.5 + beat * 0.3
        ctx.beginPath()
        ctx.moveTo(arrowX + offset + 20, arrowCY - 60)
        ctx.lineTo(arrowX + offset + 60, arrowCY)
        ctx.lineTo(arrowX + offset + 20, arrowCY + 60)
        ctx.strokeStyle = nextHov ? `rgba(255, 50, 200, ${chevAlpha})` : `rgba(0, 255, 255, ${chevAlpha})`
        ctx.lineWidth = (nextHov ? 8 : 6) + beat * 3
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.stroke()
      }
      ctx.lineCap = 'butt'
      ctx.lineJoin = 'miter'

      // Label
      ctx.font = 'bold 34px monospace'
      ctx.textAlign = 'center'
      ctx.fillStyle = nextHov ? `rgba(255, 50, 200, 0.95)` : `rgba(0, 255, 255, ${0.6 + beat * 0.3})`
      ctx.fillText('NEXT', arrowX + 40, arrowCY + 85)
      ctx.fillText('CHALLENGE', arrowX + 40, arrowCY + 120)
    }

    ctx.textAlign = 'left'
  }

  // Name entry screen
  if (getPhase() === 'entering_name') {
    if (!nameEntryStarted) {
      nameEntryStarted = true
    }

    particles.length = 0  // kill all game particles

    ctx.fillStyle = COLOR_BG
    ctx.fillRect(0, 0, width, height)

    const ncx = width / 2
    const compact = height < 500  // only phones in landscape

    const time = getRunFinalTime()
    const timeStr = formatTime(time)

    // Compute projected rank
    const ch = getActiveChallenge()
    const projectedScores = ch ? getScoresForChallenge(ch.name, 100) : []
    const roundedTime = Math.ceil(time)
    let projectedRank = projectedScores.length + 1
    for (let i = 0; i < projectedScores.length; i++) {
      if (roundedTime < projectedScores[i]!.time) { projectedRank = i + 1; break }
    }
    while (projectedRank <= projectedScores.length && projectedScores[projectedRank - 1]!.time === roundedTime) {
      projectedRank++
    }
    lastProjectedRank = projectedRank

    if (compact) {
      // ── Compact layout for mobile — fits above keyboard ──
      let cy = 40

      ctx.textAlign = 'center'
      ctx.font = 'bold 36px monospace'
      ctx.fillStyle = 'rgba(100, 255, 160, 0.95)'
      ctx.fillText('VICTORY', ncx, cy)
      cy += 40

      ctx.font = 'bold 28px monospace'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.fillText(timeStr, ncx, cy)
      cy += 40

      ctx.font = '18px monospace'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
      ctx.fillText('Enter your name:', ncx, cy)
      cy += 20

      // Name input box
      const boxW = 360
      const boxH = 48
      const boxX = ncx - boxW / 2
      const boxY = cy
      ctx.beginPath()
      ctx.roundRect(boxX, boxY, boxW, boxH, 6)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.font = 'bold 26px monospace'
      ctx.fillStyle = 'rgba(0, 255, 255, 0.9)'
      const cursor = Math.floor(performance.now() / 500) % 2 === 0 ? '|' : ''
      ctx.fillText(nameEntryText + cursor, ncx, boxY + boxH / 2 + 8)
      cy += boxH + 12

      // Submit button
      const subW = 160
      const subH = 42
      const subX = ncx - subW / 2
      const subY = cy
      const subHov = pauseMouseX >= subX && pauseMouseX <= subX + subW && pauseMouseY >= subY && pauseMouseY <= subY + subH
      ctx.beginPath()
      ctx.roundRect(subX, subY, subW, subH, 8)
      ctx.strokeStyle = `rgba(100, 255, 160, ${subHov ? 0.8 : 0.5})`
      ctx.lineWidth = subHov ? 2.5 : 1.5
      ctx.stroke()
      ctx.fillStyle = `rgba(100, 255, 160, ${subHov ? 0.2 : 0.08})`
      ctx.fill()
      ctx.font = 'bold 20px monospace'
      ctx.fillStyle = `rgba(100, 255, 160, ${subHov ? 1 : 0.8})`
      ctx.fillText('S U B M I T', ncx, subY + subH / 2 + 6)
    } else {
      // ── Full desktop layout ──
      const ncy = height * 0.2

      ctx.textAlign = 'center'
      ctx.font = 'bold 64px monospace'
      ctx.fillStyle = 'rgba(100, 255, 160, 0.95)'
      ctx.fillText('VICTORY', ncx, ncy)

      ctx.font = 'bold 56px monospace'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.fillText(timeStr, ncx, ncy + 70)

      const pRankColors = ['rgba(255, 215, 64, 0.95)', 'rgba(120, 220, 255, 0.9)', 'rgba(255, 160, 80, 0.9)']
      const pRankColor = projectedRank <= 3 ? pRankColors[projectedRank - 1]! : 'rgba(0, 255, 255, 0.8)'
      ctx.font = 'bold 40px monospace'
      ctx.fillStyle = pRankColor
      ctx.fillText(`RANK #${projectedRank}`, ncx, ncy + 130)

      ctx.font = '24px monospace'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.5)'
      ctx.fillText('Enter your name:', ncx, ncy + 185)

      const boxW = 400
      const boxH = 60
      const boxX = ncx - boxW / 2
      const boxY = ncy + 200
      ctx.beginPath()
      ctx.roundRect(boxX, boxY, boxW, boxH, 6)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)'
      ctx.lineWidth = 2
      ctx.stroke()

      ctx.font = 'bold 34px monospace'
      ctx.fillStyle = 'rgba(0, 255, 255, 0.9)'
      const cursor = Math.floor(performance.now() / 500) % 2 === 0 ? '|' : ''
      ctx.fillText(nameEntryText + cursor, ncx, boxY + boxH / 2 + 10)

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
        '1': ['You are the fastest. For now.', 'Nobody\'s touching this.', 'The top. Where you belong.', 'They\'ll all be chasing your ghost.', 'Screenshot this before someone takes it.', 'Crown fits nice, doesn\'t it?'],
        '2': ['So close. The throne is right there.', 'Second place. First loser.', 'One run away from glory.', 'You can taste first place from here.', 'The gap is smaller than you think.', 'Almost had it. Almost.'],
        '3': ['Podium. Not bad.', 'Bronze hits different when you earned it.', 'Third. Two people were faster. For now.', 'Close enough to smell the gold.', 'Top 3 is top 3.', 'The podium accepts you.'],
        '4-10': ['Top 10. Respect.', 'The leaderboard notices you.', 'Dangerous territory. Keep going.', 'You belong up here.', 'The top 3 should be worried.', 'One good run from the podium.', 'You\'re warming up, aren\'t you?'],
        '11-25': ['Solid. Keep pushing.', 'Getting warm.', 'Not bad. Not great. Not done.', 'You can see the top from here.', 'The board respects a grinder.', 'Halfway to something special.', 'Your fingers know the way. Trust them.'],
        '26-50': ['You know you\'re better than this.', 'Average. Prove me wrong.', 'Middle of the pack. For now.', 'Decent run. Forgettable, but decent.', 'The leaderboard has seen worse.', 'One of many. Be one of few.', 'Your rival just beat this time. Probably.'],
        '51-75': ['Hey, you finished.', 'It\'s a start. A slow start.', 'At least you\'re on the board.', 'Technically a score.', 'The game felt that one.', 'There\'s levels to this. You found the bottom ones.', 'You looked cool doing it though. Maybe.'],
        '76-90': ['Well... you tried.', 'Participation trophy unlocked.', 'Your keyboard works, at least.', 'Did you play with your eyes closed?', 'The enemies felt bad for you.', 'Bold of you to submit this.', 'Somewhere, a speedrunner just cringed.'],
        '91-100': ['Made the board. Barely.', 'Scraping the bottom here.', 'Nowhere to go but up.', 'Rock bottom has a nice view.', 'You\'re basically the tutorial.', 'At least 101st place isn\'t a thing.', 'This is your villain origin story.'],
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
      const msgIdx = Math.floor((time * 7 + projectedRank * 13) % msgs.length)
      const commentY = subY + subH + 30
      ctx.font = 'bold 22px monospace'
      ctx.fillStyle = projectedRank <= 3 ? 'rgba(255, 215, 64, 0.9)' : projectedRank <= 10 ? 'rgba(0, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.6)'
      ctx.fillText(msgs[msgIdx]!, ncx, commentY)

      ctx.font = '16px monospace'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.25)'
      ctx.fillText('Press Enter to confirm', ncx, commentY + 30)
    }

    // Fireworks — celebrate!
    {
      for (let side = 0; side < 2; side++) {
        if (Math.random() < 0.12) {
          const sx = side === 0 ? width * 0.12 + Math.random() * width * 0.15 : width * 0.73 + Math.random() * width * 0.15
          const sy = height * (0.1 + Math.random() * 0.6)
          const colorSet = [[255, 215, 64], [0, 255, 255], [255, 50, 200], [100, 255, 160], [255, 160, 80], [120, 220, 255]]
          const baseColor = colorSet[Math.floor(Math.random() * colorSet.length)]!
          for (let p = 0; p < 18; p++) {
            const a = Math.random() * Math.PI * 2
            const spd = 100 + Math.random() * 180
            nameFireworks.push({ x: sx, y: sy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 40,
              r: Math.min(255, baseColor[0]! + Math.floor((Math.random() - 0.5) * 50)),
              g: Math.min(255, baseColor[1]! + Math.floor((Math.random() - 0.5) * 50)),
              b: Math.min(255, baseColor[2]! + Math.floor((Math.random() - 0.5) * 50)),
              life: 0, maxLife: 0.6 + Math.random() * 0.5, size: 5 + Math.random() * 5 })
          }
          for (let p = 0; p < 5; p++) {
            const a = Math.random() * Math.PI * 2
            const spd = 60 + Math.random() * 100
            nameFireworks.push({ x: sx, y: sy, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd - 30,
              r: 255, g: 255, b: 255, life: 0, maxLife: 0.3 + Math.random() * 0.2, size: 3 + Math.random() * 3 })
          }
        }
      }
    }
    // Update + draw fireworks in screen space
    ctx.globalAlpha = 1
    for (let fi = nameFireworks.length - 1; fi >= 0; fi--) {
      const fw = nameFireworks[fi]!
      fw.life += lastDt
      if (fw.life >= fw.maxLife) { nameFireworks.splice(fi, 1); continue }
      fw.x += fw.vx * lastDt
      fw.y += fw.vy * lastDt
      fw.vx *= 0.98
      fw.vy *= 0.98
      const ft = 1 - fw.life / fw.maxLife
      const sz = fw.size * (0.5 + ft * 0.5)
      ctx.beginPath()
      ctx.arc(fw.x, fw.y, sz, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${fw.r}, ${fw.g}, ${fw.b}, ${ft * 0.9})`
      ctx.fill()
    }

    ctx.textAlign = 'left'
  }

  // Pause screen
  if (getPhase() === 'paused') {
    // Track pause entry for animation
    if (!wasPaused) {
      pauseAnimTimer = 0
      wasPaused = true
    }
    pauseAnimTimer += frameDt
    const animDur = 0.2
    const animT = Math.min(pauseAnimTimer / animDur, 1)

    // Scale pop — overshoot bounce
    const scale = animT < 0.7
      ? 0.8 + (animT / 0.7) * 0.25  // 0.8 → 1.05
      : 1.05 - ((animT - 0.7) / 0.3) * 0.05  // 1.05 → 1.0

    // Dim overlay — fades in
    ctx.fillStyle = `rgba(0, 0, 0, ${0.45 * Math.min(animT * 3, 1)})`
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

    // Apply scale transform from panel center
    const panelCx = pcx
    const panelCy = panelY + panelContentH / 2
    ctx.save()
    ctx.translate(panelCx, panelCy)
    ctx.scale(scale, scale)
    ctx.translate(-panelCx, -panelCy)

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

    // Draw button helper — cascading fade-in
    let btnIdx = 0
    const drawPauseBtn = (y: number, label: string, r: number, g: number, b: number) => {
      const btnDelay = 0.03 * btnIdx  // 30ms stagger per button
      const btnT = Math.max(0, Math.min((pauseAnimTimer - 0.08 - btnDelay) / 0.12, 1))
      btnIdx++
      if (btnT <= 0) return
      const hov = checkHover(`pause_${label}`, isHovered(y))
      const hovBoost = hov ? 0.15 : 0
      ctx.globalAlpha = btnT
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
    ctx.globalAlpha = 1

    // Volume slider
    const pauseVolW = 200
    const pauseVolRect = drawVolumeSlider(pcx - pauseVolW / 2, fsBtnY + btnH + 24, pauseVolW)
    volumeSliderRect = pauseVolRect

    ctx.textAlign = 'left'
    ctx.restore()  // undo scale transform
  } else {
    wasPaused = false
  }

  // Death screen
  if (getPhase() === 'dead') {
    // Beat pulse for death screen
    const dLoopPos = getLoopPosition()
    const dBeatPhase = dLoopPos % 1
    const dPeakPoint = 0.45
    const dCurrentBeat = Math.floor(dLoopPos)
    const dPastPeak = dBeatPhase >= dPeakPoint
    const dBeatId = dCurrentBeat * 2 + (dPastPeak ? 1 : 0)
    if (dBeatId !== titleLastBeat && titleLastBeat >= 0 && dPastPeak) {
      titleBeatPulse = 1
    }
    titleLastBeat = dBeatId
    titleBeatPulse = Math.max(0, titleBeatPulse - frameDt * 3)
    const deadBeat = titleBeatPulse

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
    ctx.fillText('YOU DIED', dcx, 60)

    ctx.font = 'bold 42px monospace'
    ctx.fillStyle = 'rgba(255, 100, 100, 0.95)'
    ctx.fillText(timeStr, dcx, 110)

    // Leaderboard
    const ch = getActiveChallenge()
    if (ch) {
      const topScores = getScoresForChallenge(ch.name, 5)
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

    // Pro tip — between leaderboard and buttons
    {
      const tipY = height - 238
      const arrowSize = 43
      const headingY = tipY - 22

      // "PRO TIP:" heading
      ctx.font = 'bold 28px monospace'
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(255, 215, 64, 0.85)'
      ctx.fillText(`PRO TIP #${proTipIndex + 1}`, dcx, headingY)

      // Arrows flanking the heading
      const headingHalfW = 110  // approx half width of "PRO TIP #X" text
      const leftArrowX = dcx - headingHalfW - arrowSize - 8
      const rightArrowX = dcx + headingHalfW + 8

      const arrowFlash = 0.55 + deadBeat * 0.45

      if (proTipIndex > 0) {
        const lHov = checkHover('tip_l', pauseMouseX >= leftArrowX && pauseMouseX <= leftArrowX + arrowSize && pauseMouseY >= headingY - 18 && pauseMouseY <= headingY + 10)
        ctx.font = `bold ${arrowSize}px monospace`
        ctx.textAlign = 'center'
        ctx.fillStyle = `rgba(255, 50, 200, ${lHov ? 1 : arrowFlash})`
        ctx.fillText('\u25C0', leftArrowX + arrowSize / 2, headingY)
      }

      if (proTipIndex < PRO_TIPS.length - 1) {
        const rHov = checkHover('tip_r', pauseMouseX >= rightArrowX && pauseMouseX <= rightArrowX + arrowSize && pauseMouseY >= headingY - 18 && pauseMouseY <= headingY + 10)
        ctx.font = `bold ${arrowSize}px monospace`
        ctx.textAlign = 'center'
        ctx.fillStyle = `rgba(255, 50, 200, ${rHov ? 1 : arrowFlash})`
        ctx.fillText('\u25B6', rightArrowX + arrowSize / 2, headingY)
      }
      ctx.font = '26px monospace'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'
      ctx.fillText(PRO_TIPS[proTipIndex]!, dcx, tipY + 12)
    }

    // Buttons at bottom
    const btnW = 220
    const btnH = 52
    const btnGap = 16
    const btnBaseY = height - 190
    const retryX = dcx - btnW - btnGap / 2
    const menuX = dcx + btnGap / 2

    const dRetryHov = checkHover('d_retry', pauseMouseX >= retryX && pauseMouseX <= retryX + btnW && pauseMouseY >= btnBaseY && pauseMouseY <= btnBaseY + btnH)
    ctx.beginPath()
    ctx.roundRect(retryX, btnBaseY, btnW, btnH, 8)
    ctx.strokeStyle = `rgba(0, 255, 255, ${dRetryHov ? 0.9 : 0.5 + deadBeat * 0.4})`
    ctx.lineWidth = 2 + deadBeat * 1.5 + (dRetryHov ? 1 : 0)
    ctx.stroke()
    ctx.fillStyle = `rgba(0, 255, 255, ${dRetryHov ? 0.2 : 0.04 + deadBeat * 0.08})`
    ctx.fill()
    ctx.font = 'bold 22px monospace'
    ctx.textAlign = 'center'
    ctx.fillStyle = `rgba(0, 255, 255, ${dRetryHov ? 1 : 0.6 + deadBeat * 0.35})`
    ctx.fillText('TRY AGAIN', retryX + btnW / 2, btnBaseY + btnH / 2 + 8)

    const dMenuHov = checkHover('d_menu', pauseMouseX >= menuX && pauseMouseX <= menuX + btnW && pauseMouseY >= btnBaseY && pauseMouseY <= btnBaseY + btnH)
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
    ctx.fillStyle = `rgba(255, 80, 80, ${0.9 * a})`
    ctx.fillText('FULLSCREEN UNAVAILABLE', cx, ly)
    ly += 40

    ctx.font = '20px monospace'
    ctx.fillStyle = `rgba(255, 255, 255, ${0.7 * a})`
    ctx.fillText('Sorry, iPhones do not support', cx, ly)
    ly += 30
    ctx.fillText('fullscreen for web games.', cx, ly)
    ly += 30
    ctx.fillText('Play on desktop for the best experience!', cx, ly)
    ly += 36

    ctx.font = '12px monospace'
    ctx.fillStyle = `rgba(255, 255, 255, ${0.35 * a})`
    ctx.fillText('tap anywhere to dismiss', cx, ly)

    ctx.restore()
  }
  finalizeHoverCheck()
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

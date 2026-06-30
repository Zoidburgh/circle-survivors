import type { Player } from '../entities/Player.ts'
import { getEffectiveRadius, getBodyRadius, SPEED_BOOST_DURATION } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { getRingOrigins, nodeWorldPos, nodeRadius, nodeDepth } from '../entities/Enemy.ts'
import type { Ring } from '../entities/Ring.ts'
import { getRingExpansion, getRingAlpha, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { ENEMY_TYPES, getEnemyType } from '../entities/EnemyTypes.ts'
import type { TetherTopology } from '../entities/EnemyTypes.ts'
import { complementColor, staccatoProgress, STACCATO_LEAD } from '../utils/math.ts'
import { getPattern, getLoopPosition, getLoopLength, getAbsoluteBeats } from '../audio/PatternClock.ts'
import { getPreviewEnemy } from '../game/EnemyDesigner.ts'
import type { Camera, Wall } from '../game/Arena.ts'
import { ARENA_W, ARENA_H, ARENA_RADIUS, ARENA_CX, ARENA_CY, PILL_R, PILL_HALF_W, CROSS_HW, CROSS_HE, getArenaShape, getHexVertices, getPolygonVertices, getPolygonSides, getCrossVertices, getWalls, computeWallArc, resetWallsToRest, getWallSnapPoints, WALL_DEATH_DURATION_MS } from '../game/Arena.ts'
import { getBlockedArcs } from '../game/RingOcclusion.ts'
import { getRitualGroups, getActiveIndex } from '../game/RitualNodes.ts'
import { isPlaceMode, getPlacingEnemies, getSelectedPlacement, getChallenges, getActiveChallenge, getWallDrag, getWallThickness, getPlaceTool, getHoveredWallIdx, getHoveredEnemyIdx, getSelectedWallIdx, getEndpointDrag, getWallCurveHandle, getPlacingPrefab, getPrefabCursor, getPrefabRotation, getSelectedWallPivotWorld, isPivotSetMode } from '../game/ChallengeBuilder.ts'
import { getBestTime, getScoresForChallenge, formatTime, hasOnlineScores } from '../game/HighScores.ts'
import type { Challenge } from '../game/ChallengeBuilder.ts'
import type { BlockedArc } from '../game/RingOcclusion.ts'
import { getEnemies, getRunTimer, isRunTimerActive, isRunComplete, getRunFinalTime, getPhase, getRunBeatCount } from '../core/GameState.ts'
import { hasBonus } from '../game/UpgradeManager.ts'
import { getOrbs } from '../entities/XPOrb.ts'
import { getBeatName, getVolume, playDashReady, playIrisOpen, playUIHover, playUIClick, playSpeedBoost } from '../audio/AudioEngine.ts'
import { isTouchMode, getJoystickState } from '../game/InputManager.ts'
import { BEAT_SEC } from '../utils/constants.ts'
import {
  GRID_ALPHA,
  GRID_CELL_PX,
  COLOR_PLAYER,
  PLAYER_RADIUS,
  MAX_RING_RADIUS,
  PARTICLE_CAP,
  BEAT_DASH_RADIUS_MULT,
  PARTICLE_LOD_SOFT,
  PARTICLE_LOD_HARD,
  PARTICLE_LOD_FLOOR,
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

// Player-facing camera zoom — independent of designer zoom. Applied during normal play
// (not when designer is zoomed out, which overrides). Range 0.5..1.2 — below 0.5 the world
// is too small to read, above 1.2 the view is too tight. Persisted in localStorage so the
// setting carries across runs.
const CAMERA_ZOOM_MIN = 0.5
const CAMERA_ZOOM_MAX = 1.2
const CAMERA_ZOOM_DEFAULT = 0.85   // slightly wider than the historical 1.0 default
let cameraZoom = (() => {
  const saved = parseFloat(localStorage.getItem('beatback_camera_zoom') ?? '')
  if (Number.isFinite(saved) && saved >= CAMERA_ZOOM_MIN && saved <= CAMERA_ZOOM_MAX) return saved
  return CAMERA_ZOOM_DEFAULT
})()
export function getCameraZoom(): number { return cameraZoom }
export function setCameraZoom(z: number): void {
  const clamped = Math.max(CAMERA_ZOOM_MIN, Math.min(CAMERA_ZOOM_MAX, z))
  cameraZoom = clamped
  localStorage.setItem('beatback_camera_zoom', clamped.toFixed(3))
}
export function getCameraZoomRange(): { min: number; max: number; def: number } {
  return { min: CAMERA_ZOOM_MIN, max: CAMERA_ZOOM_MAX, def: CAMERA_ZOOM_DEFAULT }
}
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
interface ParticleParent { x: number; y: number; rot?: number }
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
  // Orbit-on-ring mode — used by the ring's at-peak "cutting" streak particles to follow the
  // ring's curve instead of departing on a straight tangent. orbitR < 0 disables (default).
  // When > 0, updateParticles projects (x,y) back onto the circle and reorients velocity to
  // the tangent at the new position, preserving speed and direction.
  orbitCx: number
  orbitCy: number
  orbitR: number
  // Parent attachment — particle's position is shifted each frame by (parent.x - lastParentX)
  // so the burst stays visually glued to the moving entity (player/enemy hit particles).
  // Null disables (default). lastParentX/Y track the last seen parent position per-particle so
  // the delta works correctly regardless of update order or stale parent references.
  parent: ParticleParent | null
  lastParentX: number
  lastParentY: number
  lastParentRot: number   // last seen parent rotation (rad); offset+velocity rotate by its per-frame delta
  // tintLate — when true, the tint color shift happens in the LAST ~30% of life instead of
  // mid-life. Used for blood drops so they keep their hot starting color most of their flight
  // and only cool down right before dissolving.
  tintLate: boolean
  // belowEnemies — render in a pass BEFORE enemy bodies (under them), instead of the normal
  // 'below' pass which runs after enemy bodies. Used by enemy heal sparkles so they emanate from
  // UNDER the body, exactly like the player heal burst (the player draws after its 'below' pass).
  belowEnemies: boolean
}

// Particle POOL — fixed-size, pre-allocated ONCE. Active particles occupy indices [0, particleCount);
// "removing" one swaps it to the tail + decrements the count, and spawning reuses that slot's object
// (overwriting every field). Zero per-particle allocation/free, so heavy bursts (hundreds of bullet
// trails + detonation sparks cycling per second) no longer churn the GC — which was stalling frames
// during pushes in a way the section timers couldn't even see.
const MAX_PARTICLES = PARTICLE_CAP
function makeBlankParticle(): Particle {
  return { x: 0, y: 0, vx: 0, vy: 0, r: 0, g: 0, b: 0, life: 0, lifetime: 1, size: 1, spinRate: 0,
    tintR: -1, tintG: 0, tintB: 0, orbitCx: 0, orbitCy: 0, orbitR: -1,
    parent: null, lastParentX: 0, lastParentY: 0, lastParentRot: 0, tintLate: false, belowEnemies: false }
}
const particles: Particle[] = Array.from({ length: MAX_PARTICLES }, makeBlankParticle)
let particleCount = 0   // # of live particles, packed at the front of `particles`
let frameTick = 0       // increments once per render frame — used for frame-by-frame strobe effects
// ── Render diagnostics (dev-only) — per-frame tallies to SEE why ring shards go missing in the
// finale: how many shards a ring asks for vs how many the full pool drops, the pool level at the
// moment a ring peaks, and tether-slash drops. Reset at render start, emitted to the overlay's
// counts panel before perfFlush. Answers "throttling or logic?" directly.
let dbgRingReq = 0      // ring-circumference shards requested this frame (all rings)
let dbgRingDrop = 0     // ...of those, dropped because the pool was full
let dbgPoolAtPeak = 0   // particleCount the instant a ring hit its shard-spawn (last ring wins)
let dbgSlashDrop = 0    // tether slash shards dropped because the pool was full
let lastDt = 0.016
let borderWaveIntensity = 0
// Spike-on-trigger from triggerBeatDashConfirm to make the arena border pulse + waveform
// punch through the warm-gold beat-dash flash that would otherwise drown them out. Decays
// each frame in drawArenaBorder so it lasts ~0.6s (matches the confirm flash lifetime).
let beatDashBorderBoost = 0
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
let dashSweepFlash = 0   // hot-white impact flash on the dash-sweep rings; spikes on trigger, decays fast
let beatDashFlash = 0       // countdown for beat dash shockwave visual
let dashFailFlash = 0       // >0 = brief red flash on the recharging pies when dash attempted with no charge
export function triggerDashFailFlash(): void { dashFailFlash = 0.25 }
let beatDashX = 0
let beatDashY = 0
let beatDashRadius = 0
// Background ripple — soft wide brightness band that travels outward from the beat-blast
// origin THROUGH the floor/grid. Visually distinct from a ring attack (no defined edge, very
// wide gradient, color matches the grid). Drawn between grid lines and the dark vignette so
// the floor texture appears to be briefly lit by the wave passing through.
interface BgRipple { x: number; y: number; time: number; lifetime: number }
let bgRipple: BgRipple | null = null
const BG_RIPPLE_LIFETIME = 1.0
const BG_RIPPLE_MAX_RADIUS = 2400
export function triggerBackgroundRipple(x: number, y: number): void {
  bgRipple = { x, y, time: 0, lifetime: BG_RIPPLE_LIFETIME }
}
// Reverb shock-push ring — expanding cyan ring at the push radius, separate from the gold
// damage AOE so the player sees the (larger) push zone.
let shockPushFlash = 0
let shockPushX = 0
let shockPushY = 0
let shockPushRadius = 0
const SHOCK_PUSH_DURATION = 0.588   // ~40% slower push. MUST stay == GameManager SHOCK_WAVE_DURATION + ENEMY_SHOCK_DUR so physics tracks the visual
export function triggerShockPush(x: number, y: number, radius: number): void {
  shockPushFlash = SHOCK_PUSH_DURATION
  shockPushX = x
  shockPushY = y
  shockPushRadius = radius
}

// Enemy push-mode detonation — list-based version of the Reverb shock-push so MULTIPLE
// pushes can be live at once (volley + cluster easily fire >1 per beat), each with its
// own ring color. Draw routine mirrors the player's shockPush but per-entry + tinted.
interface EnemyShockPush { x: number; y: number; radius: number; timer: number; r: number; g: number; b: number }
const enemyShockPushes: EnemyShockPush[] = []
const ENEMY_SHOCK_DUR = 0.588   // ~40% slower push — kept == SHOCK_PUSH_DURATION + GameManager SHOCK_WAVE_DURATION
export function triggerEnemyShockPush(x: number, y: number, radius: number, r: number, g: number, b: number): void {
  enemyShockPushes.push({ x, y, radius, timer: 0, r, g, b })
}
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
// Always-on in dev so the overlay + CSV have data the instant you toggle (`\`); the __DEV__
// early-returns compile this to near-noops in release. Three primitives:
//   perfStart/perfEnd(label)  — time a section (manual pair, zero-alloc; use in hot paths)
//   perf(label, fn)           — time a single call (can't mismatch start/end; allocs a closure)
//   perfCount(label, n)       — record a live entity count for the overlay's counts panel
// perfDisplay holds AVG ms/frame per label (refreshed ~2×/sec); perfLog holds raw per-frame
// times for CSV export (spike analysis). To add coverage: wrap a section and it shows up
// automatically — no registration needed.
const perfTimers: Record<string, number> = {}
let perfDisplay: Record<string, number> = {}
let perfAccum: Record<string, number> = {}
let perfCountAccum: Record<string, number> = {}
let perfCountDisplay: Record<string, number> = {}
let perfFrames = 0
let perfLastFlushTs = 0   // for FRAME_REAL (true wall-clock frame period — catches GC stalls)
let lastTickJsMs = 0      // for TICK_JS — TOTAL per-frame JS (update+render+loop), set by GameLoop
// Spike/attribution additions: per-label MAX over the window (the felt drop is a spike, not the
// average), avg of the frame-level derived metrics, the update-step count (catch-up spirals), the
// current phase string (tags each CSV row so shared section labels stay split by mode), and a
// captured "worst frame" breakdown so a hitch's source can be read after the fact.
let perfMaxAccum: Record<string, number> = {}
let perfMaxDisplay: Record<string, number> = {}
let perfDerivedAccum: Record<string, number> = {}
let perfDerivedDisplay: Record<string, number> = {}
let perfUpdateSteps = 0
let perfCurPhase = ''
let perfWorstWin: { frameMs: number; row: Record<string, number>; phase: string } | null = null
let perfWorstDisplay: { frameMs: number; row: Record<string, number>; phase: string } | null = null
let perfWorstFrames = 0
const PERF_WORST_WINDOW = 180   // refresh the "worst frame" panel ~every 3s so a spike lingers long enough to read
const PERF_DERIVED_KEYS = ['FRAME_REAL', 'TICK_JS', 'unacc_js', 'non_js', 'update_steps', 'u_unacc']

export function perfStart(label: string): void {
  if (!__DEV__) return
  perfTimers[label] = performance.now()
}
export function perfEnd(label: string): void {
  if (!__DEV__) return
  const start = perfTimers[label]
  if (start !== undefined) {
    perfAccum[label] = (perfAccum[label] ?? 0) + (performance.now() - start)
  }
}
// Ergonomic wrapper — times fn() under `label` and returns its result. Start/end can't get
// mismatched. Calls fn() directly in release (the __DEV__ branch is dead-code-eliminated).
export function perf<T>(label: string, fn: () => T): T {
  if (!__DEV__) return fn()
  perfStart(label)
  const r = fn()
  perfEnd(label)
  return r
}
// Record a live count (enemies, bullets, tethers, particles, …) shown in the overlay's counts
// panel. Latest value wins each frame; snapshotted at the display-refresh cadence.
export function perfCount(label: string, n: number): void {
  if (!__DEV__) return
  perfCountAccum[label] = n
}
// Called by GameLoop at the end of every tick with the TOTAL wall-clock JS time for the whole
// frame (all update passes + render + loop overhead). FRAME_REAL - TICK_JS = the part NOT on the
// JS thread (GPU paint/compositing + vsync) — which JS can't break down further (use DevTools
// Performance for that). Recorded a frame late (perfFlush already ran), which is fine for averages.
export function recordTickJs(ms: number): void {
  if (!__DEV__) return
  lastTickJsMs = ms
}
// Called once per fixed update step (by GameManager) so a catch-up spiral — N updates in one
// render frame — shows up as `update_steps` instead of silently inflating U_TOTAL.
export function perfStep(): void {
  if (!__DEV__) return
  perfUpdateSteps++
}
// Tag the current game phase so shared section labels (e.g. `tethers`) can be split by mode in
// the exported CSV. One mode runs per frame, so the tag fully disambiguates the row.
export function perfSetPhase(phase: string): void {
  if (!__DEV__) return
  perfCurPhase = phase
}
const perfFrame: Record<string, number> = {}

function perfFlush(): void {
  if (!__DEV__) return
  // Capture this frame's values (delta from last accumulation) for the raw CSV log
  const snapshot: Record<string, number> = {}
  // True wall-clock frame period (update + render + GC + browser/vsync idle). Frames where
  // FRAME_REAL >> D_TOTAL+R_TOTAL are stalls the section timers can't see — almost always GC
  // from particle churn. The decisive "is the felt drop GC?" instrument. (CSV-only — not in
  // perfDisplay, since the overlay already shows real fps.)
  const nowTs = performance.now()
  if (perfLastFlushTs > 0) snapshot['FRAME_REAL'] = nowTs - perfLastFlushTs
  perfLastFlushTs = nowTs
  snapshot['TICK_JS'] = lastTickJsMs   // total JS this frame; FRAME_REAL - TICK_JS = GPU/compositor
  snapshot['update_steps'] = perfUpdateSteps
  perfUpdateSteps = 0
  for (const k of Object.keys(perfAccum)) {
    snapshot[k] = (perfAccum[k] ?? 0) - (perfFrame[k] ?? 0)
    perfFrame[k] = perfAccum[k] ?? 0
  }
  // Derived attribution rows — make every frame fully accountable at a glance:
  //   unacc_js = JS this frame NOT inside any timed total → GC / allocation / untimed code.
  //   non_js   = wall-clock not spent in JS at all        → GPU paint / compositor / vsync idle.
  // updTotal = whichever update path ran (only one of U/D/PHASE does per frame).
  const updTotal = (snapshot['U_TOTAL'] ?? 0) + (snapshot['D_TOTAL'] ?? 0) + (snapshot['PHASE_UPD'] ?? 0)
  const rTotal = snapshot['R_TOTAL'] ?? 0
  snapshot['unacc_js'] = Math.max(0, (snapshot['TICK_JS'] ?? 0) - updTotal - rTotal)
  snapshot['non_js'] = Math.max(0, (snapshot['FRAME_REAL'] ?? 0) - (snapshot['TICK_JS'] ?? 0))
  // u_unacc = code INSIDE the update path not covered by a u_* child (toasts, walls, zones,
  // revenge, win-check…). Distinct from unacc_js (which is GC + code outside the totals). Sum the
  // u_* section deltas, then subtract from whichever update total ran. Match exactly 'u_' (char
  // 117,95) so 'unacc_js'/'update_steps'/'U_TOTAL' are excluded.
  let uChildren = 0
  for (const k of Object.keys(snapshot)) {
    if (k.charCodeAt(0) === 117 && k.charCodeAt(1) === 95) uChildren += snapshot[k]!
  }
  snapshot['u_unacc'] = Math.max(0, (snapshot['U_TOTAL'] ?? 0) + (snapshot['D_TOTAL'] ?? 0) - uChildren)
  // Fold live entity counts into the row (prefixed '#') so the CSV can correlate cost with
  // load — e.g. whether `particles` tracks `#bullets`, or the pool (`#particles`) is saturated.
  for (const k of Object.keys(perfCountAccum)) snapshot['#' + k] = perfCountAccum[k]!
  perfLog.push(snapshot)
  perfLogPhase.push(perfCurPhase)
  if (perfLog.length > MAX_LOG_FRAMES) { perfLog.shift(); perfLogPhase.shift() }

  // Accumulate the frame-level derived metrics for their own averaged display row.
  for (const k of PERF_DERIVED_KEYS) perfDerivedAccum[k] = (perfDerivedAccum[k] ?? 0) + (snapshot[k] ?? 0)
  // Per-label MAX over the window — surfaces spikes the 30-frame average smooths away.
  for (const k of Object.keys(snapshot)) {
    if (k.charCodeAt(0) === 35) continue   // skip '#' count columns
    const v = snapshot[k]!
    if (v > (perfMaxAccum[k] ?? 0)) perfMaxAccum[k] = v
  }
  // Worst-frame capture — keep the highest-FRAME_REAL frame's full breakdown so the source of a
  // hitch can be read after it happens. Rolls over every PERF_WORST_WINDOW frames so it tracks
  // RECENT spikes rather than the session's all-time worst.
  const frameMs = snapshot['FRAME_REAL'] ?? 0
  if (!perfWorstWin || frameMs > perfWorstWin.frameMs) {
    perfWorstWin = { frameMs, row: { ...snapshot }, phase: perfCurPhase }
  }
  perfWorstFrames++
  if (perfWorstFrames >= PERF_WORST_WINDOW) {
    if (perfWorstWin) perfWorstDisplay = perfWorstWin
    perfWorstWin = null
    perfWorstFrames = 0
  }

  perfFrames++
  if (perfFrames >= 30) {   // refresh the on-screen readout ~2×/sec
    const inv = 1 / perfFrames
    const disp: Record<string, number> = {}
    for (const k of Object.keys(perfAccum)) disp[k] = perfAccum[k]! * inv   // avg ms/frame
    perfDisplay = disp
    perfMaxDisplay = { ...perfMaxAccum }
    const derived: Record<string, number> = {}
    for (const k of PERF_DERIVED_KEYS) derived[k] = (perfDerivedAccum[k] ?? 0) * inv
    perfDerivedDisplay = derived
    perfCountDisplay = { ...perfCountAccum }
    for (const k of Object.keys(perfAccum)) {
      perfAccum[k] = 0
      perfFrame[k] = 0
    }
    perfMaxAccum = {}
    perfDerivedAccum = {}
    perfFrames = 0
  }
}
export function getPerfDisplay(): Record<string, number> { return perfDisplay }
export function getPerfCounts(): Record<string, number> { return perfCountDisplay }

// Perf log — stores per-frame snapshots for export. perfLogPhase is a parallel array of the phase
// string for each frame (kept separate so perfLog stays a clean numeric map).
const perfLog: Record<string, number>[] = []
const perfLogPhase: string[] = []
const MAX_LOG_FRAMES = 1800  // ~30s at 60fps / ~12s at 150fps — long enough to catch a brief drop

export function exportPerfLog(): void {
  // Column set = UNION of every label seen across the buffer. Intermittent labels (bullets,
  // tethers, …) only appear in frames where they actually ran, so using a single frame's keys
  // would misalign the CSV. Totals first, then the rest alphabetised, for a stable layout.
  const keySet = new Set<string>()
  for (const row of perfLog) for (const k of Object.keys(row)) keySet.add(k)
  // Headline columns first (whole-frame totals + the GC/GPU/steps attribution), then the rest
  // alphabetised, so a hitch can be read left-to-right without hunting.
  const pinned = ['U_TOTAL', 'D_TOTAL', 'PHASE_UPD', 'R_TOTAL', 'FRAME_REAL', 'TICK_JS', 'unacc_js', 'non_js', 'u_unacc', 'update_steps']
  const totals = pinned.filter(k => keySet.has(k))
  const cols = [...totals, ...[...keySet].filter(k => !pinned.includes(k)).sort()]
  const csv = ['frame,phase,' + cols.join(',')]
  for (let i = 0; i < perfLog.length; i++) {
    const row = perfLog[i]!
    csv.push(i + ',' + (perfLogPhase[i] ?? '') + ',' + cols.map(k => (row[k] ?? 0).toFixed(3)).join(','))
  }
  const blob = new Blob([csv.join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'perf-log.csv'
  a.click()
  URL.revokeObjectURL(url)
  console.log('Perf log exported:', perfLog.length, 'frames,', cols.length, 'columns')
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
  nodeIndex: number    // -1 = follow enemy body; >=0 = follow this weak-node's live position
  pts: { x: number; y: number }[]
  lastX: number; lastY: number
  timer: number; lifetime: number; scale: number
  fadeOffset: number   // ±shift to grow-end so strands stagger their fade start
  flickerSeed: number  // per-bolt phase seed so flicker isn't synced across strands
  angularVel: number   // rad/sec — bolt rotates around its origin as it ages
}
const lightningBolts: LightningBolt[] = []
const MAX_BOLTS = 90
// Shared spin applied to EVERY beat-dash bolt so the whole burst rotates together (layered ON TOP
// of each strand's individual angularVel). One module clock → all live bolts read the same global
// angle, so they swirl in unison rather than each doing its own thing.
const LIGHTNING_GLOBAL_SPIN = 9.5   // rad/s — collective swirl rate (faster)
let lightningSpinClock = 0

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
    enemy, nodeIndex: -1, pts: buildBoltPoints(angle, length),
    lastX: enemy.x, lastY: enemy.y,
    // Longer life than the AOE-center bolts so the lightning lingers + fades slower ON the enemies
    // that got hit (was 0.29–0.36s).
    timer: 0, lifetime: 0.5 + Math.random() * 0.12, scale,
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
    enemy: null, nodeIndex: -1, pts: buildBoltPoints(angle, length),
    lastX: x, lastY: y,
    timer: 0, lifetime, scale,
    fadeOffset: -0.05 + Math.random() * 0.30,
    flickerSeed: Math.random() * 100,
    angularVel: (Math.random() - 0.5) * 11,
  })
}

// Node-anchored variant — the bolt follows weak-node `nodeIndex`'s LIVE position as it moves on its
// pattern, so the lightning rides the node instead of staying pinned where it was hit.
function spawnNodeLightningBolt(enemy: Enemy, nodeIndex: number, angle: number, length: number, scale: number, lifetime: number): void {
  if (lightningBolts.length >= MAX_BOLTS) return
  const p = nodeWorldPos(enemy, nodeIndex, gameTimeMs / 1000)
  lightningBolts.push({
    enemy, nodeIndex, pts: buildBoltPoints(angle, length),
    lastX: p.x, lastY: p.y,
    timer: 0, lifetime, scale,
    fadeOffset: -0.05 + Math.random() * 0.30,
    flickerSeed: Math.random() * 100,
    angularVel: (Math.random() - 0.5) * 11,
  })
}

function updateAndDrawLightningBolts(dt: number): void {
  lightningSpinClock += dt
  const globalRot = lightningSpinClock * LIGHTNING_GLOBAL_SPIN   // shared angle — all bolts co-rotate
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
    if (b.enemy && b.enemy.alive && !b.enemy.dying) {
      if (b.nodeIndex >= 0) {
        const np = nodeWorldPos(b.enemy, b.nodeIndex, gameTimeMs / 1000)   // ride the node's live position
        b.lastX = np.x; b.lastY = np.y
      } else {
        b.lastX = b.enemy.x; b.lastY = b.enemy.y
      }
    }
    const ax = b.lastX, ay = b.lastY
    // Rotate the bolt around its anchor — its own angularVel PLUS the shared global swirl, so each
    // strand spins individually while the whole burst rotates together.
    const rot = b.timer * b.angularVel + globalRot
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
    ctx.lineWidth = 6.2 * b.scale * (0.7 + fadeT * 0.3) * 1.4
    ctx.stroke()
    // Fat yellow glow — thickness scales with the originating enemy's size
    ctx.strokeStyle = `rgba(255, 200, 60, ${alpha * 0.9})`
    ctx.lineWidth = 6.2 * b.scale * (0.7 + fadeT * 0.3)
    ctx.stroke()
    // Hot white core on top
    ctx.strokeStyle = `rgba(255, 255, 220, ${alpha})`
    ctx.lineWidth = 2.0 * b.scale
    ctx.stroke()
  }
  ctx.lineCap = 'butt'
}

// Orb absorb effects — stream from orb to player
interface AbsorbEffect {
  originX: number; originY: number
  targetX: number; targetY: number  // -1,-1 = track player
  target: ParticleParent | null     // live entity to home in on (overrides targetX/Y) — e.g. a moving
                                     // enemy consuming an orb, so the stream follows it as it moves
  r: number; g: number; b: number
  timer: number
  duration: number
}
const absorbEffects: AbsorbEffect[] = []
const MAX_ABSORBS = 15

export function addAbsorbEffect(x: number, y: number, r: number, g: number, b: number, targetX = -1, targetY = -1, target: ParticleParent | null = null): void {
  if (absorbEffects.length >= MAX_ABSORBS) absorbEffects.shift()
  absorbEffects.push({ originX: x, originY: y, targetX, targetY, target, r, g, b, timer: 0, duration: 0.4 })
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
    const tx = fx.target ? fx.target.x : (fx.targetX < 0 ? player.x : fx.targetX)
    const ty = fx.target ? fx.target.y : (fx.targetY < 0 ? player.y : fx.targetY)
    const sx2 = tx - camX
    const sy2 = ty - camY
    const ddx = sx2 - sx1, ddy = sy2 - sy1

    const dist = Math.sqrt(ddx * ddx + ddy * ddy)

    // Connection beam — a soft ADDITIVE glow line along the whole origin→target path, so the
    // collection reads clearly even across the arena (the chain orbs alone get sparse at distance).
    // Brightest early, fades as the orbs arrive.
    {
      const beamA = (1 - t) * (1 - t)
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'
      ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2)
      ctx.strokeStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${beamA * 0.2})`
      ctx.lineWidth = 13
      ctx.stroke()
      ctx.beginPath(); ctx.moveTo(sx1, sy1); ctx.lineTo(sx2, sy2)
      ctx.strokeStyle = `rgba(${Math.min(255, fx.r + 60)}, ${Math.min(255, fx.g + 50)}, ${Math.min(255, fx.b + 50)}, ${beamA * 0.38})`
      ctx.lineWidth = 3.8
      ctx.stroke()
      ctx.globalCompositeOperation = prevComp
    }

    // Chain orbs — count + spacing scale with distance so a long stream stays DENSE and continuous
    // instead of a few dots strung far apart.
    // More orbs at distance so a long stream stays DENSE/full instead of sparse. The expensive
    // glow halo is capped at an absolute count below (not a fraction), so these extra distance orbs
    // are just cheap cores + beams — fuller look, ~flat cost.
    const chainCount = Math.max(9, Math.min(16, 5 + Math.round(dist / 70)))
    const spacing = 0.5 / chainCount
    ctx.lineCap = 'round'

    // Perpendicular-to-travel unit vector — constant for the whole stream (origin/target don't
    // move within one render call), so compute it ONCE here instead of per chain orb. perpLen is
    // identical to `dist` (a 90° rotation preserves magnitude), so reuse the sqrt already taken.
    const hasWave = dist > 1
    const wnx = hasWave ? -ddy / dist : 0
    const wny = hasWave ? ddx / dist : 0

    for (let c = 0; c < chainCount; c++) {
      const orbT = t - c * spacing
      if (orbT < 0 || orbT > 1) continue
      const orbEase = orbT * orbT * (3 - 2 * orbT)  // smooth ease in-out
      const orbLife = 1 - orbT

      // Sine wave perpendicular to travel direction
      const wave = hasWave
        ? Math.sin(orbT * 12 + c * 1.5) * 22 * orbLife * orbLife  // wave fades faster near target
        : 0

      const orbX = sx1 + ddx * orbEase + wnx * wave
      const orbY = sy1 + ddy * orbEase + wny * wave
      // Size tapers from the leading orb back along the chain by FRACTION (so it stays sensible at
      // any chainCount), front ~22px → tail ~7px.
      const orbSize = (25 - 16 * (c / chainCount)) * Math.max(orbLife, 0.15)

      // Glow — the big additive halo is the dominant fill-rate cost, so cap it at an ABSOLUTE count
      // (not a fraction of chainCount). That bounds overdraw no matter how long/dense the stream
      // gets; the extra distance orbs beyond this still draw cheap cores + beams to fill the gaps.
      if (c < 9) {
        ctx.beginPath()
        ctx.arc(orbX, orbY, orbSize + 25, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${orbLife * 0.38})`
        ctx.fill()
      }

      // Core — bright bead
      ctx.beginPath()
      ctx.arc(orbX, orbY, Math.max(1, orbSize), 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${Math.min(255, fx.r + 90)}, ${Math.min(255, fx.g + 70)}, ${Math.min(255, fx.b + 70)}, ${Math.min(1, orbLife * 0.92)})`
      ctx.fill()

      // Beam to next — bumped from 0.36 → 0.55
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
          ctx.strokeStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${orbLife * 0.63})`
          ctx.lineWidth = 6 * orbLife
          ctx.stroke()
        }
      }

      // Energy sparks along stream — trimmed rate (was 0.3) to cut pool churn from many streams.
      if (Math.random() < 0.2) {
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
  heal: boolean   // gold nourish flash (white-hot core kept) instead of the red fire flash
  parent?: ParticleParent | undefined   // optional: rigidly rides a moving/rotating wall (center + rotation)
  lastPX?: number; lastPY?: number; lastRot?: number
}
const volatileExplosions: VolatileExplosion[] = []

// Pending volatile buildup visuals (read from GameManager)
export interface PendingExplosionVisual {
  x: number; y: number; range: number
  r: number; g: number; b: number; timer: number
  buildup: number   // seconds the telegraph expands before bursting (so it can start immediately yet still burst on-beat)
  heal: boolean     // gold nourish telegraph (rising gold sparkles) instead of the red fire claim
}
let pendingExplosionVisuals: PendingExplosionVisual[] = []

export function setPendingExplosions(pending: PendingExplosionVisual[]): void {
  pendingExplosionVisuals = pending
}

export function addVolatileExplosion(x: number, y: number, range: number, r: number, g: number, b: number, heal: boolean = false, parent?: ParticleParent): void {
  volatileExplosions.push({ x, y, range, r, g, b, timer: 0, duration: 0.21, heal, parent, lastPX: parent?.x ?? x, lastPY: parent?.y ?? y, lastRot: parent?.rot ?? 0 })
}

// countMul scales the particle counts (walls tile this along the spine and pass <1 so the whole
// strip totals ~one blast). parent (optional) rigidly attaches every particle to a moving/rotating
// wall — same outward motion, but it rides the wall's center + rotation. No parent = world particles.
export function spawnVolatileParticles(cx: number, cy: number, range: number, r: number, g: number, b: number, countMul = 1, parent?: ParticleParent): void {
  // Volatile particles carry no glow tint (tintR = -1) — pass that through whichever spawner.
  const emit = (px: number, py: number, vx: number, vy: number, pr: number, pg: number, pb: number, life: number, size: number, spin = 0) => {
    if (parent) spawnParticleAttached(px, py, vx, vy, pr, pg, pb, life, size, -1, 0, 0, parent, 0, false, false, spin)
    else spawnParticle(px, py, vx, vy, pr, pg, pb, life, size, spin)
  }
  const count = lodCount(Math.round(Math.min(56, Math.round(Math.sqrt(range) * 3.5)) * countMul))
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
    // Wall bursts (parent) fill EVENLY to the edge (sqrt = area-uniform, biased outward) and launch
    // faster so the shards reach the zone rim; the point volatile keeps its center-biased look.
    const dist = parent ? range * Math.sqrt(0.2 + 0.8 * Math.random()) : range * (0.3 + Math.random() * 0.7)
    const px = cx + Math.cos(angle) * dist
    const py = cy + Math.sin(angle) * dist
    const speed = parent ? 210 + Math.random() * 240 : 140 + Math.random() * 200
    const outAngle = Math.atan2(py - cy, px - cx)
    const tint = Math.random()
    const pr = Math.min(255, r + Math.floor(tint * 120))
    const pg = Math.min(255, g + Math.floor(tint * 40))
    const pb = Math.min(255, b + Math.floor(tint * 40))
    const spin = (8 + Math.random() * 10) * (Math.random() < 0.5 ? 1 : -1)
    emit(px, py,
      Math.cos(outAngle) * speed, Math.sin(outAngle) * speed,
      pr, pg, pb,
      0.24 + Math.random() * 0.14, 23 + Math.random() * 10, spin)   // chunky spinning shards (23–33px); shortened life so they fade WITH the blast
  }
  // (Removed the white-hot core flash particle burst — redundant with the big white blast flash in
  // updateAndDrawVolatileEffects, and it was the source of the grey center on fade.)
  // Edge ring sparks — fast particles tracing the blast circumference
  const edgeCount = lodCount(Math.round(Math.min(20, Math.round(range / 8)) * countMul))
  for (let i = 0; i < edgeCount; i++) {
    const angle = (i / edgeCount) * Math.PI * 2
    const tangent = angle + Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1)
    const speed = 120 + Math.random() * 180
    const px = cx + Math.cos(angle) * range
    const py = cy + Math.sin(angle) * range
    emit(px, py,
      Math.cos(tangent) * speed + Math.cos(angle) * 30,
      Math.sin(tangent) * speed + Math.sin(angle) * 30,
      Math.min(255, r + 100), Math.min(255, g + 60), Math.min(255, b + 60),
      0.22 + Math.random() * 0.15, 3 + Math.random() * 2.5)
  }
}

// Gold NOURISH blast — the heal-mode counterpart to spawnVolatileParticles. Same radial spread +
// count scaling, but the palette is the player's heal gold (warm body + gold glow tint) and the
// motion is FLOATY (slower, with an upward lift) rather than violent debris — it blooms and rises
// instead of shattering outward. Snappy life so it still pops on the beat, not a lingering haze.
export function spawnHealExplosionParticles(cx: number, cy: number, range: number, countMul = 1, parent?: ParticleParent): void {
  // Gold heal particles carry a pale-gold glow tint — route to attached/world spawner accordingly.
  const emitG = (px: number, py: number, vx: number, vy: number, pr: number, pg: number, pb: number, life: number, size: number, spin: number, tR: number, tG: number, tB: number) => {
    if (parent) spawnParticleAttached(px, py, vx, vy, pr, pg, pb, life, size, tR, tG, tB, parent, 0, false, false, spin)
    else spawnParticle(px, py, vx, vy, pr, pg, pb, life, size, spin, tR, tG, tB)
  }
  const count = lodCount(Math.round(Math.min(52, Math.round(Math.sqrt(range) * 3.2)) * countMul))
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
    // Wall bursts (parent) fill evenly to the edge + drift a bit faster so the bloom reaches the rim.
    const dist = parent ? range * Math.sqrt(0.2 + 0.8 * Math.random()) : range * (0.25 + Math.random() * 0.7)
    const px = cx + Math.cos(angle) * dist
    const py = cy + Math.sin(angle) * dist
    const outAngle = Math.atan2(py - cy, px - cx)
    const speed = parent ? 120 + Math.random() * 150 : 70 + Math.random() * 130   // floaty, faster on walls to reach the rim
    const tint = Math.random()
    emitG(px, py,
      Math.cos(outAngle) * speed, Math.sin(outAngle) * speed - 55,   // upward lift = benevolent rise
      255, 242 + Math.floor(tint * 13), 205 + Math.floor(tint * 40),  // white-gold body
      0.30 + Math.random() * 0.2, 5 + Math.random() * 5,              // fade a bit faster (was 0.38–0.64s)
      (Math.random() < 0.5 ? 1 : -1) * (4 + Math.random() * 6),
      255, 232, 180)                                       // pale-gold glow tint → white-gold bloom
  }
  // Big gold sparkle-STARS — the same 4-point glint the player gets on a boost grab: they POP in fast
  // on the burst and shrink + fade away. Anchored to `parent` when given (rigidly rides a moving/
  // rotating wall) — otherwise a frozen point at the blast.
  const starParent: ParticleParent = parent ?? { x: cx, y: cy }
  const starN = lodCount(Math.round(Math.min(18, Math.round(Math.sqrt(range) * 1.4)) * countMul))
  for (let i = 0; i < starN; i++) {
    const a = (i / starN) * Math.PI * 2 + Math.random() * 0.5
    const sp = 235 + Math.random() * 215                   // reach the rim without overshooting much past it
    const dist = range * (0.35 + Math.random() * 0.5)      // start further out (not bunched at center)
    starGlints.push({
      x: cx + Math.cos(a) * dist, y: cy + Math.sin(a) * dist,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      size: 18 + Math.random() * 14,                       // bigger than the boost stars (18–32px)
      rot: Math.random() * Math.PI, rotSpeed: (Math.random() - 0.5) * 6,
      life: 0, maxLife: 0.26 + Math.random() * 0.14,       // quick pop + faster fade
      parent: starParent, lastPX: starParent.x, lastPY: starParent.y, lastRot: starParent.rot ?? 0,
      shrink: true, friction: 0.93,                        // coast a bit less so they settle near the rim
    })
  }
  // White-gold twinkle highlights rising from the center — the bright "sparkle" core
  const hotCount = lodCount(Math.round(Math.min(14, Math.round(range / 12)) * countMul))
  for (let i = 0; i < hotCount; i++) {
    const angle = Math.random() * Math.PI * 2
    const speed = 90 + Math.random() * 160
    emitG(cx, cy,
      Math.cos(angle) * speed, Math.sin(angle) * speed - 45,
      255, 252, 238,
      0.24 + Math.random() * 0.16, 3 + Math.random() * 2.5,
      0, 255, 242, 205)
  }
}

// Wall ZONE burst — the damage/heal "explosion" debris on the fire beat. Rich volatile-style
// scatter (red sparks for damage, white-gold sparkles for heal) PARENT-ATTACHED to the wall's live
// center AND rotation, so the whole spray rigidly rides a turning / translating wall (each particle
// still flies outward relative to the wall). Tiled along the spine so a long wall fully detonates.
export function spawnWallZoneBurst(w: Wall, heal: boolean): void {
  const range = w.zone?.range ?? 0
  if (range <= 1) return
  const dxw = w.bx - w.ax, dyw = w.by - w.ay
  const len = Math.sqrt(dxw * dxw + dyw * dyw)
  const pillar = len < 0.5
  const arc = computeWallArc(w)
  const blastR = w.radius + range
  // Anchor tracks the wall every frame: center (translation) + chord angle (rotation). For a pillar
  // the chord is zero-length → rot ≈ 0 (no spin), so its radial debris just translates — correct.
  const anchor: ParticleParent = {
    get x() { return (w.ax + w.bx) / 2 },
    get y() { return (w.ay + w.by) / 2 },
    get rot() { return Math.atan2(w.by - w.ay, w.bx - w.ax) },
  }
  const centers: { x: number; y: number }[] = []
  if (arc) {
    const n = Math.max(1, Math.min(6, Math.round((arc.r * Math.abs(arc.aB - arc.aA)) / (blastR * 0.9))))
    for (let i = 0; i < n; i++) {
      const a = arc.aA + (arc.aB - arc.aA) * (n === 1 ? 0.5 : i / (n - 1))
      centers.push({ x: arc.cx + Math.cos(a) * arc.r, y: arc.cy + Math.sin(a) * arc.r })
    }
  } else if (pillar) {
    centers.push({ x: w.ax, y: w.ay })
  } else {
    const n = Math.max(1, Math.min(6, Math.round(len / (blastR * 0.9)) + 1))
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1)
      centers.push({ x: w.ax + dxw * t, y: w.ay + dyw * t })
    }
  }
  // Fire the EXACT volatile blast language at each tiled center, ATTACHED to the wall anchor so the
  // whole burst rigidly rides the wall's center + rotation. countMul = 1/centers so the full strip
  // totals ~one volatile blast's worth of particles spread along its length. Damage = the fire shards
  // + flash; heal = the gold sparkle-stars + flash (heal=true routes both the flash and spawner gold).
  const cmul = 2 / centers.length    // ~2 blasts' worth spread along the strip (doubled)
  const zr = 255, zg = 75, zb = 30   // fire-red damage palette; heal ignores this (gold via heal flag)
  for (const c of centers) {
    addVolatileExplosion(c.x, c.y, blastR, zr, zg, zb, heal, anchor)
    if (heal) spawnHealExplosionParticles(c.x, c.y, blastR, cmul, anchor)
    else spawnVolatileParticles(c.x, c.y, blastR, zr, zg, zb, cmul, anchor)
  }
}


// Destruction burst for an explode-mode bullet — the dart SHATTERS into its blast telegraph.
// A bright flash + an outward scatter of hot embers at the detonation point, bridging the
// dart's collapse to the expanding explosion-radius telegraph that follows. Warm/fiery palette
// (matches the volatile in-flight embers) regardless of bullet colour, so it reads as "ignition."
export function spawnExplodeBulletDestruction(x: number, y: number, heal: boolean = false): void {
  // Big, clear flash so the dart's destruction reads as a real event (not the blast itself).
  if (heal) {
    // Gold "bloom" shatter — the dart dissolves into warm gold motes that lift and twinkle, the
    // nourish counterpart to the fiery ignition. Gold glow tints make each mote bloom a gold halo.
    spawnParticle(x, y, 0, 0, 255, 250, 228, 0.16, 32, 0, 255, 238, 195)   // bright white-gold core flash
    spawnParticle(x, y, 0, 0, 255, 240, 200, 0.22, 22, 0, 255, 232, 180)   // white-gold outer flash
    const n = lodCount(20)
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
      const sp = 110 + Math.random() * 180                 // gentler than the fiery scatter
      const tint = Math.random()
      spawnParticle(x, y,
        Math.cos(a) * sp, Math.sin(a) * sp - 40,            // upward lift
        255, 242 + Math.floor(tint * 13), 205 + Math.floor(tint * 40),
        0.3 + Math.random() * 0.24, 4 + Math.random() * 4,
        (Math.random() < 0.5 ? 1 : -1) * (4 + Math.random() * 6),
        255, 232, 180)
    }
    return
  }
  spawnParticle(x, y, 0, 0, 255, 236, 200, 0.16, 34)            // bright core flash
  spawnParticle(x, y, 0, 0, 255, 160, 80, 0.22, 22)            // warm outer flash
  const n = lodCount(22)
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
    const sp = 170 + Math.random() * 260
    const tint = Math.random()
    spawnParticle(x, y,
      Math.cos(a) * sp, Math.sin(a) * sp,
      255, Math.floor(90 + tint * 110), Math.floor(20 + tint * 45),
      0.24 + Math.random() * 0.2, 4.5 + Math.random() * 4.5)
  }
  // A few fat chunks for weight
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 90 + Math.random() * 150
    spawnParticle(x, y,
      Math.cos(a) * sp, Math.sin(a) * sp,
      255, 150 + Math.floor(Math.random() * 70), 60,
      0.3 + Math.random() * 0.22, 7 + Math.random() * 5,
      (Math.random() < 0.5 ? 1 : -1) * (6 + Math.random() * 8))
  }
}

function updateAndDrawVolatileEffects(dt: number): void {
  // Buildup — ring expands from center to blast range over 1s
  for (const p of pendingExplosionVisuals) {
    const sx = p.x - camX, sy = p.y - camY
    const progress = Math.max(0, Math.min(p.timer / p.buildup, 1))  // 0→1 over the buildup window
    const ringR = progress * p.range
    const alpha = 0.15 + progress * 0.25

    // Telegraph color. Damage blasts blend toward RED (danger). Heal blasts hold a warm GOLD
    // (nourish) — bright from the start and brightening toward the burst, matching the heal halo.
    let rr: number, rg: number, rb: number
    if (p.heal) {
      const goldBlend = 0.7 + 0.3 * progress
      rr = 255
      rg = Math.floor(235 + 20 * goldBlend)   // white-gold: ~249 → 255
      rb = Math.floor(185 + 45 * (1 - goldBlend))
    } else {
      // Start red, blend slightly toward enemy color mid-way, then back to red
      const redBase = 0.6  // 60% red from the start
      const redBlend = redBase + (1 - redBase) * progress
      rr = Math.min(255, Math.floor(p.r + (255 - p.r) * redBlend))
      rg = Math.floor(p.g * (1 - redBlend * 0.8))
      rb = Math.floor(p.b * (1 - redBlend * 0.8))
    }

    // Claimed-zone fill — the spreading circle visibly TINTS whatever it covers (it's drawn over the
    // player + enemies), so it reads as the danger zone consuming them as it grows. Stronger than the
    // old faint 0.12 so the "consuming" is clearly visible.
    ctx.beginPath()
    ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${rr}, ${rg}, ${rb}, ${progress * progress * 0.26})`
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
          if (p.heal) {
            // White-gold motes rising inside the telegraph — white-gold body + pale-gold glow tint
            spawnParticle(px, py,
              Math.cos(outA) * speed * 0.5, -20 - Math.random() * 40 + Math.sin(outA) * speed * 0.3,
              255, 242 + Math.floor(Math.random() * 13), 205 + Math.floor(Math.random() * 35),
              0.2 + progress * 0.2, 3 + Math.random() * 3, 0, 255, 232, 180)
          } else {
            const fr = Math.min(255, rr + Math.floor(Math.random() * 40))
            const fg = Math.floor(40 + Math.random() * 60 * (1 - progress))
            spawnParticle(px, py,
              Math.cos(outA) * speed * 0.5, -20 - Math.random() * 40 + Math.sin(outA) * speed * 0.3,
              fr, fg, 20, 0.2 + progress * 0.2, 3 + Math.random() * 3)
          }
        }
      }
      // Edge sparks along the expanding ring — inside and outside
      for (let e = 0; e < 2; e++) {
        if (Math.random() < fireRate * 1.5) {
          const a = Math.random() * Math.PI * 2
          const edgeDist = ringR + (Math.random() - 0.5) * 16  // straddle the ring edge
          const speed = 40 + Math.random() * 60
          const inward = Math.random() < 0.5 ? -1 : 1
          if (p.heal) {
            spawnParticle(
              p.x + Math.cos(a) * edgeDist, p.y + Math.sin(a) * edgeDist,
              Math.cos(a) * speed * inward, Math.sin(a) * speed * inward - 15,
              255, 245 + Math.floor(Math.random() * 10), 210,
              0.12 + Math.random() * 0.1, 2 + Math.random() * 2, 0, 255, 235, 185)
          } else {
            spawnParticle(
              p.x + Math.cos(a) * edgeDist, p.y + Math.sin(a) * edgeDist,
              Math.cos(a) * speed * inward, Math.sin(a) * speed * inward - 15,
              255, 120 + Math.floor(Math.random() * 80), 30,
              0.12 + Math.random() * 0.1, 2 + Math.random() * 2)
          }
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
    // Parent-follow — rides a moving/rotating wall (its tile center orbits the wall pivot). Translate
    // by the parent's per-frame delta, then rotate the offset around the parent center.
    if (ex.parent) {
      ex.x += ex.parent.x - (ex.lastPX ?? ex.parent.x)
      ex.y += ex.parent.y - (ex.lastPY ?? ex.parent.y)
      ex.lastPX = ex.parent.x; ex.lastPY = ex.parent.y
      const prot = ex.parent.rot
      if (prot !== undefined && prot !== (ex.lastRot ?? 0)) {
        const dR = prot - (ex.lastRot ?? 0)
        const cs = Math.cos(dR), sn = Math.sin(dR)
        const ox = ex.x - ex.parent.x, oy = ex.y - ex.parent.y
        ex.x = ex.parent.x + ox * cs - oy * sn
        ex.y = ex.parent.y + ox * sn + oy * cs
        ex.lastRot = prot
      }
    }
    const t = ex.timer / ex.duration
    const alpha = (1 - t) * (1 - t)
    const sx = ex.x - camX, sy = ex.y - camY

    // Edge/flash tint — damage carries the red buildup color; heal carries warm gold.
    const erR = ex.heal ? 255 : Math.min(255, ex.r + Math.floor((255 - ex.r) * 0.7))
    const erG = ex.heal ? 246 : Math.floor(ex.g * 0.4)
    const erB = ex.heal ? 210 : Math.floor(ex.b * 0.4)

    // Area glow — radial gradient extending past the hitbox edge. Cheap (one fill per frame),
    // additive composite so overlapping explosions accumulate brightness like real light. Gold for
    // heal (nourish bloom), red for damage.
    {
      const glowR = ex.range * 1.35
      const glowAlpha = (1 - t) * (1 - t) * 0.78
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowR)
      if (ex.heal) {
        grad.addColorStop(0, `rgba(255, 250, 228, ${Math.min(1, glowAlpha)})`)
        grad.addColorStop(0.45, `rgba(255, 238, 190, ${glowAlpha * 0.78})`)
        grad.addColorStop(0.85, `rgba(255, 225, 160, ${glowAlpha * 0.27})`)
        grad.addColorStop(1, 'rgba(255, 220, 150, 0)')
      } else {
        grad.addColorStop(0, `rgba(255, 125, 70, ${Math.min(1, glowAlpha)})`)
        grad.addColorStop(0.45, `rgba(255, 75, 40, ${glowAlpha * 0.78})`)
        grad.addColorStop(0.85, `rgba(255, 45, 30, ${glowAlpha * 0.27})`)
        grad.addColorStop(1, 'rgba(255, 40, 30, 0)')
      }
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

    // Telegraph fade-out — the buildup telegraph is instant-removed the frame the blast fires, which
    // made the expanding danger zone pop out of existence. Re-draw it at full range here, fading out
    // FAST, so it resolves smoothly and the hitbox stays clearly readable as the blast activates.
    // Skipped on wall bursts (ex.parent) — those already have a permanent visible wall hitbox.
    if (!ex.parent) {
      const tgFade = Math.max(0, 1 - ex.timer / 0.23)
      if (tgFade > 0.01) {
        // Dim "claimed zone" fill so the whole shape fades, not just the rim
        ctx.beginPath()
        ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${erR}, ${erG}, ${erB}, ${tgFade * 0.10})`
        ctx.fill()
        // Bold danger ring at the exact hitbox edge
        ctx.beginPath()
        ctx.arc(sx, sy, ex.range, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${erR}, ${erG}, ${erB}, ${tgFade * 0.6})`
        ctx.lineWidth = 2.5 + tgFade * 6
        ctx.stroke()
      }
    }

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

// Adaptive particle LOD. Returns a 0..1 multiplier for non-essential BURST sizes based on how
// full the live pool is: full quality below SOFT, linear ramp to FLOOR by HARD. Multi-particle
// bursts (deaths, detonations, hit/consume sparks) scale by this so combat pile-ups stop flooding
// the pool — which costs both JS draw time and GPU overdraw. Single "core flash" spawns and
// player-feedback effects do NOT use this (they stay full at every load). See constants.ts.
function particleLod(): number {
  if (particleCount <= PARTICLE_LOD_SOFT) return 1
  if (particleCount >= PARTICLE_LOD_HARD) return PARTICLE_LOD_FLOOR
  const t = (particleCount - PARTICLE_LOD_SOFT) / (PARTICLE_LOD_HARD - PARTICLE_LOD_SOFT)
  return 1 - t * (1 - PARTICLE_LOD_FLOOR)
}
// Scale a burst's particle count by the current LOD, keeping at least `min` so a throttled burst
// shrinks but never vanishes (the effect must still read). NOTE: named particleLod (not burstScale)
// because a local `burstScale` particle-SIZE scalar already exists in the enemy-dodge renderer.
function lodCount(count: number, min = 2): number {
  return Math.max(min, Math.round(count * particleLod()))
}

// Top slice of the pool reserved for PRIORITY spawns (ring shards). Every normal spawn stops at
// (MAX_PARTICLES - this), so the continuous flood (trails, tether slashes, detonation sparks) can't
// pin the pool at the cap and starve the ring-attack shards — which fire LAST, at the hit frame.
const PARTICLE_PRIORITY_RESERVE = 220
function spawnParticle(
  x: number, y: number,
  vx: number, vy: number,
  r: number, g: number, b: number,
  lifetime: number, size: number,
  spinRate = 0,
  tintR = -1, tintG = 0, tintB = 0,
  orbitCx = 0, orbitCy = 0, orbitR = -1,
  priority = false   // ring shards pass true → may use the reserved top slice of the pool
): void {
  if (particleCount >= (priority ? MAX_PARTICLES : MAX_PARTICLES - PARTICLE_PRIORITY_RESERVE)) return
  if (getPhase() === 'entering_name') return  // block game particles on name entry screen
  const p = particles[particleCount++]!   // reuse the pooled slot — overwrite EVERY field
  p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.r = r; p.g = g; p.b = b
  p.life = 0; p.lifetime = lifetime; p.size = size; p.spinRate = spinRate
  p.tintR = tintR; p.tintG = tintG; p.tintB = tintB
  p.orbitCx = orbitCx; p.orbitCy = orbitCy; p.orbitR = orbitR
  p.parent = null; p.lastParentX = 0; p.lastParentY = 0; p.lastParentRot = 0; p.tintLate = false; p.belowEnemies = false
}

// Spawn a parent-attached particle. Each frame the particle's position is shifted by the
// parent's per-frame delta — the burst stays glued to a moving entity instead of being
// stranded in world space. Used for player/enemy blood so the spray translates with the body.
// `delaySec` defers the particle's appearance — it sits dormant (invisible, no motion) until
// the delay elapses, then begins its normal lifetime. Used to stagger when blood drops appear
// within a single burst.
function spawnParticleAttached(
  x: number, y: number,
  vx: number, vy: number,
  r: number, g: number, b: number,
  lifetime: number, size: number,
  tintR: number, tintG: number, tintB: number,
  parent: ParticleParent,
  delaySec: number = 0,
  tintLate: boolean = false,
  belowEnemies: boolean = false,
  spinRate: number = 0,
): void {
  if (particleCount >= MAX_PARTICLES - PARTICLE_PRIORITY_RESERVE) return   // leave the reserve for priority ring shards
  if (getPhase() === 'entering_name') return
  const initialLife = delaySec > 0 ? -delaySec / lifetime : 0
  const p = particles[particleCount++]!   // reuse the pooled slot — overwrite EVERY field
  p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.r = r; p.g = g; p.b = b
  p.life = initialLife; p.lifetime = lifetime; p.size = size; p.spinRate = spinRate
  p.tintR = tintR; p.tintG = tintG; p.tintB = tintB
  p.orbitCx = 0; p.orbitCy = 0; p.orbitR = -1
  p.parent = parent; p.lastParentX = parent.x; p.lastParentY = parent.y; p.lastParentRot = parent.rot ?? 0; p.tintLate = tintLate
  p.belowEnemies = belowEnemies
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

// Dash-shot (Bolt) projectile visual — bright gold core flying along the dash vector with a
// soft motion trail and a faint preview ring that swells toward the final blast radius. Sim
// (GameManager.spawnDashShot) calls addDashShotViz with start pos, velocity, target radius,
// and lifetime. Renderer ticks position/elapsed and draws each frame; viz removes itself on
// expiry. The actual boom (gold flash + volatile particles) is still fired by the sim via
// triggerBeatDashFlash / spawnVolatileParticles, same channel as a normal beat-dash.
interface DashShotViz {
  x: number; y: number
  vx: number; vy: number
  targetRadius: number
  elapsed: number
  lifetime: number
  spawnX: number; spawnY: number   // fixed origin of the discharge — anchors the lance + muzzle disc
  lanceTimer: number                // counts down — jagged arc from spawn → current pos while > 0
  muzzleTimer: number               // counts down — bright disc at spawn while > 0
  reverbMode: boolean               // true when Reverb is also active — palette-swap gold → cyan
  aftershock: boolean               // true when Aftershock is also active — first beat shows a moving aftershock pie,
                                    // bolt visuals dim during pie phase and crossfade in around t = 1.0s. Lifetime = 2 beats.
}
const dashShotVizList: DashShotViz[] = []
// Reusable scratch buffer for drawWalls — grown lazily, length reset to 0 each frame.
// Avoids per-frame Array allocation when many walls are on screen.
const WALL_DRAW_LIST: unknown[] = []
const DASH_SHOT_MIN_VIS_R = 20

// ── Enemy ranged bullet / detonation viz mirrors ──
// Sim-side bullets live in GameManager.enemyBullets; this is the renderer's mirror used for
// drawing. Position is ticked here from the spawn velocity+dt so it tracks the sim 1:1
// (they share `dt` from the same frame, started at the same moment).
interface EnemyBulletViz {
  x: number; y: number
  vx: number; vy: number
  elapsed: number; lifetime: number
  ringRadius: number     // detonation final radius — telegraph + impact viz reference
  launchDelay: number    // volley stagger — hold at origin until elapsed >= launchDelay
  released: boolean      // mirrors sim — controls re-anchor + velocity recompute moment
  offX: number; offY: number       // offset from owner's center — preserved as enemy moves
  isSurround: boolean              // surround_player → recompute velocity at release
  surroundTargetX: number          // landing target (used only when isSurround)
  surroundTargetY: number
  owner: Enemy | null              // for live position during hold; null if not a volley bullet
  r: number; g: number; b: number
  trackingRate: number   // radians/sec; matched to sim so viz tracks identically
  salvoId: number                  // groups siblings for tether preview lines
  salvoIndex: number               // stable order within the salvo (for topology ordering)
  tetherTopology: TetherTopology   // 'off' means no preview lines for this bullet
  tetherWidth: number              // for preview line width matching
  pushMode: boolean                // detonation shoves instead of damaging — drawn hollow + blunt + cool rim
  staccato: boolean                // freeze-between-beats, snap-on-beat motion (mirrors sim)
  staccatoDivision: number         // hops per beat (1 = whole, 2 = half-beat)
  staccatoPhase: number            // hop-grid phase shift in beats (0 = on-beat, 0.5 = off-beat)
  staccatoFireBeat: number
  staccatoHops: number
  staccatoReleased: number         // 0..1; -1 = not yet initialised
  staccatoPop: number              // 0..1 squash-stretch envelope, spikes on each hop, decays in the freeze
  muzzleX: number; muzzleY: number // launch point captured on first draw (NaN until set) — muzzle flash anchor
  isChild: boolean                 // cluster child (spawned by a parent bullet) — suppresses the muzzle/birth spawn anim
  explode: boolean                 // explode-mode — emits volatile-style fire embers in flight + a destruction burst on detonation
  heal: boolean                    // heal-mode explode variant — gold flashing tip + gold floaty embers (nourish read)
}
const enemyBulletVizList: EnemyBulletViz[] = []
interface EnemyDetonationViz {
  x: number; y: number
  attackTimer: number
  expandTime: number
  ringRadius: number
  r: number; g: number; b: number
  ring: import('../entities/Ring.ts').Ring   // synthesized at spawn so we can reuse drawRing()
}
const enemyDetonationVizList: EnemyDetonationViz[] = []

// Tether viz — bright damaging beams that snap between salvo siblings at the detonation
// beat. Visual vocabulary mirrors the ring blade at peak (multi-layer glow + white-gold
// flash + cutting-shard particles racing along the beam). Lifetime = TETHER_VIZ_DUR.
interface TetherViz {
  xs: number[]; ys: number[]
  topology: TetherTopology
  width: number
  r: number; g: number; b: number
  bornTime: number     // shared tetherClock value at spawn; elapsed = tetherClock - bornTime
  prearmTime: number   // mirrors sim — entity is dormant until elapsed >= prearmTime
}
const tetherVizList: TetherViz[] = []
const TETHER_VIZ_DUR = 0.20
// Shared sim-time clock, pushed from GameManager each update. The viz telegraph reads THIS
// (not render dt), so it stays locked to the sim tether strike regardless of framerate.
let tetherClock = 0
export function setTetherClock(t: number): void { tetherClock = t }

export function addTetherViz(xs: number[], ys: number[], topology: TetherTopology, width: number, r: number, g: number, b: number, prearmTime: number = 0, bornTime: number = tetherClock): void {
  // Copy the arrays so subsequent mutations on the sim-side don't affect the viz
  tetherVizList.push({ xs: xs.slice(), ys: ys.slice(), topology, width, r, g, b, bornTime, prearmTime })
}

// Same pair enumeration as the sim (kept in sync — if you change one, change both).
function* tetherVizPairs(topology: TetherTopology, n: number): Generator<[number, number]> {
  if (n < 2) return
  if (topology === 'closed') {
    for (let i = 0; i < n; i++) yield [i, (i + 1) % n]
  } else if (topology === 'open') {
    for (let i = 0; i < n - 1; i++) yield [i, i + 1]
  } else if (topology === 'pairs') {
    for (let i = 0; i + 1 < n; i += 2) yield [i, i + 1]
  } else if (topology === 'star') {
    for (let i = 0; i < n; i++) yield [i, n]
  } else if (topology === 'all') {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) yield [i, j]
  }
}

// Cluster split FX — at the detonation point of a cluster bullet, spawn a starburst
// whose SPOKES point in the actual direction of each child bullet. Reads clearly as
// "splitting NOW, into THESE directions" so the player can immediately see the next
// salvo's threat shape rather than a generic radial flash.
interface ClusterSplitFX {
  x: number; y: number
  timer: number
  r: number; g: number; b: number
  angles: number[]    // one entry per spawned child — spoke aimed in that direction
}
const clusterSplitFXList: ClusterSplitFX[] = []
const CLUSTER_SPLIT_DUR = 0.18

export function addEnemyBulletViz(x: number, y: number, vx: number, vy: number, lifetime: number, ringRadius: number, r: number, g: number, b: number, trackingRate: number = 0, launchDelay: number = 0, owner: Enemy | null = null, offX: number = 0, offY: number = 0, isSurround: boolean = false, surroundTargetX: number = 0, surroundTargetY: number = 0, salvoId: number = 0, salvoIndex: number = 0, tetherTopology: TetherTopology = 'off', tetherWidth: number = 8, pushMode: boolean = false, staccato: boolean = false, staccatoDivision: number = 1, staccatoPhase: number = 0, isChild: boolean = false, explode: boolean = false, heal: boolean = false): void {
  enemyBulletVizList.push({ x, y, vx, vy, elapsed: 0, lifetime, ringRadius, launchDelay, released: launchDelay <= 0, offX, offY, isSurround, surroundTargetX, surroundTargetY, owner, r, g, b, trackingRate, salvoId, salvoIndex, tetherTopology, tetherWidth, pushMode, staccato, staccatoDivision, staccatoPhase, staccatoFireBeat: 0, staccatoHops: 1, staccatoReleased: -1, staccatoPop: 0, muzzleX: NaN, muzzleY: NaN, isChild, explode, heal })
}
// Cluster split FX — one-shot starburst at the detonation point of a splitting bullet.
// `angles` is one entry per child bullet, in the direction that child is launching. The
// FX draws a spoke + biased spark burst in each direction so the next salvo's threat
// shape is telegraphed from the impact moment.
export function spawnClusterSplitFX(x: number, y: number, r: number, g: number, b: number, angles: number[]): void {
  clusterSplitFXList.push({ x, y, timer: 0, r, g, b, angles })
  // Directional spark burst — small tight cone aligned with each child's direction.
  // Cap total spawn to avoid a particle storm on dense salvos (e.g. radial 12 splits).
  const SPARKS_PER_DIR = 3
  const dirCount = Math.min(angles.length, 12)
  for (let d = 0; d < dirCount; d++) {
    const ba = angles[d]!
    for (let i = 0; i < SPARKS_PER_DIR; i++) {
      const spread = (Math.random() - 0.5) * 0.35   // ±0.175 rad cone
      const ang = ba + spread
      const sp = 280 + Math.random() * 240
      spawnParticle(
        x, y,
        Math.cos(ang) * sp, Math.sin(ang) * sp,
        Math.min(255, r + 130), Math.min(255, g + 130), Math.min(255, b + 130),
        0.22 + Math.random() * 0.14,
        2.0 + Math.random() * 1.3,
      )
    }
  }
}

export function addEnemyDetonationViz(x: number, y: number, expandTime: number, ringRadius: number, r: number, g: number, b: number): void {
  // Synthesize a Ring object so drawRing() can render the detonation with FULL ring visuals
  // (cutting shards at peak, red flash, white-gold peak flash, etc.) — identical to a normal
  // enemy ring attack. drawRing reads ring.radius (when no override) and ring.color.
  const ring = { phase: 0, radius: ringRadius, tempo: 1, color: [r / 255, g / 255, b / 255, 1] as [number, number, number, number], owner: 'enemy' as const }
  enemyDetonationVizList.push({ x, y, attackTimer: 0, expandTime, ringRadius, r, g, b, ring })
  spawnDetonationBurst(x, y, ringRadius, r, g, b)
}

// The "bullet destroyed/split" explosion — a fast, punchy firecracker burst (hot white-gold sparks
// + a bright core flash + chunky debris). SNAPPY: high outward speed, short lifetimes, so it reads
// as an instant POP rather than a slow bloom. Shared by normal detonations AND cluster splits.
// LODs down via particleLod() so a cascade of many at once can't flood the pool.
export function spawnDetonationBurst(x: number, y: number, ringRadius: number, r: number, g: number, b: number): void {
  const sparkLod = particleLod()
  const sparkCount = Math.round((16 + Math.min(16, Math.floor(ringRadius / 20))) * sparkLod)
  for (let i = 0; i < sparkCount; i++) {
    const a = Math.random() * Math.PI * 2
    const streak = Math.random() < 0.3                       // a few long firework embers
    const sp = (streak ? 840 : 580) + Math.random() * 560    // very fast — snaps outward instantly
    const gold = Math.random() < 0.7                          // most sparks are hot white-gold
    const sr = gold ? 255 : Math.min(255, r + 60)
    const sg = gold ? 225 : Math.min(255, g + 60)
    const sb = gold ? 150 : Math.min(255, b + 60)
    spawnParticle(
      x, y,
      Math.cos(a) * sp, Math.sin(a) * sp,
      sr, sg, sb,
      (streak ? 0.22 : 0.13) + Math.random() * 0.08,         // short life — quick pop, no lingering
      (streak ? 2.3 : 3.4) + Math.random() * 2,
    )
  }
  // Punch — a bright white core FLASH (big, very short-lived) that pops then vanishes.
  const flashR = Math.min(42, 14 + ringRadius * 0.17)
  spawnParticle(x, y, 0, 0, 255, 248, 230, 0.09, flashR)
  spawnParticle(x, y, 0, 0, 255, 235, 200, 0.14, flashR * 0.62)
  // Chunky debris — a few fat embers that arc out for weight (still quick).
  const debrisCount = Math.round(8 * sparkLod)
  for (let i = 0; i < debrisCount; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 320 + Math.random() * 400
    spawnParticle(
      x, y,
      Math.cos(a) * sp, Math.sin(a) * sp,
      255, Math.min(255, g + 90), Math.min(255, b + 40),
      0.24 + Math.random() * 0.16,
      5 + Math.random() * 3.5,
    )
  }
}

function drawEnemyBulletsAndDetonations(player: Player): void {
  // ── Tether preview — dashed lines between SIBLINGS of tethered salvos during flight.
  // Drawn FIRST (before the bullets) so the bullets — fuse tail included — render OVER their
  // own telegraph lines. Tells the player "this geometry is about to snap on the beat." Only
  // released bullets (post-volley-hold) participate so the preview "fills in" as bullets emerge.
  if (enemyBulletVizList.length > 0) {
    const salvos = new Map<number, EnemyBulletViz[]>()
    for (let i = 0; i < enemyBulletVizList.length; i++) {
      const b = enemyBulletVizList[i]!
      if (b.tetherTopology === 'off') continue
      if (!b.released) continue
      if (b.elapsed < b.launchDelay) continue
      let arr = salvos.get(b.salvoId)
      if (!arr) { arr = []; salvos.set(b.salvoId, arr) }
      arr.push(b)
    }
    if (salvos.size > 0) {
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      // Discrete dots at a fixed WORLD spacing — uniform circles locked to world-aligned positions
      // along each line. As the bullets spread, the line slides over this fixed dot grid: existing
      // dots hold their place and new ones append at the growing end. No dash phase/junction
      // artifacts (every dot identical), no swimming.
      const DOT_SPACING = 15
      for (const bullets of salvos.values()) {
        if (bullets.length < 2) continue
        bullets.sort((a, b) => a.salvoIndex - b.salvoIndex)
        const sample = bullets[0]!
        // Anticipation buildup — alpha grows over flight so the preview gets more pronounced as the
        // impact beat approaches.
        const flightT = Math.min(1, sample.elapsed / sample.lifetime)
        const alpha = 0.32 + flightT * 0.55    // 0.32 at fire → 0.87 near detonation
        // Blend ~40% toward white for contrast against the black floor, keeping a hint of bullet colour.
        const wr = Math.round(sample.r + (255 - sample.r) * 0.4)
        const wg = Math.round(sample.g + (255 - sample.g) * 0.4)
        const wb = Math.round(sample.b + (255 - sample.b) * 0.4)
        ctx.fillStyle = `rgba(${wr}, ${wg}, ${wb}, ${alpha})`
        const dotR = Math.max(1.6, (sample.tetherWidth * 0.85 - 2) * 0.6)
        const m = bullets.length
        let hubWx = 0, hubWy = 0
        if (sample.tetherTopology === 'star') {
          for (const b of bullets) { hubWx += b.x; hubWy += b.y }
          hubWx /= m; hubWy /= m
        }
        for (const [a, b] of tetherVizPairs(sample.tetherTopology, m)) {
          const ba = bullets[a]!
          const awx = ba.x, awy = ba.y                              // segment start (WORLD)
          const bwx = b === m ? hubWx : bullets[b]!.x               // segment end (WORLD)
          const bwy = b === m ? hubWy : bullets[b]!.y
          const ddx = bwx - awx, ddy = bwy - awy
          const len = Math.sqrt(ddx * ddx + ddy * ddy)
          if (len < 1) continue
          const ndx = ddx / len, ndy = ddy / len
          const projA = awx * ndx + awy * ndy                       // world projection of the endpoints
          const projB = projA + len
          // First dot at the next world-spacing multiple ≥ projA → dots locked to a fixed world grid.
          let proj = Math.ceil(projA / DOT_SPACING) * DOT_SPACING
          for (let count = 0; proj <= projB && count < 80; proj += DOT_SPACING, count++) {
            const s = proj - projA
            ctx.beginPath(); ctx.arc(awx + ndx * s - camX, awy + ndy * s - camY, dotR, 0, Math.PI * 2); ctx.fill()
          }
        }
      }
      ctx.globalCompositeOperation = prevComp
      ctx.globalCompositeOperation = prevComp
    }
  }

  // ── Bullets — tick + draw as small enemy-color glowing dots with a short fading trail.
  if (enemyBulletVizList.length > 0) {
    const simActive = getPhase() === 'playing' || getPhase() === 'designer'
    // Halo LOD — each bullet paints a big additive glow halo, the dominant overdraw in a swarm.
    // Full size at low counts (normal play looks identical); above HALO_FULL_BELOW the halos
    // shrink toward 45% (≈80% less fill each) since in a dense swarm individual halos blur into
    // one glowing mass anyway — the sharp arrowhead body still draws full-size, so bullets stay
    // readable. Size, not alpha: additive blend repaints every covered pixel regardless of alpha.
    const HALO_FULL_BELOW = 40
    const haloLod = enemyBulletVizList.length <= HALO_FULL_BELOW
      ? 1 : Math.max(0.45, HALO_FULL_BELOW / enemyBulletVizList.length)
    for (let i = enemyBulletVizList.length - 1; i >= 0; i--) {
      const b = enemyBulletVizList[i]!
      if (simActive) {
        b.elapsed += lastDt
        // Volley hold — bullet follows the enemy's LIVE position during stagger window.
        // Mirrors sim: re-anchor + surround velocity recompute at the release frame.
        if (!b.released) {
          if (b.owner) { b.x = b.owner.x + b.offX; b.y = b.owner.y + b.offY }
          if (b.elapsed < b.launchDelay) continue
          b.released = true
          if (b.isSurround) {
            const remaining = Math.max(0.05, b.lifetime - b.elapsed)
            b.vx = (b.surroundTargetX - b.x) / remaining
            b.vy = (b.surroundTargetY - b.y) / remaining
          }
        }
        // Tracking — mirrors the sim's tracking math so viz stays synced with sim
        if (b.trackingRate > 0) {
          const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
          if (speed > 0.01) {
            const curAng = Math.atan2(b.vy, b.vx)
            const desAng = Math.atan2(player.y - b.y, player.x - b.x)
            let delta = desAng - curAng
            if (delta > Math.PI) delta -= 2 * Math.PI
            else if (delta < -Math.PI) delta += 2 * Math.PI
            const maxTurn = b.trackingRate * lastDt
            if (delta > maxTurn) delta = maxTurn
            else if (delta < -maxTurn) delta = -maxTurn
            const newAng = curAng + delta
            b.vx = Math.cos(newAng) * speed
            b.vy = Math.sin(newAng) * speed
          }
        }
        if (b.staccato) {
          // Mirror the sim's staccato gate (same global beat + helper → stays locked, no data
          // passing). staccatoPop spikes to 1 on each hop and decays through the freeze → drives
          // the squash-stretch.
          if (b.staccatoReleased < 0) {
            b.staccatoFireBeat = getAbsoluteBeats()
            const detBeat = b.staccatoFireBeat + (b.lifetime - b.elapsed) / BEAT_SEC
            b.staccatoHops = Math.max(1, Math.floor((detBeat - STACCATO_LEAD - b.staccatoPhase) * b.staccatoDivision) - Math.floor((b.staccatoFireBeat - STACCATO_LEAD - b.staccatoPhase) * b.staccatoDivision))
            b.staccatoReleased = 0
          }
          const target = staccatoProgress(getAbsoluteBeats(), b.staccatoFireBeat, b.staccatoHops, b.staccatoDivision, b.staccatoPhase)
          const move = target - b.staccatoReleased
          if (move > 0) {
            b.x += b.vx * move * b.lifetime
            b.y += b.vy * move * b.lifetime
            b.staccatoReleased = target
            b.staccatoPop = 1   // re-trigger the pop on each snap
          }
          b.staccatoPop = Math.max(0, b.staccatoPop - lastDt * 7)   // decay over the freeze
        } else {
          b.x += b.vx * lastDt
          b.y += b.vy * lastDt
        }
      }
      if (b.elapsed >= b.lifetime) {
        enemyBulletVizList[i] = enemyBulletVizList[enemyBulletVizList.length - 1]!
        enemyBulletVizList.pop()
        continue
      }
      // Skip drawing while in volley hold — bullet is invisible during the stagger window.
      if (b.elapsed < b.launchDelay) continue
      const flightT = Math.min(1, b.elapsed / b.lifetime)
      const remainingFlight = b.lifetime - b.elapsed

      // Visual-only back-shift: the dart's BUTT sits at the sim pos and its tip leads forward, so the
      // explosion (at the true sim pos) reads at the dart's BACK. Nudge the whole visual back along
      // the heading so the explosion lands nearer the tip instead. Sim position + detonation point are
      // unchanged (they still use b.x/b.y) — this only moves where the dart/halo are drawn.
      const _bvspeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
      const BULLET_VIS_BACK = 9
      const _bvbx = _bvspeed > 1 ? (b.vx / _bvspeed) * BULLET_VIS_BACK : 0
      const _bvby = _bvspeed > 1 ? (b.vy / _bvspeed) * BULLET_VIS_BACK : 0
      const sx = b.x - _bvbx - camX
      const sy = b.y - _bvby - camY
      // Muzzle pop (#1) — bright flash + expanding ring at the LAUNCH point the instant the bullet
      // appears. muzzleX/Y captured on the first drawn frame (= release point) so it stays put as
      // the bullet flies off. bornT = time since the bullet became visible.
      const bornT = b.elapsed - b.launchDelay
      if (Number.isNaN(b.muzzleX)) { b.muzzleX = b.x; b.muzzleY = b.y }
      const MUZZLE_DUR = 0.16
      // Muzzle pop only for ENEMY-fired bullets — cluster children are "born" from a parent
      // bullet's detonation (which has its own split FX), so a muzzle flash there reads wrong.
      if (!b.isChild && bornT < MUZZLE_DUR) {
        const mt = 1 - bornT / MUZZLE_DUR        // 1 → 0
        const mx = b.muzzleX - camX, my = b.muzzleY - camY
        const prevComp = ctx.globalCompositeOperation
        ctx.globalCompositeOperation = 'lighter'
        // Soft flash (cached glow sprite), brightest at birth
        const flashSprite = getGlowSprite(Math.min(255, b.r + 80), Math.min(255, b.g + 80), Math.min(255, b.b + 80))
        const fdim = 215 * (0.6 + mt * 0.9)
        const prevA = ctx.globalAlpha
        ctx.globalAlpha = mt * mt * 0.95
        ctx.drawImage(flashSprite, mx - fdim / 2, my - fdim / 2, fdim, fdim)
        ctx.globalAlpha = prevA
        // Pointy starburst — sharp spikes shooting out from the launch point (alternating
        // long/short for a spiky star), tapering to points as they fade.
        ctx.strokeStyle = `rgba(${Math.min(255, b.r + 130)}, ${Math.min(255, b.g + 130)}, ${Math.min(255, b.b + 130)}, ${mt * 0.95})`
        ctx.lineCap = 'round'
        const SPIKES = 8
        const burst = 31 + (1 - mt) * 156
        for (let s = 0; s < SPIKES; s++) {
          const sa = (s / SPIKES) * Math.PI * 2
          const len = burst * (s % 2 === 0 ? 0.72 : 0.5)
          ctx.lineWidth = (5 * mt + 0.8) * (s % 2 === 0 ? 1 : 0.55)
          ctx.beginPath()
          ctx.moveTo(mx, my)
          ctx.lineTo(mx + Math.cos(sa) * len, my + Math.sin(sa) * len)
          ctx.stroke()
        }
        ctx.lineCap = 'butt'
        ctx.globalCompositeOperation = prevComp
      }
      // Beat-locked pulse — one cycle per beat, peaks ON beats (bullets fire on beats so
      // elapsed=0 is a beat boundary). 0.85–1.0 amplitude. Ties bullet to the game's rhythm.
      const beatPulse = 0.925 + 0.075 * Math.cos(b.elapsed / BEAT_SEC * Math.PI * 2)
      // Charge-grow — halo scales from 0.6× to 1.05× over flight (anticipation: "this is
      // gathering energy"). Capped so it doesn't get cartoonishly large.
      const chargeScale = 0.6 + 0.45 * flightT
      // Collapse phase — in the last ~110ms of flight the bullet visibly compresses toward
      // a point, selling the "destroyed" moment so the bullet→ring transition reads as
      // intentional rather than "the bullet just vanished." Halo shrinks harder than core
      // so the glow tightens around the tip before the ring explodes outward.
      const COLLAPSE_DUR = 0.11
      const collapseT = Math.max(0, 1 - remainingFlight / COLLAPSE_DUR)
      // Quadratic ease-in makes most of the shrink happen in the final ~50ms — punchier feel
      const collapseEase = collapseT * collapseT
      const collapseShrink = 1 - collapseEase * 0.88

      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      // The arrow's TIP is anchored to the bullet's sim position (sx, sy) — same point as
      // the halo center AND the eventual detonation. Body extends BEHIND the tip along the
      // velocity vector. This keeps the visual lead, halo, and explosion all at one point.
      const speedSq = b.vx * b.vx + b.vy * b.vy
      const coreBase = 13 * beatPulse * (1 - collapseEase * 0.7)
      // Halo — uses the cached glow sprite instead of per-frame radial gradient. Centered
      // on the bullet position (= the arrow tip = the detonation point). Sized to wrap the
      // arrow body without dominating the screen — too big and it reads as a haze behind
      // the leading tip rather than a glow attached to the bullet.
      const haloR = 36 * chargeScale * collapseShrink * beatPulse
      const haloSprite = getGlowSprite(b.r, b.g, b.b)
      const haloDim = haloR * 2.3 * haloLod   // shrink halos in a dense swarm (fill-rate win)
      ctx.globalAlpha = 0.7
      ctx.drawImage(haloSprite, sx - haloDim / 2, sy - haloDim / 2, haloDim, haloDim)
      ctx.globalAlpha = 1
      if (speedSq > 100) {
        const ang = Math.atan2(b.vy, b.vx)
        ctx.save()
        ctx.translate(sx, sy)
        ctx.rotate(ang)
        // Scale-in birth (#2) — the arrowhead is born small and stretches up to full size along
        // its heading over the first ~90ms, so it SHOOTS out instead of just appearing. Enemy-fired
        // bullets only — cluster children emerge from the split FX, not a muzzle.
        if (!b.isChild && bornT < 0.09) {
          const e = bornT / 0.09
          const ease = e * e * (3 - 2 * e)
          const grow = 0.3 + 0.7 * ease
          ctx.scale(grow * (1 + (1 - ease) * 0.9), grow)
        }
        // Staccato squash-stretch — on each hop the bullet stretches along its heading (a lunge
        // smear) and squashes perpendicular, then settles during the freeze. Sells the "snap".
        if (b.staccato && b.staccatoPop > 0) {
          ctx.scale(1 + b.staccatoPop * 0.6, 1 - b.staccatoPop * 0.28)
        }
        // Isoceles arrowhead — TIP anchored at (0,0) (= the bullet position = the halo
        // center = the eventual detonation point). Body extends BEHIND along -X.
        const triLen = coreBase * 2.4        // distance from tip to base
        const triHalfW = coreBase * 1.05     // half-width at the base
        // Burning FUSE = the dart's TAIL. A tapered wavy glow streaming back along -X whose
        // LENGTH = remaining time, so it visibly burns DOWN (gets shorter) and vanishes into the
        // butt exactly at detonation. Colour ticks WHITE (fresh) → BULLET COLOUR (about to blow),
        // so time-to-boom reads from both its length and its hue while staying in the bullet's
        // own palette (less visually noisy than a contrasting red). Time-based → right for any
        // travel + staccato. Drawn as a filled tapered ribbon (wide at dart, point at tip). Additive.
        {
          const fuse = 1 - Math.min(1, b.elapsed / b.lifetime)   // 1 fresh → 0 boom
          const fr = Math.round(b.r + (255 - b.r) * fuse)        // white (fresh) → bullet colour (boom)
          const fg = Math.round(b.g + (255 - b.g) * fuse)
          const fb = Math.round(b.b + (255 - b.b) * fuse)
          const headX = b.pushMode ? -triLen * 0.95 : 0          // root at the dart's BUTT (= sim pos = detonation); push rams root behind their tail
          const fuseLen = triLen * 2.13 * fuse                   // shrinks to 0 — the fuse burning down
          if (fuseLen > 1.5) {
            const SEG = 10
            const wob = b.trackingRate > 0 ? triHalfW * 0.38 : 0 // only TRACKING bullets wiggle; others trail straight
            const phase = b.elapsed * 9                          // wiggle travel speed
            const rootW = triHalfW * 0.55                        // tail half-width at the dart, tapers to a point
            const tipFrac = (1 - fuse) * 0.18                    // tapers to a POINT; swells just slightly as the fuse burns down
            // Length gradient — the HOT BURNING POINT sits at the free TIP and dims toward the
            // dart. As the fuse burns down the bright tip recedes inward, so the eye clearly sees
            // it getting shorter (a bright root would just sit still and read as a static blob).
            const grad = ctx.createLinearGradient(headX, 0, headX - fuseLen, 0)
            grad.addColorStop(0, `rgba(${fr}, ${fg}, ${fb}, 0.1)`)                                                                  // dim where it meets the dart
            grad.addColorStop(0.7, `rgba(${fr}, ${fg}, ${fb}, 0.45)`)
            grad.addColorStop(1, `rgba(${Math.min(255, fr + 50)}, ${Math.min(255, fg + 50)}, ${Math.min(255, fb + 50)}, 0.92)`)     // hot burning tip
            ctx.fillStyle = grad
            ctx.beginPath()
            // top edge: root → tip
            for (let s = 0; s <= SEG; s++) {
              const t = s / SEG
              const cx = headX - fuseLen * t
              const cy = Math.sin(phase + t * 7) * wob * t
              const w = rootW * (tipFrac + (1 - tipFrac) * (1 - t))          // wide at the dart, small nub at the burning tip
              if (s === 0) ctx.moveTo(cx, cy - w); else ctx.lineTo(cx, cy - w)
            }
            // bottom edge: tip → root
            for (let s = SEG; s >= 0; s--) {
              const t = s / SEG
              const cx = headX - fuseLen * t
              const cy = Math.sin(phase + t * 7) * wob * t
              const w = rootW * (tipFrac + (1 - tipFrac) * (1 - t))
              ctx.lineTo(cx, cy + w)
            }
            ctx.closePath()
            ctx.fill()
          }
        }
        ctx.lineJoin = 'round'
        if (b.pushMode) {
          // PUSH bullet — hollow, BLUNT-nosed "ram" with a cool rim: reads as SHOVE, not pierce.
          // Flat truncated nose at x=0 (still the detonation point), stroke-only (lighter look +
          // cheaper than a fill), faint interior. Rim blends the enemy color toward the push
          // white-cyan so you still know the source. A faint preview ring telegraphs the shove.
          const tipHalf = coreBase * 0.42   // blunt flat nose half-width (vs a sharp 0-width point)
          const rimR = Math.round(b.r * 0.35 + 210 * 0.65)
          const rimG = Math.round(b.g * 0.35 + 235 * 0.65)
          const rimB = Math.round(b.b * 0.35 + 255 * 0.65)
          ctx.lineCap = 'round'
          ctx.fillStyle = `rgba(${b.r}, ${b.g}, ${b.b}, 0.16)`
          ctx.beginPath()
          ctx.moveTo(0, tipHalf)
          ctx.lineTo(0, -tipHalf)
          ctx.lineTo(-triLen, -triHalfW)
          ctx.lineTo(-triLen, triHalfW)
          ctx.closePath()
          ctx.fill()
          ctx.strokeStyle = `rgba(${rimR}, ${rimG}, ${rimB}, 0.95)`
          ctx.lineWidth = 2.5
          ctx.stroke()
          // Preview ring around the bullet — telegraphs the incoming shove (rhymes with the
          // shock-push wave). Pulses DRAMATICALLY on the beat: radius, brightness, and thickness
          // all swing with a full-range beat envelope, so it visibly breathes/pings each beat.
          // ^1.5 sharpens the envelope so it snaps to the peak (more aggressive "ping" than a soft sine)
          const ringPulse = Math.pow(0.5 + 0.5 * Math.cos(b.elapsed / BEAT_SEC * Math.PI * 2), 1.5)   // 0..1, snappy peak on the beat
          ctx.strokeStyle = `rgba(${rimR}, ${rimG}, ${rimB}, ${0.1 + 0.72 * ringPulse})`
          ctx.lineWidth = 1.0 + 2.6 * ringPulse
          ctx.beginPath()
          ctx.arc(0, 0, coreBase * (1.3 + 1.1 * ringPulse), 0, Math.PI * 2)
          ctx.stroke()
          ctx.lineCap = 'butt'
        } else {
          // Dart with the BUTT at the origin (= sim pos = detonation point) and the pointed
          // tip leading FORWARD (+X). The fuse roots at the butt and burns into this point, so
          // the boom erupts right where the fuse ends.
          ctx.fillStyle = `rgba(${Math.min(255, b.r + 60)}, ${Math.min(255, b.g + 60)}, ${Math.min(255, b.b + 60)}, 0.62)`
          ctx.beginPath()
          ctx.moveTo(triLen, 0)
          ctx.lineTo(0, triHalfW)
          ctx.lineTo(0, -triHalfW)
          ctx.closePath()
          ctx.fill()
          // Soft outline — thinned + dimmed so the dart reads as a glow, not a hard solid block.
          ctx.strokeStyle = `rgba(${Math.min(255, b.r + 90)}, ${Math.min(255, b.g + 90)}, ${Math.min(255, b.b + 90)}, 0.4)`
          ctx.lineWidth = 1.4
          ctx.stroke()
          // Nose accent — small white-tinted disc SHIFTED BACK from the leading tip so its
          // forward edge ends right at the geometric tip. Toned down so it doesn't read as busy.
          // Explode-mode bullets FLASH the tip red (matching their fire-ember tail) so the volatile
          // read comes from the leading point too, not just the trailing particles. A fast strobe
          // (0..1) drives both a swell in radius and a lerp from the bullet hue toward danger-red.
          const tipAccentR = coreBase * (b.explode ? 0.37 + 0.18 * (0.5 + 0.5 * Math.sin(b.elapsed * 26)) : 0.36)
          if (b.explode) {
            const strobe = 0.5 + 0.5 * Math.sin(b.elapsed * 26)   // 0..1 fast flash
            let tr: number, tg: number, tb: number
            if (b.heal) {
              // WHITE-GOLD nourish strobe — biased bright toward white so it never reads as the
              // red/orange explode tip. Warm white at the trough, full white at the strobe peak.
              tr = 255
              tg = 235 + Math.round(20 * strobe)
              tb = 200 + Math.round(55 * strobe)
            } else {
              tr = Math.min(255, b.r + 100 + Math.round(155 * strobe))   // toward hot red
              tg = Math.round(Math.min(255, b.g + 90) * (1 - strobe * 0.7))
              tb = Math.round(Math.min(255, b.b + 90) * (1 - strobe * 0.7))
            }
            // Draw OVER the dart with normal compositing so the tint sits on top and reads as its
            // true color, instead of additively washing toward white against the bright bullet body.
            ctx.globalCompositeOperation = 'source-over'
            ctx.fillStyle = `rgba(${tr}, ${tg}, ${tb}, ${0.7 + 0.3 * strobe})`
            ctx.beginPath()
            ctx.arc(triLen - tipAccentR, 0, tipAccentR, 0, Math.PI * 2)
            ctx.fill()
            ctx.globalCompositeOperation = 'lighter'
          } else {
            ctx.fillStyle = `rgba(${Math.min(255, b.r + 140)}, ${Math.min(255, b.g + 140)}, ${Math.min(255, b.b + 140)}, 0.7)`
            ctx.beginPath()
            ctx.arc(triLen - tipAccentR, 0, tipAccentR, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        ctx.lineJoin = 'miter'
        ctx.restore()
      } else if (b.pushMode) {
        // Low-speed push (volley hold) — hollow cool ring, matching the in-flight "shove" read
        const rimR = Math.round(b.r * 0.35 + 210 * 0.65)
        const rimG = Math.round(b.g * 0.35 + 235 * 0.65)
        const rimB = Math.round(b.b * 0.35 + 255 * 0.65)
        ctx.fillStyle = `rgba(${b.r}, ${b.g}, ${b.b}, 0.16)`
        ctx.beginPath()
        ctx.arc(sx, sy, coreBase, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = `rgba(${rimR}, ${rimG}, ${rimB}, 0.9)`
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(sx, sy, coreBase, 0, Math.PI * 2)
        ctx.stroke()
      } else {
        // Low-speed fallback (volley release moment, no clear direction) — plain round core
        ctx.fillStyle = `rgba(${Math.min(255, b.r + 60)}, ${Math.min(255, b.g + 60)}, ${Math.min(255, b.b + 60)}, 0.95)`
        ctx.beginPath()
        ctx.arc(sx, sy, coreBase, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = `rgba(${Math.min(255, b.r + 80)}, ${Math.min(255, b.g + 80)}, ${Math.min(255, b.b + 80)}, 0.75)`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(sx, sy, coreBase + 3, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = prevComp

      // (Old per-frame spark trail removed — the burning fuse IS the dart's tail now, and the
      // continuously-replenished particle trail read as a second, non-shrinking tail under it.)

      // Explode-mode bullets emit the SAME volatile fire embers a volatile enemy gives off while
      // alive — rising hot orange embers — so the player reads "this one is going to BLOW." A
      // little bullet velocity is mixed in so the embers stream WITH the dart instead of stripping
      // straight off it. Only the visible, released bullet (not during volley hold) sheds embers.
      if (b.explode && simActive && b.released && b.elapsed >= b.launchDelay && Math.random() < 0.5) {
        const a = Math.random() * Math.PI * 2
        const ed = coreBase * (0.4 + Math.random() * 0.6)
        const tint = Math.random()
        if (b.heal) {
          // White-gold nourish motes — floatier + longer-lived than the fire embers, biased bright
          // toward WHITE (with a pale-gold glow tint) so the heal dart can never be mistaken for the
          // red/orange explode dart. Drifting up off the dart.
          spawnParticle(
            b.x + Math.cos(a) * ed, b.y + Math.sin(a) * ed,
            (Math.random() - 0.5) * 16 + b.vx * 0.06, -30 - Math.random() * 30 + b.vy * 0.06,
            255, 240 + Math.floor(tint * 15), 210 + Math.floor(tint * 45),
            0.28 + Math.random() * 0.18, 3 + Math.random() * 2.5,
            0, 255, 230, 170)
        } else {
          spawnParticle(
            b.x + Math.cos(a) * ed, b.y + Math.sin(a) * ed,
            (Math.random() - 0.5) * 22 + b.vx * 0.06, -24 - Math.random() * 34 + b.vy * 0.06,
            255, Math.floor(60 + tint * 80), Math.floor(tint * 30),
            0.15 + Math.random() * 0.12, 3 + Math.random() * 2.5)
        }
      }
    }
  }

  // ── Detonations — render via drawRing() so they use the SAME exploding visuals as a normal
  // enemy ring attack: expansion curve, cutting shards orbiting the rim at peak, red flash,
  // white-gold peak flash, all layered glows. Position is the bullet's landing point.
  if (enemyDetonationVizList.length > 0) {
    const simActive = getPhase() === 'playing' || getPhase() === 'designer'
    for (let i = enemyDetonationVizList.length - 1; i >= 0; i--) {
      const d = enemyDetonationVizList[i]!
      if (simActive) d.attackTimer += lastDt
      // Match the normal ring lifetime — drawRing internally clips visuals after expandTime +
      // ATTACK_LINGER_TIME. We prune slightly past that to be safe.
      if (d.attackTimer > d.expandTime + 0.20) {
        enemyDetonationVizList[i] = enemyDetonationVizList[enemyDetonationVizList.length - 1]!
        enemyDetonationVizList.pop()
        continue
      }
      drawRing(d.x, d.y, d.ring, d.attackTimer, d.ringRadius, d.expandTime, undefined, undefined, true)  // boldStart: readable from the start of growth
      // Kickstart accent — wraps drawRing's leading edge with extra brightness and thickness
      // for the first ~0.2s so the ring is visible from frame one. Critically: it tracks
      // drawRing's EXACT ease-out radius (1 - (1-t)^2), so as the accent fades the main ring
      // is at the same position — no perceived "snap back". Line width gets THICKER when
      // the ring radius is tiny (impact moment) so the impact reads even when the ring is
      // only a few pixels wide — this is the "destroyed too late" fix.
      const KICK_DUR = 0.20
      if (d.attackTimer < KICK_DUR && d.attackTimer >= 0) {
        const buildup = Math.min(d.attackTimer / d.expandTime, 1)
        const currentR = d.ringRadius * (1 - (1 - buildup) * (1 - buildup))
        if (currentR > 0.5) {
          const fade = 1 - d.attackTimer / KICK_DUR    // 1 → 0 over the kickstart window
          // Punch boost — extra thickness early in the kickstart so the very first frames
          // (when currentR is just a few px) have visible weight. Decays over the window.
          const punch = (1 - d.attackTimer / KICK_DUR) ** 2   // 1 → 0 with quadratic ease
          const cx = d.x - camX, cy = d.y - camY
          const prevComp = ctx.globalCompositeOperation
          ctx.globalCompositeOperation = 'lighter'
          // Wide soft outer accent in ring color
          ctx.strokeStyle = `rgba(${d.r}, ${d.g}, ${d.b}, ${fade * 0.55})`
          ctx.lineWidth = 7 + punch * 10
          ctx.beginPath(); ctx.arc(cx, cy, currentR, 0, Math.PI * 2); ctx.stroke()
          // Tight bright inner accent (white-tinted)
          ctx.strokeStyle = `rgba(${Math.min(255, d.r + 110)}, ${Math.min(255, d.g + 110)}, ${Math.min(255, d.b + 110)}, ${fade * 0.9})`
          ctx.lineWidth = 2.5 + punch * 4.5
          ctx.beginPath(); ctx.arc(cx, cy, currentR, 0, Math.PI * 2); ctx.stroke()
          ctx.globalCompositeOperation = prevComp
        }
      }
    }
  }

  // ── Cluster split FX — bright white-hot starburst (central flash + radial spokes).
  // Drawn AFTER detonations so spokes appear on top. Reads as "POP!" — visually distinct
  // from a normal kickstart ring so the player sees that this bullet just split.
  if (clusterSplitFXList.length > 0) {
    const simActive = getPhase() === 'playing' || getPhase() === 'designer'
    for (let i = clusterSplitFXList.length - 1; i >= 0; i--) {
      const f = clusterSplitFXList[i]!
      if (simActive) f.timer += lastDt
      if (f.timer >= CLUSTER_SPLIT_DUR) {
        clusterSplitFXList[i] = clusterSplitFXList[clusterSplitFXList.length - 1]!
        clusterSplitFXList.pop()
        continue
      }
      const t = f.timer / CLUSTER_SPLIT_DUR        // 0 → 1
      const fade = 1 - t
      const ease = 1 - (1 - t) * (1 - t)            // ease-out length growth
      const fcx = f.x - camX, fcy = f.y - camY
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      // Central white-hot flash — small bright disc, sells the impact moment
      const flashR = 8 + t * 12
      ctx.fillStyle = `rgba(255, 255, 255, ${fade * 0.85})`
      ctx.beginPath(); ctx.arc(fcx, fcy, flashR, 0, Math.PI * 2); ctx.fill()
      // Directional spokes — ONE per child bullet, pointing in that bullet's direction.
      // Wide colored underlay + bright white core. Reads as "this is the next salvo's
      // direction map."
      const spokeLen = 22 + ease * 56
      const inner = 6 + ease * 6       // gap from center so the flash isn't overdrawn
      ctx.lineCap = 'round'
      // Colored underlay first (wider, dimmer, in ring color)
      ctx.strokeStyle = `rgba(${Math.min(255, f.r + 80)}, ${Math.min(255, f.g + 80)}, ${Math.min(255, f.b + 80)}, ${fade * 0.7})`
      ctx.lineWidth = 7 * fade + 2
      for (let k = 0; k < f.angles.length; k++) {
        const a = f.angles[k]!
        const ca = Math.cos(a), sa = Math.sin(a)
        ctx.beginPath()
        ctx.moveTo(fcx + ca * inner, fcy + sa * inner)
        ctx.lineTo(fcx + ca * (inner + spokeLen), fcy + sa * (inner + spokeLen))
        ctx.stroke()
      }
      // Bright white core stripe down each spoke
      ctx.strokeStyle = `rgba(255, 255, 255, ${fade * 0.95})`
      ctx.lineWidth = 3 * fade + 1
      for (let k = 0; k < f.angles.length; k++) {
        const a = f.angles[k]!
        const ca = Math.cos(a), sa = Math.sin(a)
        ctx.beginPath()
        ctx.moveTo(fcx + ca * inner, fcy + sa * inner)
        ctx.lineTo(fcx + ca * (inner + spokeLen), fcy + sa * (inner + spokeLen))
        ctx.stroke()
      }
      ctx.lineCap = 'butt'
      ctx.globalCompositeOperation = prevComp
    }
  }
}
const LANCE_DURATION = 0.16   // discharge arc duration (~10 frames at 60fps)
const MUZZLE_DURATION = 0.10  // muzzle disc duration
// Module-level palette constants for dash-shot — hoisted out of the per-frame loop so we
// don't allocate fresh object literals every frame for the lifetime of every projectile.
const DASH_SHOT_PAL_GOLD = {
  bright: '255, 240, 180', mid: '255, 220, 130', deep: '255, 180, 60',
  accent: '255, 215, 64', core: '255, 255, 245', trail: '255, 240, 180', trailFade: '255, 220, 120',
} as const
const DASH_SHOT_PAL_REVERB = {
  bright: '215, 245, 255', mid: '130, 220, 255', deep: '60, 180, 255',
  accent: '64, 200, 255', core: '245, 255, 255', trail: '180, 240, 255', trailFade: '120, 215, 255',
} as const

export function addDashShotViz(x: number, y: number, vx: number, vy: number, targetRadius: number, lifetime: number, reverbMode: boolean, aftershock: boolean = false): void {
  dashShotVizList.push({
    x, y, vx, vy, targetRadius, elapsed: 0, lifetime,
    spawnX: x, spawnY: y,
    lanceTimer: LANCE_DURATION,
    muzzleTimer: MUZZLE_DURATION,
    reverbMode,
    aftershock,
  })
}

// Lightning burst — short-lived crackling discharge at a point. Used by Reverb (blue) and
// enemy push-mode detonations (ring color). Same arc vocabulary as the Bolt projectile.
interface LightningBurst { x: number; y: number; radius: number; timer: number; lifetime: number; r: number; g: number; b: number }
const lightningBursts: LightningBurst[] = []
const LIGHTNING_BURST_DURATION = 0.32
// Player Reverb's signature cyan-blue
export function triggerBlueLightning(x: number, y: number, radius: number): void {
  lightningBursts.push({ x, y, radius, timer: 0, lifetime: LIGHTNING_BURST_DURATION, r: 100, g: 200, b: 255 })
}
// Custom color — used by enemy push-mode detonations so the discharge matches the ring color
export function triggerColoredLightning(x: number, y: number, radius: number, r: number, g: number, b: number): void {
  lightningBursts.push({ x, y, radius, timer: 0, lifetime: LIGHTNING_BURST_DURATION, r, g, b })
}

// Beat-dash on-beat screen confirmation — fires the moment the player nails a beat dash. Two
// layered effects, both in screen space and tuned to be peripheral (no center obstruction):
//   1) Soft warm-gold vignette pulse around the edges (radial gradient — transparent center,
//      gold rim). Reads as the world briefly lit up. Heavy lifting.
//   2) Four small angular corner brackets that snap inward and fade out. HUD-style "lock"
//      accent — adds a hint of system-confirmed snap without committing to full HUD frame.
// Both share one timer + one trigger so the effects stay synced and cheap.
const BEAT_DASH_CONFIRM_DURATION = 0.60
let beatDashConfirmTimer = 0
// Pre-allocated buffers for the confirm brackets — avoids per-frame Array/Object allocations
// inside updateAndDrawBeatDashConfirm during the 0.6s flash on every on-beat dash.
// `dx/dy/phase` are static per-corner; `x/y` are recomputed each frame from current screen size.
const BRACKET_CORNERS_BUF: { x: number; y: number; dx: number; dy: number; phase: number }[] = [
  { x: 0, y: 0, dx:  1, dy:  1, phase: 0.0 },
  { x: 0, y: 0, dx: -1, dy:  1, phase: 1.3 },
  { x: 0, y: 0, dx:  1, dy: -1, phase: 2.7 },
  { x: 0, y: 0, dx: -1, dy: -1, phase: 4.1 },
]
const BRACKET_OFFS_BUF: { sx: number; sy: number }[] = [
  { sx: 0, sy: 0 }, { sx: 0, sy: 0 }, { sx: 0, sy: 0 }, { sx: 0, sy: 0 },
]
// Heal pulse — set whenever the player's HP increases, decays over HEAL_PULSE_DURATION so the
// gold heal halo stays visible long after the displayHp catch-up finishes. healPulseAmount
// tracks the SIZE of the heal so the halo intensity scales — a 1 HP heal is subtle, a 5 HP
// heal is the full bloom.
let healPulseRemain = 0
let healPulseAmount = 0
const HEAL_PULSE_DURATION = 0.55
// Hurt pulse — mirror of the heal pulse for taking damage: a breathing RED halo + radiating red
// dots. Set on HP DECREASE, decays over HURT_PULSE_DURATION.
let hurtPulseRemain = 0
let hurtPulseAmount = 0
const HURT_PULSE_DURATION = 0.5

// Ice embers — cool-color sparks that burst outward from the board rim when an on-beat dash
// registers. Contrasts the warm gold vignette (temperature split) and decelerates as it flies
// outward, fading. Cyan-dominant with white + pink tier mix to tie into the bracket palette.
interface Ember {
  x: number; y: number              // world coords
  vx: number; vy: number            // world units / sec
  life: number; lifetime: number
  size: number                      // base radius (px in world space — gets * z when drawn)
  tier: number                      // 0 = cyan, 1 = white, 2 = pink
}
const embers: Ember[] = []
const EMBER_COUNT = 140   // burst size — generous for a one-shot, decays fast

// Distance from arena center to its rim at the given angle. Proper per-shape geometry so the
// spawn point sits on the actual board edge (not inside it).
function arenaRimDistance(angle: number): number {
  const shape = getArenaShape()
  const cs = Math.abs(Math.cos(angle))
  const sn = Math.abs(Math.sin(angle))
  if (shape === 'circle' || shape === 'hex' || shape === 'polygon') return ARENA_RADIUS
  if (shape === 'pill') {
    // Capsule = horizontal stadium (two semicircular caps + straight top/bottom). A ray from
    // origin hits the flat top/bottom edge if its slope is steep enough, otherwise it hits a cap.
    // Branch condition: sn * PILL_HALF_W >= cs * PILL_R means the ray reaches y=PILL_R before
    // x=PILL_HALF_W → hits flat edge first. Else it enters the cap region.
    if (sn * PILL_HALF_W >= cs * PILL_R) {
      return PILL_R / Math.max(sn, 0.001)
    }
    // Cap hit: solve |t*(cs,sn) - (PILL_HALF_W, 0)|² = PILL_R²
    //   t² - 2 t cs PILL_HALF_W + (PILL_HALF_W² - PILL_R²) = 0
    //   t = cs * PILL_HALF_W + sqrt(PILL_R² - PILL_HALF_W² * sn²)
    const disc = PILL_R * PILL_R - PILL_HALF_W * PILL_HALF_W * sn * sn
    return cs * PILL_HALF_W + Math.sqrt(Math.max(0, disc))
  }
  if (shape === 'cross') {
    // Cross = union of two perpendicular rectangles (horizontal HE×HW + vertical HW×HE).
    // A point is in the cross while it's inside at least one rect — so the exit distance is
    // max(exit-from-horizontal-rect, exit-from-vertical-rect). At 45° both equal CROSS_HW/sin45°,
    // which lands at the concave inner corner (correct).
    const csC = cs > 0.001 ? 1 / cs : Infinity
    const snC = sn > 0.001 ? 1 / sn : Infinity
    const tH = Math.min(CROSS_HE * csC, CROSS_HW * snC)
    const tV = Math.min(CROSS_HW * csC, CROSS_HE * snC)
    return Math.max(tH, tV)
  }
  // default rect
  const halfW = ARENA_W / 2, halfH = ARENA_H / 2
  const tx = cs > 0.001 ? halfW / cs : Infinity
  const ty = sn > 0.001 ? halfH / sn : Infinity
  return Math.min(tx, ty)
}

function spawnEmberBurst(): void {
  for (let i = 0; i < EMBER_COUNT; i++) {
    const angle = Math.random() * Math.PI * 2
    const r = arenaRimDistance(angle)
    const cx = Math.cos(angle), sn = Math.sin(angle)
    const spawnX = ARENA_CX + cx * r
    const spawnY = ARENA_CY + sn * r
    // Outward velocity with a small tangential jitter so they don't fan in perfect radial lines.
    // Aggressive speed so they really shoot out fast — combined with very light drag (below in
    // tickAndDrawEmbers) they sail across the screen before the lifetime fade catches them.
    const speed = 490 + Math.random() * 560
    const tangentJitter = (Math.random() - 0.5) * 0.45   // ±0.225 rad of off-axis spread
    const va = angle + tangentJitter
    const vx = Math.cos(va) * speed
    const vy = Math.sin(va) * speed
    const lifetime = 0.55 + Math.random() * 0.75
    const tierRoll = Math.random()
    const tier = tierRoll < 0.65 ? 0 : tierRoll < 0.90 ? 1 : 2   // 65% cyan, 25% white, 10% pink
    const size = 1.6 + Math.random() * 2.4
    embers.push({ x: spawnX, y: spawnY, vx, vy, life: 0, lifetime, size, tier })
  }
}

export function triggerBeatDashConfirm(): void {
  beatDashConfirmTimer = BEAT_DASH_CONFIRM_DURATION
  spawnEmberBurst()
  // Punch the arena border so its pulse + waveform read THROUGH the warm-gold flash. Boost
  // is additive to the regular beat pulse, decays each frame in drawArenaBorder.
  beatDashBorderBoost = 1.0
  // Also spike borderWaveIntensity directly so the waveform line gets a guaranteed strong
  // crest right now (don't wait for the normal ring-peak ramp), capped by max-with-current
  // so we never weaken an in-flight wave.
  if (1.30 > borderWaveIntensity) borderWaveIntensity = 1.30
}

// Tick + draw ember particles. Caller is responsible for setting globalCompositeOperation =
// 'lighter' if additive blending is desired (drawn during the main flash) — drawEmbersOnly
// (below) handles that for the standalone post-flash case.
function tickAndDrawEmbers(dt: number): void {
  if (embers.length === 0) return
  const isZoomedDesignerE = designerZoomedOut && getPhase() === 'designer'
  const zE = isZoomedDesignerE ? DESIGNER_ZOOM : cameraZoom
  for (let i = embers.length - 1; i >= 0; i--) {
    const e = embers[i]!
    e.life += dt
    if (e.life >= e.lifetime) {
      embers[i] = embers[embers.length - 1]!
      embers.pop()
      continue
    }
    // Outward decel via exponential drag. Very light drag (~7% velocity decay per second) so
    // the sparks keep almost all their momentum and rocket out across the screen before fading.
    const drag = Math.pow(0.88, dt)
    e.vx *= drag
    e.vy *= drag
    e.x += e.vx * dt
    e.y += e.vy * dt
    // Quick fade-in (first 10% of life), long ease-out
    const lt = e.life / e.lifetime
    const fadeIn = Math.min(1, lt / 0.10)
    const fadeOut = Math.pow(1 - lt, 1.6)
    const alpha = fadeIn * fadeOut
    if (alpha <= 0.01) continue
    const sx = (e.x - camX) * zE
    const sy = (e.y - camY) * zE
    const r = e.size * zE * (1 + lt * 0.5)
    // All three tiers are now pink variations — hot pink dominant, light pink + deep magenta
    // for tonal variety so the burst reads as pink without being monotone.
    let coreR = 255, coreG = 200, coreB = 235
    let glowR = 255, glowG = 110, glowB = 200
    if (e.tier === 0) {
      // Hot pink — main color
      coreR = 255; coreG = 180; coreB = 220
      glowR = 255; glowG = 80;  glowB = 190
    } else if (e.tier === 1) {
      // Soft pink-white — bright highlight
      coreR = 255; coreG = 230; coreB = 245
      glowR = 255; glowG = 170; glowB = 215
    } else {
      // Deep magenta — saturated accent
      coreR = 255; coreG = 150; coreB = 210
      glowR = 230; glowG = 50;  glowB = 170
    }
    // Cached glow sprite for the halo — was allocating a fresh CanvasGradient per ember per
    // frame (up to 140 allocations/frame at peak). Now just `drawImage` of a pre-rendered
    // sprite keyed by tier color. globalAlpha controls per-ember intensity. Visual matches
    // the old gradient closely; only 3 distinct sprites get cached (one per tier).
    const haloR = r * 4.5
    const sprite = getGlowSprite(glowR, glowG, glowB)
    const dim = haloR * 2
    const prevAlpha = ctx.globalAlpha
    ctx.globalAlpha = prevAlpha * Math.min(1, alpha * 1.4)
    ctx.drawImage(sprite, sx - dim / 2, sy - dim / 2, dim, dim)
    ctx.globalAlpha = prevAlpha
    // Bright core dot — kept as a solid fill (no gradient, cheap)
    ctx.fillStyle = `rgba(${coreR}, ${coreG}, ${coreB}, ${0.95 * alpha})`
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fill()
  }
}

// Standalone ember pass — used when the vignette flash has expired but embers are still alive.
// Sets up the additive blend itself since we're not inside the main confirm function's setup.
function drawEmbersOnly(dt: number): void {
  if (embers.length === 0) return
  const prevComp = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'lighter'
  tickAndDrawEmbers(dt)
  ctx.globalCompositeOperation = prevComp
}
function updateAndDrawBeatDashConfirm(dt: number): void {
  // Embers may outlast the vignette flash — keep ticking them even when the timer is dead.
  // Tick + draw them in their own pass before returning if the main flash is over.
  if (beatDashConfirmTimer <= 0 && embers.length === 0) return
  if (beatDashConfirmTimer > 0) {
    beatDashConfirmTimer -= dt
  }
  if (beatDashConfirmTimer <= 0 && embers.length > 0) {
    drawEmbersOnly(dt)
    return
  }
  if (beatDashConfirmTimer <= 0) return
  const t = beatDashConfirmTimer / BEAT_DASH_CONFIRM_DURATION   // 1 → 0
  // Envelope — single smooth peak, no flicker. progress runs 0→1 over the lifetime.
  //   Attack:  ease-out ramp up to full over the first 10% of duration (~60ms at 0.6s)
  //   Decay:   gentler ease-out fade to zero over the remaining 90% — exponent 1.5 lingers
  //            longer in the mid-tail than 2.2 did, so the fade feels smooth and warm.
  // Multiplied together: at peak (progress=0.10) attack=1 AND decay=1, so env=1.
  const progress = 1 - t
  const attackT = Math.min(1, progress / 0.10)
  const attack = 1 - Math.pow(1 - attackT, 2)
  const decayProg = Math.max(0, (progress - 0.10) / 0.90)
  const decay = Math.pow(1 - decayProg, 1.5)
  const env = attack * decay
  const prevComp = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'lighter'

  // (1) Vignette — bright warm-gold radial glow ONLY outside the arena board. We clip the draw
  // to (full screen) MINUS (arena shape in screen space) so the play area stays untouched and
  // the flash reads as the world around the board lighting up. With the board covering the
  // vignette inside its bounds, we can let the gradient be uniformly bright — no inner falloff
  // needed since the board itself handles "no light on play area."
  {
    const cx = width * 0.5
    const cy = height * 0.5
    const outerR = Math.hypot(cx, cy)            // distance to corner
    // Map arena world-space bounds to screen space (the world-transform has been restored to
    // identity by this point; we apply the zoom manually). Designer zoom-out path uses
    // DESIGNER_ZOOM; everything else uses cameraZoom.
    const isZoomedDesigner = designerZoomedOut && getPhase() === 'designer'
    const z = isZoomedDesigner ? DESIGNER_ZOOM : cameraZoom
    ctx.save()
    // Cache vertex arrays for shapes that need them, so the rim-stroke pass below can reuse
    // them instead of calling getHexVertices/getCrossVertices a second time.
    const shape = getArenaShape()
    let cachedHexVerts: { x: number; y: number }[] | null = null
    let cachedCrossVerts: { x: number; y: number }[] | null = null
    // Build the clip path: outer rect (full screen) + inner shape (arena). With evenodd fill
    // rule on the clip, the area INSIDE the arena is excluded — only the outside gets painted.
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
    if (shape === 'circle') {
      ctx.arc((ARENA_CX - camX) * z, (ARENA_CY - camY) * z, ARENA_RADIUS * z, 0, Math.PI * 2)
    } else if (shape === 'hex' || shape === 'polygon') {
      cachedHexVerts = arenaConvexVerts()
      ctx.moveTo((cachedHexVerts[0]!.x - camX) * z, (cachedHexVerts[0]!.y - camY) * z)
      for (let i = 1; i < cachedHexVerts.length; i++) {
        ctx.lineTo((cachedHexVerts[i]!.x - camX) * z, (cachedHexVerts[i]!.y - camY) * z)
      }
      ctx.closePath()
    } else if (shape === 'cross') {
      cachedCrossVerts = getCrossVertices(ARENA_CX, ARENA_CY)
      ctx.moveTo((cachedCrossVerts[0]!.x - camX) * z, (cachedCrossVerts[0]!.y - camY) * z)
      for (let i = 1; i < cachedCrossVerts.length; i++) {
        ctx.lineTo((cachedCrossVerts[i]!.x - camX) * z, (cachedCrossVerts[i]!.y - camY) * z)
      }
      ctx.closePath()
    } else if (shape === 'pill') {
      // Pill = capsule (two semicircular caps + straight top/bottom). Tracing the ACTUAL outline
      // (not the bounding rect) so the right-angle corner spaces between the rounded caps and
      // the screen corners get flashed. Was previously bounding-rect — those corners ended up
      // inside the clip exclusion, leaving the flash with visible gaps at the curve corners.
      const cyP = (ARENA_CY - camY) * z
      const xL = (ARENA_CX - PILL_HALF_W - camX) * z
      const xR = (ARENA_CX + PILL_HALF_W - camX) * z
      const rP = PILL_R * z
      ctx.moveTo(xL, cyP - rP)
      ctx.lineTo(xR, cyP - rP)
      ctx.arc(xR, cyP, rP, -Math.PI / 2, Math.PI / 2)
      ctx.lineTo(xL, cyP + rP)
      ctx.arc(xL, cyP, rP, Math.PI / 2, Math.PI * 1.5)
      ctx.closePath()
    } else {
      // Default rect arena
      ctx.rect(-camX * z, -camY * z, ARENA_W * z, ARENA_H * z)
    }
    ctx.clip('evenodd')
    // Flat-ish fill so the alpha is uniform across the entire outside-the-board region —
    // the flash sits flush right against the curve edge (not dimmer near the curve like a
    // center-anchored radial gradient would be). Tiny gradient just for visual richness, not
    // for falloff: center is 0.80, corners are 0.82 — essentially uniform.
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, outerR)
    g.addColorStop(0, `rgba(255, 220, 115, ${0.80 * env})`)
    g.addColorStop(1, `rgba(255, 200, 95, ${0.82 * env})`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, width, height)

    // Inner rim accent — bright stroke traced along the OUTSIDE of the arena curve, so the
    // flash reads as a glowing border hugging the board. Still inside the same clip (which
    // excludes the arena interior) so the stroke only paints on the outside-the-curve side.
    ctx.strokeStyle = `rgba(255, 245, 200, ${0.70 * env})`
    ctx.lineWidth = 6
    ctx.beginPath()
    if (shape === 'circle') {
      ctx.arc((ARENA_CX - camX) * z, (ARENA_CY - camY) * z, ARENA_RADIUS * z, 0, Math.PI * 2)
    } else if (shape === 'hex' || shape === 'polygon') {
      const verts = cachedHexVerts ?? arenaConvexVerts()
      ctx.moveTo((verts[0]!.x - camX) * z, (verts[0]!.y - camY) * z)
      for (let i = 1; i < verts.length; i++) {
        ctx.lineTo((verts[i]!.x - camX) * z, (verts[i]!.y - camY) * z)
      }
      ctx.closePath()
    } else if (shape === 'cross') {
      const verts = cachedCrossVerts ?? getCrossVertices(ARENA_CX, ARENA_CY)
      ctx.moveTo((verts[0]!.x - camX) * z, (verts[0]!.y - camY) * z)
      for (let i = 1; i < verts.length; i++) {
        ctx.lineTo((verts[i]!.x - camX) * z, (verts[i]!.y - camY) * z)
      }
      ctx.closePath()
    } else if (shape === 'pill') {
      const cyP = (ARENA_CY - camY) * z
      const xL = (ARENA_CX - PILL_HALF_W - camX) * z
      const xR = (ARENA_CX + PILL_HALF_W - camX) * z
      const rP = PILL_R * z
      ctx.moveTo(xL, cyP - rP)
      ctx.lineTo(xR, cyP - rP)
      ctx.arc(xR, cyP, rP, -Math.PI / 2, Math.PI / 2)
      ctx.lineTo(xL, cyP + rP)
      ctx.arc(xL, cyP, rP, Math.PI / 2, Math.PI * 1.5)
      ctx.closePath()
    } else {
      ctx.rect(-camX * z, -camY * z, ARENA_W * z, ARENA_H * z)
    }
    ctx.stroke()
    ctx.restore()
  }

  // (1.5) Ice embers — cool sparks bursting outward from the board rim.
  tickAndDrawEmbers(dt)

  // (2) Corner brackets — L-shaped angular accents at each corner. Hot magenta (true yellow-
  // contrast pink) outer glow, golden core, white-hot inner streak. Shake combines:
  //   - Outward impact punch:  corners blast OUTWARD toward the edge on trigger, decaying in
  //                             ~60ms — gives a directional "kick" rather than aimless jitter.
  //   - Sine-based rumble:     two-axis ~16Hz oscillation with per-corner phase offsets, so the
  //                             corners shake independently (not in lockstep). Decays with env^0.65
  //                             so the shake persists into the fade tail instead of dying instantly.
  //   - Small random spice:    tiny per-frame jitter on top of the sine for organic chaos.
  // All three pinkglow/yellow/white-streak passes share the SAME computed offsets per corner so
  // the colors stay aligned (no rainbow ghosting).
  {
    const margin = 58                                                  // distance from screen edge — pulled inward toward middle
    const armLen = 72 + (1 - env) * 16                                 // 2× bigger — arms reach further into the screen
    const baseW = 12 + env * 5                                         // 2× thicker base
    ctx.lineCap = 'round'
    // Per-frame static corner data — reuses BRACKET_CORNERS_BUF (module-level) so we don't
    // allocate 4 fresh object literals every frame for the lifetime of every confirm flash.
    BRACKET_CORNERS_BUF[0]!.x = margin;         BRACKET_CORNERS_BUF[0]!.y = margin
    BRACKET_CORNERS_BUF[1]!.x = width - margin; BRACKET_CORNERS_BUF[1]!.y = margin
    BRACKET_CORNERS_BUF[2]!.x = margin;         BRACKET_CORNERS_BUF[2]!.y = height - margin
    BRACKET_CORNERS_BUF[3]!.x = width - margin; BRACKET_CORNERS_BUF[3]!.y = height - margin
    const corners = BRACKET_CORNERS_BUF
    // ── Shake math ──
    // shakePhase: ~12Hz oscillation driver. Calmer than before so the rumble reads as polish,
    // not chaos. progress×30 over 0.6s gives ~4.8 full cycles.
    const shakePhase = progress * 30
    // Amplitude curve: pow(env, 0.6) decays slower than env, so the rumble lingers into the
    // fade tail. 5.5px peak (down from 9px) — readable shake without overwhelming the brackets.
    const shakeAmp = Math.pow(env, 0.6) * 5.5
    // Impact punch: outward shove right at trigger, decays in ~60ms (first 10% of life).
    // 9px kick (down from 14px) — still feels like a hit without being a jolt.
    const punchT = Math.max(0, 1 - progress / 0.10)
    const punchOut = Math.pow(punchT, 1.8) * 9
    // Per-corner computed shake offsets — writes into BRACKET_OFFS_BUF (module-level) instead
    // of allocating a fresh array via .map() each frame.
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i]!
      const off = BRACKET_OFFS_BUF[i]!
      off.sx = Math.cos(shakePhase + c.phase) * shakeAmp
             + Math.cos(shakePhase * 2.3 + c.phase * 1.7) * shakeAmp * 0.25
             + (Math.random() - 0.5) * shakeAmp * 0.25
             - c.dx * punchOut
      off.sy = Math.sin(shakePhase * 1.3 + c.phase * 1.4) * shakeAmp
             + Math.sin(shakePhase * 2.1 + c.phase) * shakeAmp * 0.25
             + (Math.random() - 0.5) * shakeAmp * 0.25
             - c.dy * punchOut
    }
    const offs = BRACKET_OFFS_BUF

    // Build the bracket geometry ONCE (4 corners × 2 arms = 8 line subpaths), then stroke 5
    // times with different styles. Canvas2D persists the current path between draw calls,
    // saving 4× per-pass overhead (4 beginPath/moveTo/lineTo iterations per pass × 5 passes
    // collapses to 1 path setup + 5 strokes).
    ctx.beginPath()
    for (let i = 0; i < corners.length; i++) {
      const c = corners[i]!, o = offs[i]!
      const cx = c.x + o.sx, cy = c.y + o.sy
      ctx.moveTo(cx, cy); ctx.lineTo(cx + c.dx * armLen, cy)
      ctx.moveTo(cx, cy); ctx.lineTo(cx, cy + c.dy * armLen)
    }

    // Pass 1a — ice-blue outermost glow (wide, soft). Cold cyan halo contrasts the warm gold
    // vignette behind it — temperature split reads as "the world chilled around the impact."
    ctx.strokeStyle = `rgba(120, 200, 255, ${env * 0.18})`
    ctx.lineWidth = baseW * 3.6
    ctx.stroke()
    // Pass 1b — ice mid halo (slightly more saturated cyan)
    ctx.strokeStyle = `rgba(90, 180, 245, ${env * 0.45})`
    ctx.lineWidth = baseW * 2.2
    ctx.stroke()
    // Pass 1c — pink accent stripe between the cyan halo and the white core. With additive
    // 'lighter' the overlap with cyan blends toward a soft lavender-cool-pink.
    ctx.strokeStyle = `rgba(255, 90, 200, ${env * 0.72})`
    ctx.lineWidth = baseW * 1.65
    ctx.stroke()
    // Pass 2 — cool-white core stroke (near-white with a faint blue tint)
    ctx.strokeStyle = `rgba(220, 240, 255, ${env * 0.95})`
    ctx.lineWidth = baseW
    ctx.stroke()
    // Pass 3 — pure white inner streak
    ctx.strokeStyle = `rgba(255, 255, 255, ${env * 0.9})`
    ctx.lineWidth = Math.max(1.5, baseW * 0.45)
    ctx.stroke()
    ctx.lineCap = 'butt'
  }

  ctx.globalCompositeOperation = prevComp
}
function updateAndDrawLightningBursts(dt: number): void {
  if (lightningBursts.length === 0) return
  const simActive = getPhase() === 'playing' || getPhase() === 'designer'
  // Adaptive scaling — when many bursts are live at once (cluster + volley push detonations),
  // per-burst arc work is the dominant cost. Total arc budget across all bursts is bounded;
  // each burst gets its proportional slice. Segments per arc + inner-streak pass also drop
  // when bursts are dense so individual bursts stay readable but the frame stays cheap.
  const burstCount = lightningBursts.length
  const ARC_BUDGET_TOTAL = 80
  const arcBudgetPerBurst = Math.floor(ARC_BUDGET_TOTAL / Math.max(1, burstCount))
  const segments = burstCount > 8 ? 4 : burstCount > 4 ? 5 : 6
  const drawInner = burstCount <= 5
  for (let i = lightningBursts.length - 1; i >= 0; i--) {
    const b = lightningBursts[i]!
    if (simActive) b.timer += dt
    if (b.timer >= b.lifetime) {
      lightningBursts[i] = lightningBursts[lightningBursts.length - 1]!
      lightningBursts.pop()
      continue
    }
    const t = b.timer / b.lifetime
    const peakCurve = Math.sin(t * Math.PI)   // 0 → 1 → 0, peaks mid-burst
    const bsx = b.x - camX
    const bsy = b.y - camY
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    // Central flash bloom — uses a per-color cached sprite drawn via drawImage instead of
    // allocating a fresh radial gradient every frame. globalAlpha applies the peakCurve.
    const flashR = b.radius * 0.45 * peakCurve
    if (flashR > 2) {
      const sprite = getLightningCoreSprite(b.r, b.g, b.b)
      const drawDim = flashR * 1.6 * 2   // sprite has radius LIGHTNING_CORE_R; scale to flashR*1.6
      ctx.globalAlpha = peakCurve
      ctx.drawImage(sprite, bsx - drawDim / 2, bsy - drawDim / 2, drawDim, drawDim)
      ctx.globalAlpha = 1
    }
    // Crackling arcs — count drops as more bursts pile up so the frame budget stays bounded.
    const fullArcCount = 12 + Math.floor(peakCurve * 10)
    const arcCount = Math.max(4, Math.min(fullArcCount, arcBudgetPerBurst))
    const arcR = b.r, arcG = b.g, arcB = b.b
    const tintR = Math.min(255, arcR + 90)
    const tintG = Math.min(255, arcG + 35)
    const tintB = Math.min(255, arcB + 0)
    const radius = b.radius
    const jitter = radius * 0.06
    for (let a = 0; a < arcCount; a++) {
      const angle = Math.random() * Math.PI * 2
      const lenMult = 0.55 + Math.random() * 0.45
      const tipX = bsx + Math.cos(angle) * radius * lenMult
      const tipY = bsy + Math.sin(angle) * radius * lenMult
      const dxA = tipX - bsx, dyA = tipY - bsy
      const plen = Math.sqrt(dxA * dxA + dyA * dyA)
      const pnx = plen > 0.01 ? -dyA / plen : 0
      const pny = plen > 0.01 ?  dxA / plen : 0
      ctx.beginPath()
      ctx.moveTo(bsx, bsy)
      for (let s = 1; s < segments; s++) {
        const ts = s / segments
        const j = (Math.random() - 0.5) * 2 * jitter
        ctx.lineTo(bsx + dxA * ts + pnx * j, bsy + dyA * ts + pny * j)
      }
      ctx.lineTo(tipX, tipY)
      const arcAlpha = (0.5 + Math.random() * 0.4) * peakCurve
      ctx.strokeStyle = `rgba(${tintR}, ${tintG}, ${tintB}, ${arcAlpha})`
      ctx.lineWidth = 1.2 + Math.random() * 1.6
      ctx.stroke()
      // Hot white inner streak — skipped when many bursts are active
      if (drawInner && Math.random() < 0.45) {
        ctx.strokeStyle = `rgba(255, 255, 250, ${arcAlpha * 0.6})`
        ctx.lineWidth = 0.6
        ctx.stroke()
      }
    }
    ctx.globalCompositeOperation = prevComp
  }
}

// Tether beams — multi-layered glow + bright core + peak white-gold flash + tangential
// cutting-shard particles racing along each beam, matching the ring-blade vocabulary used
// at ring peak. Lifetime is short (TETHER_VIZ_DUR) — flash, then fade.
function updateAndDrawTethers(_dt: number): void {
  if (tetherVizList.length === 0) return
  const simActive = getPhase() === 'playing' || getPhase() === 'designer'
  for (let i = tetherVizList.length - 1; i >= 0; i--) {
    const t = tetherVizList[i]!
    const elapsed = tetherClock - t.bornTime   // shared sim clock — locked to the sim strike, no framerate drift
    // Red BAR telegraph — push to the dead-last overlay RING_SNAP_LEAD before the strike (elapsed
    // reaches prearmTime), the line analogue of the ring's red snap. Fires once as it crosses.
    if (elapsed >= t.prearmTime - TETHER_SNAP_LEAD && elapsed - _dt < t.prearmTime - TETHER_SNAP_LEAD) {
      pushTetherSnap(t.xs, t.ys, t.topology, t.width)
    }
    // Pre-arm phase — draw a PULSING WARNING (red dashed lines) at the tether's landing
    // positions so the player keeps reading "the geometry is coming" instead of seeing the
    // flight preview vanish and nothing for half a second. Alpha + thickness build over the
    // prearm, with a beat-rate sine pulse for the danger feel.
    if (elapsed < t.prearmTime) {
      if (t.prearmTime > 0.001) {
        const u = elapsed / t.prearmTime              // 0 → 1 over prearm
        const pulse = 0.7 + 0.3 * Math.sin(elapsed * 18)   // ~3 Hz pulse for urgency
        const alpha = (0.40 + 0.55 * u) * pulse
        const n = t.xs.length
        let hubWx = 0, hubWy = 0
        if (t.topology === 'star') {
          for (let k = 0; k < n; k++) { hubWx += t.xs[k]!; hubWy += t.ys[k]! }
          hubWx /= n; hubWy /= n
        }
        const prevCompW = ctx.globalCompositeOperation
        ctx.globalCompositeOperation = 'lighter'
        ctx.setLineDash([6, 6])
        // Wide soft halo (danger red — slightly tinted)
        ctx.strokeStyle = `rgba(255, 50, 50, ${alpha * 0.55})`
        ctx.lineWidth = (t.width * 0.55) + 3.5 + u * 1.5   // red prearm telegraph +1px
        for (const [a, b] of tetherVizPairs(t.topology, n)) {
          const ax = t.xs[a]! - camX, ay = t.ys[a]! - camY
          const bx = b === n ? hubWx - camX : t.xs[b]! - camX
          const by = b === n ? hubWy - camY : t.ys[b]! - camY
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
        }
        // Tight bright core (saturated red into white-ish at peak pulse)
        ctx.strokeStyle = `rgba(255, ${Math.floor(80 + (1 - pulse) * 50)}, ${Math.floor(80 + (1 - pulse) * 50)}, ${alpha})`
        ctx.lineWidth = Math.max(3, t.width * 0.5 + 1)   // red prearm telegraph core +1px
        for (const [a, b] of tetherVizPairs(t.topology, n)) {
          const ax = t.xs[a]! - camX, ay = t.ys[a]! - camY
          const bx = b === n ? hubWx - camX : t.xs[b]! - camX
          const by = b === n ? hubWy - camY : t.ys[b]! - camY
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
        }
        ctx.setLineDash([])
        ctx.globalCompositeOperation = prevCompW
      }
      continue
    }
    const effective = elapsed - t.prearmTime
    if (effective >= TETHER_VIZ_DUR) {
      tetherVizList[i] = tetherVizList[tetherVizList.length - 1]!
      tetherVizList.pop()
      continue
    }
    const u = effective / TETHER_VIZ_DUR  // 0 → 1
    const fade = 1 - u                    // 1 → 0
    const peakFlash = Math.max(0, 1 - u / 0.25)  // bright white-gold in the first ~25%
    const baseAlpha = 0.35 + 0.55 * fade  // strong at start, fades
    const w = t.width
    const n = t.xs.length
    // Hub position for star topology — centroid in WORLD space (camera applied per-stroke).
    let hubWx = 0, hubWy = 0
    if (t.topology === 'star') {
      for (let k = 0; k < n; k++) { hubWx += t.xs[k]!; hubWy += t.ys[k]! }
      hubWx /= n; hubWy /= n
    }
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    // Three-pass stroke layering mirrors drawRing's outer-glow + mid-glow + main-ring stack.
    // Pass 1 — soft outer glow (wide, low alpha)
    ctx.strokeStyle = `rgba(${t.r}, ${t.g}, ${t.b}, ${baseAlpha * 0.18})`
    ctx.lineWidth = w * 2.8 + 4
    for (const [a, b] of tetherVizPairs(t.topology, n)) {
      const ax = t.xs[a]! - camX, ay = t.ys[a]! - camY
      const bx = b === n ? hubWx - camX : t.xs[b]! - camX
      const by = b === n ? hubWy - camY : t.ys[b]! - camY
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    }
    // Pass 2 — mid glow (medium width)
    ctx.strokeStyle = `rgba(${t.r}, ${t.g}, ${t.b}, ${baseAlpha * 0.45})`
    ctx.lineWidth = w * 1.5 + 2
    for (const [a, b] of tetherVizPairs(t.topology, n)) {
      const ax = t.xs[a]! - camX, ay = t.ys[a]! - camY
      const bx = b === n ? hubWx - camX : t.xs[b]! - camX
      const by = b === n ? hubWy - camY : t.ys[b]! - camY
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    }
    // Pass 3 — sharp core stroke (ring color, full alpha)
    ctx.strokeStyle = `rgba(${t.r}, ${t.g}, ${t.b}, ${Math.min(1, baseAlpha * 1.4)})`
    ctx.lineWidth = w
    for (const [a, b] of tetherVizPairs(t.topology, n)) {
      const ax = t.xs[a]! - camX, ay = t.ys[a]! - camY
      const bx = b === n ? hubWx - camX : t.xs[b]! - camX
      const by = b === n ? hubWy - camY : t.ys[b]! - camY
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    }
    // Peak white-gold flash — bright unmissable highlight for the first ~25%, fades fast.
    if (peakFlash > 0) {
      // Wide hot halo
      ctx.strokeStyle = `rgba(255, 220, 100, ${peakFlash * 0.45})`
      ctx.lineWidth = w * 2.2 + 1
      for (const [a, b] of tetherVizPairs(t.topology, n)) {
        const ax = t.xs[a]! - camX, ay = t.ys[a]! - camY
        const bx = b === n ? hubWx - camX : t.xs[b]! - camX
        const by = b === n ? hubWy - camY : t.ys[b]! - camY
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
      }
      // Bright white core
      ctx.strokeStyle = `rgba(255, 255, 255, ${peakFlash * 0.95})`
      ctx.lineWidth = Math.max(1.5, w * 0.5)
      for (const [a, b] of tetherVizPairs(t.topology, n)) {
        const ax = t.xs[a]! - camX, ay = t.ys[a]! - camY
        const bx = b === n ? hubWx - camX : t.xs[b]! - camX
        const by = b === n ? hubWy - camY : t.ys[b]! - camY
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
      }
    }
    ctx.lineCap = 'butt'
    ctx.globalCompositeOperation = prevComp
    // Slashing shards — bright white-hot particles race ALONG each beam (the straight-line
    // analogue of the ring's tangential cutting shards). Lifetime matches the ring's shards
    // (0.22-0.32s). Speed is SCALED to the beam length so a shard's full lifetime carries
    // it across ~30-50% of the beam regardless of size. Spawn position is biased toward the
    // middle so even outward-racing shards have room. As a final safety the lifetime is
    // capped at distToEnd/speed so a shard never visually overshoots an endpoint.
    if (simActive && effective < _dt * 1.5) {
      for (const [a, b] of tetherVizPairs(t.topology, n)) {
        // Reserve the top ~20% of the pool for the few critical ring shards (and other priority
        // effects). The fractal-tether slash flood would otherwise fill the pool and starve the
        // ring-attack circles of shards. Slashes stop here; ring shards still spawn to the full cap.
        if (particleCount >= MAX_PARTICLES * 0.8) break
        const ax = t.xs[a]!, ay = t.ys[a]!
        const bx = b === n ? hubWx : t.xs[b]!
        const by = b === n ? hubWy : t.ys[b]!
        const dx = bx - ax, dy = by - ay
        const len = Math.sqrt(dx * dx + dy * dy)
        if (len < 1) continue
        const nx = dx / len, ny = dy / len
        const perpX = -ny, perpY = nx
        // LOD-scaled so a fractal-tether finale thins these — but floored at 50% of full so the
        // slash identity stays readable instead of scaling down to a couple of wisps.
        const baseSpark = 4 + Math.min(6, Math.floor(len / 80))
        const SPARK_COUNT = lodCount(baseSpark, Math.ceil(baseSpark * 0.5))
        for (let k = 0; k < SPARK_COUNT; k++) {
          // Bias spawn toward the middle 50% of the beam so outward-racing shards have
          // enough runway to live their full lifetime.
          const tt = 0.25 + Math.random() * 0.5
          const ox = ax + dx * tt + perpX * (Math.random() - 0.5) * w
          const oy = ay + dy * tt + perpY * (Math.random() - 0.5) * w
          // Alternating direction — half race forward, half race backward
          const dir = k % 2 === 0 ? 1 : -1
          // Lifetime matches ring shards exactly
          const naturalLife = 0.22 + Math.random() * 0.10
          // Speed scales so a full-lifetime shard traverses ~30-50% of the beam length —
          // independent of beam size, so a tiny 60px tether and a huge 600px tether read
          // with the same shard-traversal rhythm.
          const travelFrac = 0.30 + Math.random() * 0.20
          const speed = (len * travelFrac) / naturalLife
          const vx = nx * dir * speed
          const vy = ny * dir * speed
          // Endpoint safety — if even the natural-lifetime would push past the end, clip it.
          const distToEnd = dir > 0 ? (1 - tt) * len : tt * len
          const life = Math.max(0.02, Math.min(naturalLife, distToEnd / speed))
          // ~20% red "danger" slashing sparks (matches the ring-hit red). Make them the LAST sparks
          // spawned in the beam so their source-over cores draw ON TOP of the white/ring-coloured
          // ones instead of getting buried under them.
          const isRed = k >= SPARK_COUNT - Math.max(1, Math.round(SPARK_COUNT * 0.2))
          const isWhite = !isRed && k % 3 === 0
          const pr = isRed ? 255 : isWhite ? 255 : Math.min(255, t.r + 100)
          const pg = isRed ? 60 + Math.floor(Math.random() * 40) : isWhite ? 255 : Math.min(255, t.g + 60)
          const pb = isRed ? 50 + Math.floor(Math.random() * 30) : isWhite ? 255 : Math.min(255, t.b + 60)
          const sz = (isWhite ? 14 : 11) + Math.random() * 4
          if (__DEV__ && particleCount >= MAX_PARTICLES) dbgSlashDrop++
          spawnParticle(ox, oy, vx, vy, pr, pg, pb, life, sz)
        }
      }
    }
  }
}

function updateAndDrawDashShots(dt: number): void {
  if (dashShotVizList.length === 0) return
  const simActive = getPhase() === 'playing' || getPhase() === 'designer'
  // Time-based pulses hoisted OUT of the per-particle loop — they're identical for all
  // particles in a single frame, so we save N×2 performance.now() + Math.sin calls per frame.
  const _frameNow = performance.now()
  const _dashShotSlowPulse = 0.85 + 0.15 * Math.sin(_frameNow / 110)
  const _dashShotFastPulse = 0.85 + 0.15 * Math.sin(_frameNow / 55)
  for (let i = dashShotVizList.length - 1; i >= 0; i--) {
    const p = dashShotVizList[i]!
    if (simActive) {
      p.elapsed += dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      if (p.lanceTimer > 0) p.lanceTimer -= dt
      if (p.muzzleTimer > 0) p.muzzleTimer -= dt
    }
    if (p.elapsed >= p.lifetime) {
      dashShotVizList[i] = dashShotVizList[dashShotVizList.length - 1]!
      dashShotVizList.pop()
      continue
    }
    const sx = p.x - camX
    const sy = p.y - camY
    const prog = p.elapsed / p.lifetime
    const eased = Math.pow(prog, 1.5)   // ease-in — matches sim's growth curve
    const visR = DASH_SHOT_MIN_VIS_R + (p.targetRadius - DASH_SHOT_MIN_VIS_R) * eased
    // Late-stage urgency — hotter, crazier as detonation nears
    const late = Math.max(0, (prog - 0.7) / 0.3)
    // Ball-lightning sphere radius — the energetic body the arcs play around. Distinct from
    // visR (the preview of where the explosion will be) so the ball itself stays a readable
    // size even though the explosion will be bigger.
    const ballR = (24 + eased * 28 + late * 12) * 1.2
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    // Palette — gold for the standalone Bolt, cyan when Reverb is also active so the projectile
    // reads as Reverb's same lightning vocabulary. Only the "warm" gold layers swap; the
    // electric blue-white arcs and the lance were already on the cool side and stay as-is.
    // (palettes are module-level constants — see DASH_SHOT_PAL_* below — so no per-frame alloc)
    const pal = p.reverbMode ? DASH_SHOT_PAL_REVERB : DASH_SHOT_PAL_GOLD

    // Aftershock + Bolt — first beat the projectile is dressed as a moving aftershock pie
    // (orange/red ticking wedge), then crossfades into the full bolt visual around t = BEAT_SEC.
    // boltIntensity dims the ball-lightning layers during the pie phase; muzzle + lance still
    // play at full strength because they're the discharge moment.
    // Non-aftershock bolt: boltIntensity = 1, pieAlpha = 0 — old behavior preserved.
    let boltIntensity = 1
    let pieAlpha = 0
    if (p.aftershock) {
      const crossStart = BEAT_SEC * 0.75
      const crossEnd = BEAT_SEC * 1.25
      boltIntensity = Math.max(0, Math.min(1, (p.elapsed - crossStart) / (crossEnd - crossStart)))
      pieAlpha = Math.max(0, Math.min(1, (crossEnd - p.elapsed) / (crossEnd - crossStart)))
    }

    // Muzzle flash — bright bloom at the spawn point, brief flash so the on-beat fire reads
    if (p.muzzleTimer > 0) {
      const msx = p.spawnX - camX
      const msy = p.spawnY - camY
      const mAlpha = p.muzzleTimer / MUZZLE_DURATION   // 1 → 0
      const mR = 40 + (1 - mAlpha) * 22   // bloom expands a touch as it fades
      const mGrad = ctx.createRadialGradient(msx, msy, 0, msx, msy, mR)
      mGrad.addColorStop(0, `rgba(${pal.bright}, ${0.9 * mAlpha})`)
      mGrad.addColorStop(0.4, `rgba(${pal.mid}, ${0.55 * mAlpha})`)
      mGrad.addColorStop(1, `rgba(${pal.deep}, 0)`)
      ctx.fillStyle = mGrad
      ctx.beginPath()
      ctx.arc(msx, msy, mR, 0, Math.PI * 2)
      ctx.fill()
    }

    // Lightning lance — jagged blue-white arc from spawn point to current projectile position.
    // Sells "the energy just left my body" for the first ~10 frames after spawn. Re-randomized
    // each frame so it crackles.
    if (p.lanceTimer > 0) {
      const lsx = p.spawnX - camX
      const lsy = p.spawnY - camY
      const lAlpha = p.lanceTimer / LANCE_DURATION
      const dxL = sx - lsx, dyL = sy - lsy
      const plenL = Math.sqrt(dxL * dxL + dyL * dyL)
      if (plenL > 2) {
        const pnxL = -dyL / plenL
        const pnyL = dxL / plenL
        const jitterL = 6 + plenL * 0.08
        const segments = Math.max(4, Math.min(12, Math.floor(plenL / 30)))
        ctx.beginPath()
        ctx.moveTo(lsx, lsy)
        for (let s = 1; s < segments; s++) {
          const tL = s / segments
          const jL = (Math.random() - 0.5) * 2 * jitterL
          ctx.lineTo(lsx + dxL * tL + pnxL * jL, lsy + dyL * tL + pnyL * jL)
        }
        ctx.lineTo(sx, sy)
        ctx.strokeStyle = `rgba(200, 240, 255, ${0.85 * lAlpha})`
        ctx.lineWidth = 2.2 + lAlpha * 1.5
        ctx.stroke()
        // Hot white inner streak on top
        ctx.strokeStyle = `rgba(255, 255, 250, ${0.9 * lAlpha})`
        ctx.lineWidth = 0.9
        ctx.stroke()
      }
    }

    // ── Dimmable bolt layers — wrapped in globalAlpha so Aftershock's pie phase fades them out
    // smoothly. Skipped entirely if boltIntensity is 0 (saves work during pure-pie stretch).
    const prevAlpha = ctx.globalAlpha
    if (boltIntensity > 0.005) {
      ctx.globalAlpha = prevAlpha * boltIntensity
    // Motion trail — short fading gradient line behind the orb
    const trailLen = 0.10
    const tailX = sx - p.vx * trailLen
    const tailY = sy - p.vy * trailLen
    const trailGrad = ctx.createLinearGradient(tailX, tailY, sx, sy)
    trailGrad.addColorStop(0, `rgba(${pal.trailFade}, 0)`)
    trailGrad.addColorStop(1, `rgba(${pal.trail}, ${0.45 + late * 0.3})`)
    ctx.strokeStyle = trailGrad
    ctx.lineWidth = 6 + late * 4
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(sx, sy)
    ctx.stroke()
    ctx.lineCap = 'butt'

    // Outer aura halo — soft radial glow, gently breathing. Palette-aware so Reverb mode shows
    // a cool cyan glow instead of warm gold. (slowPulse hoisted to function top — same for all particles)
    const haloR = ballR * 2.8 * _dashShotSlowPulse
    const haloGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, haloR)
    haloGrad.addColorStop(0, `rgba(${pal.mid}, ${0.28 + late * 0.18})`)
    haloGrad.addColorStop(0.55, `rgba(${pal.deep}, ${0.12 + late * 0.1})`)
    haloGrad.addColorStop(1, `rgba(${pal.deep}, 0)`)
    ctx.fillStyle = haloGrad
    ctx.beginPath()
    ctx.arc(sx, sy, haloR, 0, Math.PI * 2)
    ctx.fill()

    // Electric arcs — chaotic blue-white lightning bolts radiating from the core, fully
    // re-randomized every frame for that crackling "alive" feel. Count + intensity grow late.
    const arcCount = 7 + Math.floor(late * 6)
    for (let a = 0; a < arcCount; a++) {
      const angle = Math.random() * Math.PI * 2
      const lenMult = 0.65 + Math.random() * 0.7   // some arcs short, some reach past ballR
      const tipX = sx + Math.cos(angle) * ballR * lenMult
      const tipY = sy + Math.sin(angle) * ballR * lenMult
      const dxA = tipX - sx, dyA = tipY - sy
      // Perpendicular unit for jitter offsets
      const plen = Math.sqrt(dxA * dxA + dyA * dyA)
      const pnx = plen > 0.01 ? -dyA / plen : 0
      const pny = plen > 0.01 ?  dxA / plen : 0
      const jitter = ballR * 0.22
      // Polyline with random perpendicular offsets — jagged lightning shape
      const segments = 5
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      for (let s = 1; s < segments; s++) {
        const t = s / segments
        const j = (Math.random() - 0.5) * 2 * jitter
        ctx.lineTo(sx + dxA * t + pnx * j, sy + dyA * t + pny * j)
      }
      ctx.lineTo(tipX, tipY)
      const arcAlpha = (0.45 + Math.random() * 0.45) * (0.7 + late * 0.3)
      ctx.strokeStyle = `rgba(190, 235, 255, ${arcAlpha})`
      ctx.lineWidth = 0.9 + Math.random() * 1.6
      ctx.stroke()
      // Bright white inner streak on top of about half the arcs — gives "hot core" pop
      if (Math.random() < 0.5) {
        ctx.strokeStyle = `rgba(255, 255, 245, ${arcAlpha * 0.6})`
        ctx.lineWidth = 0.6
        ctx.stroke()
      }
    }

    // Tight inner glow — bright halo right around the white/cool-white core
    const innerR = ballR * 0.75
    const innerGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, innerR)
    innerGrad.addColorStop(0, `rgba(${pal.core}, ${0.85 + late * 0.15})`)
    innerGrad.addColorStop(0.5, `rgba(${pal.bright}, ${0.45 + late * 0.2})`)
    innerGrad.addColorStop(1, `rgba(${pal.mid}, 0)`)
    ctx.fillStyle = innerGrad
    ctx.beginPath()
    ctx.arc(sx, sy, innerR, 0, Math.PI * 2)
    ctx.fill()

    // White-hot core — small ultra-bright orb, fast pulse. (cool-white tint in Reverb mode)
    // (fastPulse hoisted to function top — identical across all particles in a frame)
    const coreR = (5 + late * 4) * _dashShotFastPulse
    ctx.fillStyle = `rgba(${pal.core}, 0.95)`
    ctx.beginPath()
    ctx.arc(sx, sy, coreR, 0, Math.PI * 2)
    ctx.fill()

    // Crackle sparks — tiny bright pixels scattered around the ball, repositioned every frame
    const sparkCount = 5 + Math.floor(late * 8)
    for (let s = 0; s < sparkCount; s++) {
      const sa = Math.random() * Math.PI * 2
      const sd = ballR * (0.45 + Math.random() * 0.95)
      const spx = sx + Math.cos(sa) * sd
      const spy = sy + Math.sin(sa) * sd
      const sr = 0.6 + Math.random() * 1.5
      ctx.fillStyle = `rgba(${pal.bright}, ${0.55 + Math.random() * 0.35})`
      ctx.beginPath()
      ctx.arc(spx, spy, sr, 0, Math.PI * 2)
      ctx.fill()
    }

    // Preview ring — faint dashed outline at the EXPLOSION radius (visR). On top so it
    // remains readable as the gameplay tell even through all the crackle.
    ctx.beginPath()
    ctx.arc(sx, sy, visR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${pal.accent}, ${0.22 + eased * 0.35 + late * 0.25})`
    ctx.lineWidth = 1.5 + eased * 1.5 + late * 1.5
    ctx.setLineDash([8, 6])
    ctx.stroke()
    ctx.setLineDash([])
    }
    ctx.globalAlpha = prevAlpha

    // ── Moving Aftershock pie — Aftershock + Bolt composes by showing the orange/red ticking
    // wedge ON the moving projectile for the first beat, then crossfades into the full bolt
    // visual. The pie's wedge fills over BEAT_SEC seconds (one beat) — at t=BEAT_SEC the
    // wedge completes and dissolves while the bolt blooms in. Centered on the bolt's current
    // position (sx, sy), radius matches the final explosion (p.targetRadius).
    if (p.aftershock && pieAlpha > 0.005) {
      const prevAlphaPie = ctx.globalAlpha
      ctx.globalAlpha = prevAlphaPie * pieAlpha
      // Reset composite to source-over so the pie reads as a flat telegraph instead of getting
      // washed out by the additive blending used for the bolt itself.
      ctx.globalCompositeOperation = 'source-over'
      const pieElapsed = Math.min(1, p.elapsed / BEAT_SEC)   // 0 → 1 over first beat
      // Color shift: gold → orange → red as the wedge fills (mirrors the static aftershock pie).
      const lateT = Math.max(0, (pieElapsed - 0.7) / 0.3)
      const colR = 255
      const colG = Math.floor(200 - pieElapsed * 90 - lateT * 50)
      const colB = Math.floor(80 - pieElapsed * 50)
      const pulsePeriod = 600 - pieElapsed * 420
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / pulsePeriod * Math.PI * 2)
      // Pie radius — scaled down from the full explosion so it reads as a focal timing
      // indicator on the moving projectile, not a huge area claim. (Final blast is still
      // p.targetRadius; this is purely the pie's visual size.)
      const pieR = p.targetRadius * 0.55
      // Outer danger ring outline — dashed, pulsing
      ctx.beginPath()
      ctx.arc(sx, sy, pieR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${colR}, ${colG}, ${colB}, ${0.35 + pulse * 0.35 + lateT * 0.2})`
      ctx.lineWidth = 2.5 + pulse * 1.5 + lateT * 1.5
      ctx.setLineDash([10, 7])
      ctx.stroke()
      ctx.setLineDash([])
      // Ticking pie wedge — fills clockwise from 12 o'clock
      const pieEnd = -Math.PI / 2 + pieElapsed * Math.PI * 2
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, pieR, -Math.PI / 2, pieEnd)
      ctx.closePath()
      ctx.fillStyle = `rgba(${colR}, ${colG}, ${colB}, ${0.14 + lateT * 0.22})`
      ctx.fill()
      // Pie leading edge line — "hand of the clock"
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx + Math.cos(pieEnd) * pieR, sy + Math.sin(pieEnd) * pieR)
      ctx.strokeStyle = `rgba(255, ${Math.min(255, colG + 50)}, ${colB}, ${0.7 + lateT * 0.3})`
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.globalAlpha = prevAlphaPie
      ctx.globalCompositeOperation = 'lighter'   // restore for the rest of the loop
    }

    ctx.globalCompositeOperation = prevComp
  }
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
let chillZoneViz: { x: number; y: number; radius: number; spawnTimer: number } | null = null
const CHILL_ZONE_SPAWN_DURATION = 0.35   // seconds — ice "crystallizing outward" expand-in
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
  chillZoneViz = { x, y, radius, spawnTimer: CHILL_ZONE_SPAWN_DURATION }
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
  // Spray of small fast particles for added texture — bumped count + speed so the initial
  // collapse moment hits harder
  for (let i = 0; i < 50; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 320 + Math.random() * 320
    spawnParticle(x + Math.cos(a) * radius * 0.4, y + Math.sin(a) * radius * 0.4,
      Math.cos(a) * sp, Math.sin(a) * sp,
      200 + Math.floor(Math.random() * 55), 230 + Math.floor(Math.random() * 25), 255,
      0.28 + Math.random() * 0.22, 3 + Math.random() * 2.5)
  }
  // Bright central flash + shock-ring (drawn each frame in updateAndDrawChillFX while alive)
  frostCracks.push({ x, y, radius, timer: 0, lifetime: 0.36 })
  // Mini snowflake EXPLOSION — was a slow drifting "kicked-up dust" trailing the shards. Now
  // it's a dense, fast, bigger flurry that BURSTS at the same instant as the shards converge,
  // so the snow is part of the dramatic moment instead of arriving late. Roughly 2× the count,
  // 2× the initial speed, ~40% bigger flakes, slightly shorter lifetime so they don't linger
  // weakly after the shards are gone.
  const flakeCount = Math.max(40, Math.floor(radius * 0.55))
  for (let i = 0; i < flakeCount; i++) {
    const a = Math.random() * Math.PI * 2
    const d = Math.sqrt(Math.random()) * radius * 0.9
    const spawnX = x + Math.cos(a) * d
    const spawnY = y + Math.sin(a) * d
    // Strong outward burst (0.75 of speed along the outward direction) + jitter — feels like
    // an explosion of powder snow, not a gentle puff. Initial speed bumped + lifetime shortened
    // so flakes MOVE faster within the same final-distance envelope (drag eats more of the
    // faster initial velocity before they stop).
    const outAng = Math.atan2(spawnY - y, spawnX - x)
    const speed = 170 + Math.random() * 280
    const vx = Math.cos(outAng) * speed * 0.75 + (Math.random() - 0.5) * 90
    const vy = Math.sin(outAng) * speed * 0.75 + (Math.random() - 0.5) * 90 - 22
    miniSnowflakes.push({
      x: spawnX, y: spawnY,
      vx, vy,
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 11,
      size: 5.5 + Math.random() * 5,
      timer: 0, lifetime: 0.4 + Math.random() * 0.4,
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
    springFireT: number
  }
  // Reuse the module-level drawList buffer — grown lazily, never freed. Avoids allocating
  // a fresh array + N entries every frame when many walls exist.
  WALL_DRAW_LIST.length = 0
  const drawList = WALL_DRAW_LIST as WallDraw[]
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
    // Fade — bake fadeSize into visScale so all stroke layers shrink with the wall. When
    // fully hidden (fadeSize ≈ 0) the wall is skipped from the body draws below but the
    // ghost outline pass (designer-only) shows a faint preview at the wall's rest size.
    const fadeSize = w.fadeSize ?? 1
    visScale *= fadeSize
    drawList.push({ w, ax, ay, bx, by, pillar, arc, visScale, springFireT })
  }

  function strokeWallLayer(d: WallDraw, padding: number, style: string, fixedWidth?: number): void {
    // Death fade for retiring Trailblaze trails — alpha-only multiplier so the fade is quick
    // and quiet (no thickness shrink). Applied to every pass via globalAlpha so halo, rim, and
    // body all dim together. dyingUntil == null is the hot path, no overhead.
    let deathFade = 1
    if (d.w.dyingUntil != null) {
      deathFade = Math.max(0, (d.w.dyingUntil - performance.now()) / WALL_DEATH_DURATION_MS)
      if (deathFade <= 0) return
    }
    const thick = d.w.radius * 2 * d.visScale
    let prevAlpha = 1
    if (deathFade < 1) {
      prevAlpha = ctx.globalAlpha
      ctx.globalAlpha = prevAlpha * deathFade
    }
    if (d.pillar) {
      ctx.beginPath()
      ctx.arc(d.ax, d.ay, (d.w.radius + padding / 2) * d.visScale, 0, Math.PI * 2)
      ctx.fillStyle = style
      ctx.fill()
      if (deathFade < 1) ctx.globalAlpha = prevAlpha
      return
    }
    const w = fixedWidth ?? (thick + padding)
    if (w < 0.5) {
      if (deathFade < 1) ctx.globalAlpha = prevAlpha
      return   // guard tiny / negative widths
    }
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
    if (deathFade < 1) ctx.globalAlpha = prevAlpha
  }

  // Helper — spring fire intensity 0..1 (peaks at 1 on fire frame, decays to 0 by end of pulse)
  function springFireGlow(d: WallDraw): number {
    return d.springFireT
  }

  // Helper — stroke the OUTLINE of the wall's capsule expanded to half-thickness R (from the
  // spine). Gives the zone band a crisp, defined edge (like a volatile explosion's core ring)
  // rather than a soft fill boundary. Pillar = circle; straight = capsule outline (two cap arcs);
  // arc = the two concentric edge arcs.
  function strokeBandEdge(d: WallDraw, R: number, style: string, lw: number): void {
    if (R < 1) return
    ctx.strokeStyle = style
    ctx.lineWidth = lw
    if (d.pillar) {
      ctx.beginPath(); ctx.arc(d.ax, d.ay, R, 0, Math.PI * 2); ctx.stroke(); return
    }
    if (d.arc) {
      const a = d.arc
      ctx.beginPath(); ctx.arc(a.cx, a.cy, a.r + R, a.aA, a.aB, !a.antiClockwise); ctx.stroke()
      const inner = a.r - R
      if (inner > 1) { ctx.beginPath(); ctx.arc(a.cx, a.cy, inner, a.aA, a.aB, !a.antiClockwise); ctx.stroke() }
      return
    }
    const ang = Math.atan2(d.by - d.ay, d.bx - d.ax)
    ctx.beginPath()
    ctx.arc(d.bx, d.by, R, ang - Math.PI / 2, ang + Math.PI / 2)              // forward cap at B
    ctx.arc(d.ax, d.ay, R, ang + Math.PI / 2, ang + Math.PI * 1.5)            // back cap at A (sides connect)
    ctx.closePath()
    ctx.stroke()
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
  // Pass 0 — zone telegraph (damage/heal band), drawn UNDER everything so it reads as energy
  // around the wall. Uses the volatile-explosion visual language in the wall's capsule-band shape:
  //   • a faint FULL-REACH band always present  → SPACE (how far the wall hits)
  //   • a brighter fill that CHARGES outward from the wall edge to the reach over the beat,
  //     reaching the edge exactly on the fire beat                               → TIME (countdown)
  //   • a bright BURST flash + white edge on the fire frame, decaying            → the hit moment
  // Red = damage, gold = heal (matches the heal-explosion palette). strokeWallLayer strokes the
  // round-capped wall path, so padding=2·dist grows the capsule outward by `dist` for any shape.
  {
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    for (const d of drawList) {
      const w = d.w
      if (!w.zone || w.zone.range <= 0) continue
      const heal = w.zone.mode === 'heal'
      const range = w.zone.range
      const cycle = w.zone.beatsPerCycle
      let charge = 0, fireT = 0
      if (w.zoneLastFireBeat != null && cycle > 0) {
        const bsf = beatPosForSpring - w.zoneLastFireBeat
        // Charge ramps over a FIXED 1-beat lead before each fire — a consistent rhythmic tell no
        // matter how long the cycle is (band sits idle the rest of the cycle, then winds up).
        const beatsUntil = (w.zoneLastFireBeat + cycle) - beatPosForSpring
        charge = beatsUntil >= 1 ? 0 : Math.max(0, Math.min(1, 1 - beatsUntil))
        // Burst fades over the SAME duration as a real volatile explosion (0.21s), same (1−t)²
        // curve — so the band's flash decays in lockstep with the blast, not faster.
        const sec = bsf * BEAT_SEC
        if (sec >= 0 && sec < 0.21) { const t = sec / 0.21; fireT = (1 - t) * (1 - t) }
      }
      if (w.zoneJustFired) w.zoneJustFired = false   // one-shot flag consumed (burst is beat-driven)
      const baseR = d.w.radius * d.visScale           // wall body half-thickness in screen px
      // Volatile-language color: damage reddens + darkens toward the fire beat; heal holds warm
      // gold and brightens. Both intensify as the band charges.
      const eg = heal ? 244 : 90, eb = heal ? 200 : 55
      const cg = heal ? Math.floor(238 + 17 * charge) : Math.floor(110 - 55 * charge)
      const cb = heal ? Math.floor(200 - 25 * charge) : Math.floor(60 - 30 * charge)
      // (1) Faint full reach — persistent SPACE fill + a defined boundary edge (always visible).
      strokeWallLayer(d, 2 * range, `rgba(255, ${eg}, ${eb}, 0.05)`)
      strokeBandEdge(d, baseR + range, `rgba(255, ${eg}, ${eb}, 0.20)`, 1.5)
      // (2) Charging fill + a BRIGHT defined edge ring that sweeps outward to the reach as the
      // beat nears — the crisp "fill rises to the edge" read, like an explosion's expanding ring.
      const fillDist = range * charge
      if (fillDist > 1) {
        strokeWallLayer(d, 2 * fillDist, `rgba(255, ${cg}, ${cb}, ${0.10 + 0.18 * charge})`)
        strokeBandEdge(d, baseR + fillDist, `rgba(255, ${cg}, ${cb}, ${0.45 + 0.45 * charge})`, 2 + 1.5 * charge)
      }
      // (3) Burst — full-band flash + crisp white edge + an expanding shockwave ripple, all fading
      // over the explosion duration. Drawn inline from the wall's LIVE coords, so it stays glued to
      // a turning/translating wall (unlike a world-anchored volatile blast, which lags behind).
      if (fireT > 0.01) {
        // Bright fill across the FULL reach + a crisp edge exactly AT the hitbox boundary — flush
        // with the damage reach, no overshoot past it.
        strokeWallLayer(d, 2 * range, `rgba(255, ${heal ? 248 : 150}, ${heal ? 222 : 110}, ${0.5 * fireT})`)
        strokeBandEdge(d, baseR + range, `rgba(255, ${heal ? 245 : 100}, ${heal ? 210 : 65}, ${0.55 * fireT})`, 4)
        strokeBandEdge(d, baseR + range, `rgba(255, 255, 255, ${0.85 * fireT})`, 2)
      }
    }
    ctx.globalCompositeOperation = prevComp
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
  // the bounce is unmissable. Player-owned walls (Trailblaze) get a bright cyan body with
  // a shimmer so they read as "magical, drawn by you" vs the static designer walls. Drawn
  // LAST so they cover any rim crossover at shared endpoints.
  for (const d of drawList) {
    const fire = springFireGlow(d)
    let bodyStyle: string
    if (d.w.playerOwned) {
      // Cyan shimmer — slowly cycling brightness so the wall looks alive
      const shimmer = 0.5 + 0.5 * Math.sin(now / 220)
      const r = 38, g = Math.floor(198 + shimmer * 40), b = Math.floor(218 + shimmer * 30)
      bodyStyle = `rgba(${r}, ${g}, ${b}, 0.95)`
    } else if (fire > 0) {
      bodyStyle = `rgba(${Math.floor(35 + (255 - 35) * fire)}, ${Math.floor(50 + (175 - 50) * fire)}, ${Math.floor(70 - 70 * fire)}, 1)`
    } else {
      bodyStyle = 'rgba(35, 50, 70, 1)'
    }
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
  // (Motion-flash gold rim pass removed — moving walls now read the same as static walls
  // so the player isn't biased by color. Re-enable here later if motion telegraphing is
  // wanted: stroke padding 6 with gold-tinted alpha keyed off groupMotion / groupTranslation.)

  ctx.lineCap = 'butt'
  drawWallsOverlay()
}

// Designer-only overlays (hover-delete highlight + drag-ghost + selection handles).
// Extracted so drawWalls can call it even when there are no placed walls (so the drag
// ghost still renders on an empty arena).
function drawWallsOverlay(): void {
  if (getPhase() !== 'designer') return
  const wallsRef = getWalls()

  // Fade-hidden indicator — dashed cyan outline at the wall's REST size shown when the wall
  // is in the "hidden" portion of its fade cycle. Designer-only preview so the designer can
  // see where a faded wall will come back. The body itself is rendered tiny/invisible by the
  // main draw pass; this just adds a ghost reference.
  ctx.save()
  ctx.setLineDash([4, 6])
  ctx.lineCap = 'round'
  ctx.strokeStyle = 'rgba(120, 220, 255, 0.45)'
  ctx.lineWidth = 1.5
  for (const w of wallsRef) {
    if (!w.groupFade) continue
    const fs = w.fadeSize ?? 1
    if (fs >= 0.05) continue
    const ax = w.ax - camX, ay = w.ay - camY
    const bx = w.bx - camX, by = w.by - camY
    const isPillar = (bx - ax) ** 2 + (by - ay) ** 2 < 0.5
    if (isPillar) {
      ctx.beginPath()
      ctx.arc(ax, ay, w.radius, 0, Math.PI * 2)
      ctx.stroke()
    } else {
      ctx.lineWidth = w.radius * 2
      ctx.beginPath()
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
      ctx.stroke()
      ctx.lineWidth = 1.5
    }
  }
  ctx.restore()

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
  // Spawn-in expand — ice crystallizes outward from center rather than popping at full size.
  // Tick the timer using lastDt so it aligns with everything else animated in this pass.
  if (cz.spawnTimer > 0) cz.spawnTimer -= lastDt
  const spawnProg = cz.spawnTimer > 0
    ? Math.max(0, 1 - cz.spawnTimer / CHILL_ZONE_SPAWN_DURATION)
    : 1
  const spawnEase = 1 - Math.pow(1 - spawnProg, 3)   // ease-out cubic
  const effR = cz.radius * spawnEase

  // (1) Base flat fill — soft cyan at the center color all the way to the edge so the damage
  // zone reads as a uniform circle (no edge fade). Breathing alpha kept for the alive feel.
  // Dialed back slightly so the zone reads as clean ice rather than a heavy wash.
  ctx.beginPath()
  ctx.arc(sx, sy, effR, 0, Math.PI * 2)
  ctx.fillStyle = `rgba(128, 216, 255, ${0.14 + breathe * 0.05})`
  ctx.fill()

  // Clip everything below to the zone circle so layers don't leak past the edge.
  ctx.save()
  ctx.beginPath()
  ctx.arc(sx, sy, effR, 0, Math.PI * 2)
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
    const x0 = cz.x - effR
    const x1 = cz.x + effR
    const y0 = cz.y - effR
    const y1 = cz.y + effR
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
        if (dx * dx + dy * dy > (effR + hexR) * (effR + hexR)) continue
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
      const orbitR = effR * (0.25 + 0.30 * (0.5 + 0.5 * Math.sin(t * 0.4 + i * 2.1)))
      const mx = sx + Math.cos(orbitAngle) * orbitR
      const my = sy + Math.sin(orbitAngle) * orbitR
      const blobR = effR * 0.32 + Math.sin(t * 0.6 + i * 2.7) * effR * 0.08
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


  // Snowflake clusters scattered inside — 6-pointed asterisks, slow counter-rotation (kept
  // from before; they're the "ice crystals on the ground" layer between the hex grid and
  // the tendrils).
  ctx.save()
  ctx.translate(sx, sy)
  ctx.rotate(-slowRot * 0.6)
  const flakes = 5
  for (let i = 0; i < flakes; i++) {
    const a = (i / flakes) * Math.PI * 2
    const dist = effR * (0.4 + (i % 2) * 0.25)
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
    ctx.arc(sx, sy, effR - 1, 0, Math.PI * 2)
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
      const cxw = sx + Math.cos(baseAngle) * effR
      const cyw = sy + Math.sin(baseAngle) * effR
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
    const sd = effR * Math.sqrt(Math.random()) * 0.92
    spawnParticle(cz.x + Math.cos(sa) * sd, cz.y + Math.sin(sa) * sd,
      0, 0,
      255, 255, 255, 0.18 + Math.random() * 0.12, 1.2 + Math.random() * 1.0)
  }

  // Drift particles (existing) — small ice crystals floating up from random spots
  if (Math.random() < 0.45) {
    const a = Math.random() * Math.PI * 2
    const d = effR * Math.sqrt(Math.random()) * 0.92
    const px = cz.x + Math.cos(a) * d
    const py = cz.y + Math.sin(a) * d
    spawnParticle(px, py, (Math.random() - 0.5) * 18, -30 - Math.random() * 25,
      200 + Math.floor(Math.random() * 55), 230 + Math.floor(Math.random() * 25), 255,
      0.7 + Math.random() * 0.4, 2 + Math.random() * 2)
  }
}

function updateAndDrawChillFX(dt: number): void {
  // Ice shards — sprite-cached diamond, alpha via globalAlpha, rotation via setTransform.
  // Was per-shard fill+stroke with two rgba template strings; now one drawImage per shard.
  if (iceShards.length > 0) {
    const shardSprite = getIceShardSprite()
    const shardHalf = shardSprite.width * 0.5
    const prevAlpha = ctx.globalAlpha
    for (let i = iceShards.length - 1; i >= 0; i--) {
      const s = iceShards[i]!
      s.timer += dt
      if (s.timer >= s.lifetime) {
        iceShards[i] = iceShards[iceShards.length - 1]!
        iceShards.pop()
        continue
      }
      const t = s.timer / s.lifetime
      const ease = 1 - (1 - t) * (1 - t)
      const dist = s.startDist + (s.endDist - s.startDist) * ease
      const cx = s.ox + s.dx * dist - camX
      const cy = s.oy + s.dy * dist - camY
      s.rot += s.rotVel * dt
      const alpha = 1 - t * t
      const ang = Math.atan2(s.dy, s.dx) + s.rot * 0.2
      const scale = s.size / ICE_SHARD_REF_SIZE
      const co = Math.cos(ang) * scale
      const si = Math.sin(ang) * scale
      ctx.globalAlpha = alpha
      ctx.setTransform(co * renderResScale, si * renderResScale, -si * renderResScale, co * renderResScale, cx * renderResScale, cy * renderResScale)
      ctx.drawImage(shardSprite, -shardHalf, -shardHalf)
    }
    ctx.setTransform(renderResScale, 0, 0, renderResScale, 0, 0)
    ctx.globalAlpha = prevAlpha
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
  // Mini snowflakes — sprite-cached 6-arm star. Each flake was costing 12 strokes + 12
  // cos/sin pairs + 2 rgba template strings per frame. With bursts spawning ~220 flakes,
  // that was ~2,640 stroke calls/frame just for snow — the main 120→80 fps culprit. Now
  // one drawImage per flake via setTransform.
  if (miniSnowflakes.length > 0) {
    const flakeSprite = getSnowflakeSprite()
    const flakeHalf = flakeSprite.width * 0.5
    const prevAlpha = ctx.globalAlpha
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
      if (alpha <= 0) continue
      const sx = f.x - camX
      const sy = f.y - camY
      const scale = f.size / SNOWFLAKE_REF_SIZE
      const co = Math.cos(f.rot) * scale
      const si = Math.sin(f.rot) * scale
      ctx.globalAlpha = alpha
      ctx.setTransform(co * renderResScale, si * renderResScale, -si * renderResScale, co * renderResScale, sx * renderResScale, sy * renderResScale)
      ctx.drawImage(flakeSprite, -flakeHalf, -flakeHalf)
    }
    ctx.setTransform(renderResScale, 0, 0, renderResScale, 0, 0)
    ctx.globalAlpha = prevAlpha
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
  const innerCount = 8     // fewer strands again
  const innerScale = 2.3   // a bit thinner than 2.7
  const innerLen = radius * 0.74
  const innerLife = 0.40   // fade a touch slower
  for (let i = 0; i < innerCount; i++) {
    const a = (i / innerCount) * Math.PI * 2 + Math.random() * 0.5
    spawnStaticLightningBolt(x, y, a, innerLen * (0.75 + Math.random() * 0.5), innerScale, innerLife + Math.random() * 0.06)
  }
  const outerCount = 5     // fewer strands again
  const outerScale = 1.8   // a bit thinner than 2.1
  const outerLen = radius * 1.37
  const outerLife = 0.34   // fade a touch slower
  for (let i = 0; i < outerCount; i++) {
    const a = (i / outerCount) * Math.PI * 2 + Math.random() * 0.8
    spawnStaticLightningBolt(x, y, a, outerLen * (0.8 + Math.random() * 0.16), outerScale, outerLife + Math.random() * 0.06)   // tighter max (1.15→0.96), min unchanged
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
  for (let i = particleCount - 1; i >= 0; i--) {
    const p = particles[i]!
    p.life += dt / p.lifetime
    // Spawn delay — life starts negative for staggered particles. While life < 0 the particle
    // sits dormant (no motion, not drawn). It also doesn't track its parent in this state so
    // when it "wakes up" it appears at the parent's then-current position.
    if (p.life < 0) {
      if (p.parent) {
        p.lastParentX = p.parent.x
        p.lastParentY = p.parent.y
        // Translate spawn position with parent so the dormant particle stays at its relative offset
        // (using parent delta still — same as active particles — but skip everything else).
        // Already at relative offset since we updated lastParentX/Y; recompute world pos:
        // (deferred — when life crosses 0, x/y becomes parent.x + offset which we stored implicitly)
      }
      continue
    }
    // Parent attachment — shift position by parent's per-frame delta so the particle travels
    // with the entity. Read the delta from lastParentX/Y (stored per-particle) so we get the
    // true movement since the LAST particle update, independent of render/sim order.
    if (p.parent) {
      const cx = p.parent.x, cy = p.parent.y
      p.x += cx - p.lastParentX
      p.y += cy - p.lastParentY
      p.lastParentX = cx
      p.lastParentY = cy
      // Rotational attachment — rotate the particle's offset (and velocity) around the parent
      // center by the parent's per-frame angle delta, so a spray rigidly follows a TURNING wall,
      // not just a translating one. rot is undefined for point parents (player/enemy) → skipped.
      const rot = p.parent.rot
      if (rot !== undefined && rot !== p.lastParentRot) {
        const dRot = rot - p.lastParentRot
        const cs = Math.cos(dRot), sn = Math.sin(dRot)
        const rx = p.x - cx, ry = p.y - cy
        p.x = cx + rx * cs - ry * sn
        p.y = cy + rx * sn + ry * cs
        const vx = p.vx, vy = p.vy
        p.vx = vx * cs - vy * sn
        p.vy = vx * sn + vy * cs
        p.lastParentRot = rot
      }
    }
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.vx *= 0.98
    p.vy *= 0.98
    // Orbit-on-ring mode — keep particle on the ring's circumference. After velocity moves it
    // off the circle, project (mostly) back onto the orbit radius and reorient velocity to
    // tangent at the new position. blend < 1 leaves a TINY straight-tangent drift each frame
    // — particles look like they're racing the ring with a hint of "off-course" threat,
    // rather than locked perfectly to the curve.
    if (p.orbitR > 0) {
      const dx = p.x - p.orbitCx
      const dy = p.y - p.orbitCy
      const distSq = dx * dx + dy * dy
      // Square-distance check avoids one Math.sqrt when far from origin and the particle is
      // obviously off-orbit. Threshold 0.0001 = (0.01)².
      if (distSq > 0.0001) {
        const dist = Math.sqrt(distSq)
        p.orbitR = Math.max(0, p.orbitR - 35 * dt)
        const r = p.orbitR
        const ux = dx / dist
        const uy = dy / dist
        // Partial pull-back — 85% of the per-frame tangent drift gets corrected, leaving
        // 15% to accumulate as a slight outward straight-line departure (the "threat tail").
        const blend = 0.83
        const tgtX = p.orbitCx + ux * r
        const tgtY = p.orbitCy + uy * r
        p.x = p.x * (1 - blend) + tgtX * blend
        p.y = p.y * (1 - blend) + tgtY * blend
        // Reorient velocity tangent to the NEW position. Use squared-magnitude reciprocal-sqrt
        // pattern to combine two Math.sqrt calls into one when both unit-radial and speed are
        // needed.
        const ndx = p.x - p.orbitCx
        const ndy = p.y - p.orbitCy
        const nDistSq = ndx * ndx + ndy * ndy
        if (nDistSq > 0.0001) {
          const nDist = Math.sqrt(nDistSq)
          const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy)
          const nux = ndx / nDist
          const nuy = ndy / nDist
          const tx = -nuy
          const ty = nux
          const sign = (p.vx * tx + p.vy * ty) >= 0 ? 1 : -1
          p.vx = sign * tx * speed
          p.vy = sign * ty * speed
        }
      }
    }
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
      // Pool swap-remove: stash the dead object in the tail slot (kept for reuse), pull the live
      // tail particle into this slot, shrink the count. No array push/pop = no garbage.
      const last = particleCount - 1
      particles[i] = particles[last]!
      particles[last] = p
      particleCount = last
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

// ── Chill FX sprite caches ──
// Mini snowflake (6-arm asterisk: soft halo + crisp white core) is the worst per-frame
// offender in the chill zone burst — a single flake costs 12 stroke calls, and bursts spawn
// ~220 of them. Pre-rendering once and drawImage-ing per flake collapses that to 1 draw call
// per flake. Ice shards likewise — diamond fill+stroke cached once. Both sprites baked at
// MAX flake/shard reference size; instances scale by (instance.size / refSize) at draw time.
const SNOWFLAKE_REF_SIZE = 10.5   // matches max miniSnowflake.size (5.5 + rand*5)
const ICE_SHARD_REF_SIZE = 12     // matches max iceShard.size (7 + rand*5)
let snowflakeSprite: HTMLCanvasElement | null = null
let iceShardSprite: HTMLCanvasElement | null = null

// Cached central flash bloom for lightning bursts — keyed by ring color. Was creating a
// fresh radial gradient PER burst PER frame; with many simultaneous push detonations the
// gradient allocations dominated. Now baked once per color, drawn via drawImage. globalAlpha
// scales brightness by peakCurve at draw time.
const LIGHTNING_CORE_R = 80       // sprite reference radius (instance scales via drawImage)
const lightningCoreSpriteCache = new Map<number, HTMLCanvasElement>()
function makeLightningCoreSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const padding = 4
  const total = (LIGHTNING_CORE_R + padding) * 2
  const c = document.createElement('canvas')
  c.width = total; c.height = total
  const sctx = c.getContext('2d')!
  sctx.translate(total / 2, total / 2)
  const tR = Math.min(255, r + 120)
  const tG = Math.min(255, g + 45)
  const tB = Math.min(255, b + 0)
  const grad = sctx.createRadialGradient(0, 0, 0, 0, 0, LIGHTNING_CORE_R)
  // Bake at full intensity (peakCurve = 1). Caller scales via globalAlpha to apply peakCurve.
  grad.addColorStop(0, `rgba(${tR}, ${tG}, ${tB}, 0.55)`)
  grad.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, 0.28)`)
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
  sctx.fillStyle = grad
  sctx.beginPath()
  sctx.arc(0, 0, LIGHTNING_CORE_R, 0, Math.PI * 2)
  sctx.fill()
  return c
}
function getLightningCoreSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const key = (r << 16) | (g << 8) | b
  let s = lightningCoreSpriteCache.get(key)
  if (!s) { s = makeLightningCoreSprite(r, g, b); lightningCoreSpriteCache.set(key, s) }
  return s
}

// Shock-push "body" wash — a soft volumetric disc baked once per color, blitted under the
// ripple rings so the push reads as a pressure bloom with mass instead of bare line-rings.
// Baked at a reference radius; instances scale via drawImage to the live wavefront radius so
// it grows exactly with the push range (= the rings' radius). globalAlpha applies the envelope.
const SHOCK_BODY_REF_R = 128
const shockBodySpriteCache = new Map<number, HTMLCanvasElement>()
function makeShockBodySprite(r: number, g: number, b: number): HTMLCanvasElement {
  const padding = 2
  const total = (SHOCK_BODY_REF_R + padding) * 2
  const c = document.createElement('canvas')
  c.width = total; c.height = total
  const sctx = c.getContext('2d')!
  sctx.translate(total / 2, total / 2)
  const grad = sctx.createRadialGradient(0, 0, 0, 0, 0, SHOCK_BODY_REF_R)
  // Dense near center, smooth falloff to transparent. Baked at full intensity; caller scales
  // brightness via globalAlpha (so the swell-in/fade-out envelope lives at the call site).
  grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.55)`)
  grad.addColorStop(0.45, `rgba(${r}, ${g}, ${b}, 0.22)`)
  grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
  sctx.fillStyle = grad
  sctx.beginPath()
  sctx.arc(0, 0, SHOCK_BODY_REF_R, 0, Math.PI * 2)
  sctx.fill()
  return c
}
function getShockBodySprite(r: number, g: number, b: number): HTMLCanvasElement {
  const key = (r << 16) | (g << 8) | b
  let s = shockBodySpriteCache.get(key)
  if (!s) { s = makeShockBodySprite(r, g, b); shockBodySpriteCache.set(key, s) }
  return s
}

// Shared draw for both the player Reverb shock-push and the enemy push-mode detonations so the
// two stay visually identical. Caller sets globalCompositeOperation = 'lighter' and passes the
// live push radius + pt (1 → 0 fade). Adds (#1) a cached body wash that expands with the front
// and (#2) a shock-FRONT bias — the leading ring is fat + bright, trailing rings taper to a
// thin wake. radius is the real push range, so everything scales with the hitbox.
function drawShockWave(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, radius: number, pt: number,
  haloR: number, haloG: number, haloB: number,   // soft wide ring + body tint
  coreR: number, coreG: number, coreB: number,    // bright thin inner stripe
): void {
  const RING_COUNT = 7
  const RING_STAGGER = 0.05
  const RING_TRAVEL = 0.5
  const prog = 1 - pt
  const ptSmooth = Math.pow(pt, 0.7)

  // (#1) Body wash — expands with the LEADING ring (ring 0, stagger 0). sin() envelope swells
  // it in, holds at full extent, then dissolves. Single drawImage — no per-frame gradient alloc.
  const leadProg = Math.min(1, prog / RING_TRAVEL)
  if (leadProg > 0) {
    const leadEased = 1 - Math.pow(1 - leadProg, 2.4)
    const bodyRadius = radius * leadEased
    const bodyAlpha = ptSmooth * Math.sin(prog * Math.PI) * 0.5
    if (bodyRadius > 2 && bodyAlpha > 0.005) {
      const sprite = getShockBodySprite(haloR, haloG, haloB)
      const prevA = ctx.globalAlpha
      ctx.globalAlpha = Math.min(1, bodyAlpha)
      const d = bodyRadius * 2
      ctx.drawImage(sprite, cx - bodyRadius, cy - bodyRadius, d, d)
      ctx.globalAlpha = prevA
    }
  }

  // (#2) Ripple rings with a shock-front bias. Ring 0 leads (furthest out) and gets the
  // heaviest width; trailing rings taper to a thin wake. Same path reused for both strokes.
  for (let ring = 0; ring < RING_COUNT; ring++) {
    const stagger = ring * RING_STAGGER
    const ringProg = Math.min(1, Math.max(0, (prog - stagger) / RING_TRAVEL))
    if (ringProg <= 0) continue
    const rEased = 1 - Math.pow(1 - ringProg, 2.4)
    const ringR = radius * rEased
    if (ringR < 2) continue
    const env = Math.sin(ringProg * Math.PI)
    const rAlpha = ptSmooth * env
    if (rAlpha <= 0.005) continue
    const frontBoost = 1 + (1 - ring / (RING_COUNT - 1)) * 0.8   // ring0 1.8x → last 1.0x
    ctx.beginPath()
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${haloR}, ${haloG}, ${haloB}, ${rAlpha * 0.5})`
    ctx.lineWidth = (14 * env + 2) * ptSmooth * frontBoost
    ctx.stroke()
    ctx.strokeStyle = `rgba(${coreR}, ${coreG}, ${coreB}, ${rAlpha * 0.85})`
    ctx.lineWidth = (3 * env + 1) * ptSmooth * frontBoost
    ctx.stroke()
  }
}
function getSnowflakeSprite(): HTMLCanvasElement {
  if (snowflakeSprite) return snowflakeSprite
  const armLen = SNOWFLAKE_REF_SIZE
  const padding = 4        // line caps + crisp core extend slightly past arm end
  const half = Math.ceil(armLen + padding)
  const total = half * 2
  const c = document.createElement('canvas')
  c.width = total; c.height = total
  const sctx = c.getContext('2d')!
  sctx.translate(half, half)
  // Soft halo layer (same colors / widths as the original inline draw)
  sctx.strokeStyle = 'rgba(160, 220, 250, 0.55)'
  sctx.lineWidth = 2.6
  sctx.lineCap = 'round'
  for (let arm = 0; arm < 6; arm++) {
    const aa = (arm / 6) * Math.PI * 2
    sctx.beginPath()
    sctx.moveTo(0, 0)
    sctx.lineTo(Math.cos(aa) * armLen, Math.sin(aa) * armLen)
    sctx.stroke()
  }
  // Crisp white core
  sctx.strokeStyle = 'rgba(240, 250, 255, 0.9)'
  sctx.lineWidth = 1.0
  for (let arm = 0; arm < 6; arm++) {
    const aa = (arm / 6) * Math.PI * 2
    sctx.beginPath()
    sctx.moveTo(0, 0)
    sctx.lineTo(Math.cos(aa) * armLen, Math.sin(aa) * armLen)
    sctx.stroke()
  }
  snowflakeSprite = c
  return c
}
function getIceShardSprite(): HTMLCanvasElement {
  if (iceShardSprite) return iceShardSprite
  const size = ICE_SHARD_REF_SIZE
  const longLen = size * 1.8
  const shortLen = size * 0.55
  const padding = 3
  const half = Math.ceil(longLen + padding)
  const total = half * 2
  const c = document.createElement('canvas')
  c.width = total; c.height = total
  const sctx = c.getContext('2d')!
  sctx.translate(half, half)
  // Elongated diamond — point along +X (rotation applied per-instance via setTransform)
  sctx.beginPath()
  sctx.moveTo(longLen, 0)
  sctx.lineTo(0, shortLen)
  sctx.lineTo(-longLen * 0.7, 0)
  sctx.lineTo(0, -shortLen)
  sctx.closePath()
  sctx.fillStyle = 'rgba(200, 235, 255, 0.85)'
  sctx.fill()
  sctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  sctx.lineWidth = 1.2
  sctx.stroke()
  iceShardSprite = c
  return c
}

function drawParticles(layer: 'below' | 'above' | 'all' | 'underEnemies' = 'all'): void {
  // Load-aware glow gate. The additive glow halo is the dominant per-particle GPU cost (overdraw),
  // so as the pool fills we RAISE the size threshold for drawing it — in a storm only the biggest/
  // brightest particles keep their bloom, killing the fill-rate (non_js) hit exactly when it's the
  // bottleneck. Calm scenes (full LOD) keep the original 2.0 threshold, so they look identical.
  // Computed once per call — particleCount is fixed during the draw loop (no spawning here).
  const glowThresh = 2.0 + (1 - particleLod()) * 2.5   // ~2.0 calm → ~3.7 at the pool cap
  for (let i = 0; i < particleCount; i++) {
    const p = particles[i]!
    // Dormant particles (life < 0 due to spawn delay) — skip until they "wake up"
    if (p.life < 0) continue
    if (layer !== 'all') {
      const isOrbit = p.orbitR > 0
      if (layer === 'underEnemies') {
        if (!p.belowEnemies) continue           // only the under-enemy-body particles
      } else if (layer === 'above') {
        if (!isOrbit) continue
      } else {                                   // 'below'
        if (isOrbit) continue
        if (p.belowEnemies) continue            // these draw in the earlier underEnemies pass
      }
    }
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
      // Color tint — 0.1s delay then fast blend toward target (red or gold for ring explosions).
      // tintLate option pushes the shift into the LAST ~30% of life so particles keep their hot
      // starting color most of their flight and only cool right before dissolving.
      const delay = p.tintLate ? 0.85 : 0.1 / p.lifetime
      const ramp = p.tintLate ? 5.0 : 3.3
      tintBlend = Math.min(1, Math.max(0, p.life - delay) * ramp)
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
    // Additive glow halo — the single most expensive thing per particle (a big soft blob, and
    // 'lighter' blending repaints every pixel it covers). Skip it on SMALL or near-invisible
    // particles: their halo is almost pure overdraw with little visual payoff, and they're the
    // most numerous. Big/bright particles (blood, shards, sparks) keep full bloom. Universal
    // fill-rate win at full resolution — helps phones and PCs alike, no blur.
    const glowAlpha = Math.min(1, alpha * tintBlend * 1.3)
    if (tintBlend > 0 && hs >= glowThresh && glowAlpha > 0.05) {
      const sprite = getGlowSprite(p.tintR, p.tintG, p.tintB)
      const glowScale = Math.max(0.7, hs / 5) * (0.9 + tintBlend * 0.5)
      const dim = sprite.width * glowScale
      const prevAlpha = ctx.globalAlpha
      const prevComp = ctx.globalCompositeOperation
      ctx.globalAlpha = glowAlpha
      ctx.globalCompositeOperation = 'lighter'
      ctx.drawImage(sprite, -dim / 2, -dim / 2, dim, dim)
      ctx.globalAlpha = prevAlpha
      ctx.globalCompositeOperation = prevComp
    }
    if (speed > 60) {
      const angle = Math.atan2(p.vy, p.vx)
      ctx.rotate(angle)
      // Orbit shards get a higher stretch cap so they read as long cutting streaks at high speed.
      // Parent-attached spray (blood + shield shards) gets the same treatment so the fast launch
      // reads as long arterial streaks instead of stubby kites — the cap auto-relaxes as the drop
      // slows (stretch tracks live speed), so settling drops still round out. Plain debris stays 3.
      const stretchCap = (p.orbitR > 0 || p.parent) ? 5 : 3
      const stretch = Math.min(speed / 80, stretchCap)
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

// Render-resolution scale — the scene rasterizes into a backing store of (logical × this), then
// CSS upscales to full screen. <1 cuts GPU fill-rate (the measured bottleneck on hi-DPI screens
// like 2880×1800) at the cost of softness. Logical width/height (camera, UI, input) are unchanged.
// Tunable live via setRenderScale ([ and ] debug keys) to find the sharpness/perf sweet spot.
// Default 1.0 = full crisp resolution. Lowering it is reserved as an automatic safety net for
// weak devices (see adaptive scaling), NOT a baseline — capable hardware stays sharp.
let renderResScale = 1.0
export function setRenderScale(s: number): void {
  renderResScale = Math.max(0.4, Math.min(1, Math.round(s * 100) / 100))
  resize()
}
export function getRenderScale(): number { return renderResScale }

function resize(): void {
  const screenW = canvas.clientWidth || window.innerWidth
  const screenH = canvas.clientHeight || window.innerHeight
  // On small screens, scale up the canvas so it represents a larger view
  const scale = screenH < MIN_VIEW_H ? MIN_VIEW_H / screenH : 1
  width = Math.round(screenW * scale)
  height = Math.round(screenH * scale)
  // Backing store rasterizes at the reduced render scale; the canvas element stays full-size (CSS),
  // so the browser upscales. Logical width/height = CSS size, so camera/UI/input are unaffected.
  canvas.width = Math.max(1, Math.round(width * renderResScale))
  canvas.height = Math.max(1, Math.round(height * renderResScale))
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

/** Draw a regular N-gon path in screen-space (matches getPolygonVertices orientation). */
function polyPathScreen(cx: number, cy: number, r: number, sides: number): void {
  ctx.beginPath()
  const base = Math.PI / 2 + Math.PI / sides
  const stepA = (Math.PI * 2) / sides
  for (let i = 0; i < sides; i++) {
    const a = base + i * stepA
    const vx = cx + Math.cos(a) * r
    const vy = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(vx, vy)
    else ctx.lineTo(vx, vy)
  }
  ctx.closePath()
}

/** Current arena outline vertices in WORLD space for hex OR polygon (both are convex N-gons). */
function arenaConvexVerts(r: number = ARENA_RADIUS): { x: number; y: number }[] {
  return getArenaShape() === 'polygon'
    ? getPolygonVertices(ARENA_CX, ARENA_CY, r, getPolygonSides())
    : getHexVertices(ARENA_CX, ARENA_CY, r)
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
  particleCount = 0
  deathRipples.length = 0
  lightningBolts.length = 0
  spawnEffects.length = 0
  absorbEffects.length = 0
  volatileExplosions.length = 0
  pendingExplosionVisuals = []
  vitGhosts.length = 0; lastSeenBoost = 0; starGlints.length = 0
  revengeRings.length = 0
  ringSnaps.length = 0
  tetherSnaps.length = 0
  toasts.length = 0
  borderWaveIntensity = 0
  globalBeatPulse = 0
  outerPulseIntensity = 0
  dashSweepIntensity = 0
  dashSweepFlash = 0
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
  frameTick++
  if (__DEV__) { dbgRingReq = 0; dbgRingDrop = 0; dbgSlashDrop = 0 }   // per-frame diag reset (poolPeak persists)
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
  const renderZoom = isZoomedDesigner ? DESIGNER_ZOOM : cameraZoom
  if (isZoomedDesigner) {
    camX = ARENA_CX - width / (2 * renderZoom)
    camY = ARENA_CY - height / (2 * renderZoom)
  } else if (cam) {
    camX = cam.x - width / (2 * renderZoom)
    camY = cam.y - height / (2 * renderZoom)
  } else {
    camX = player.x - width / (2 * renderZoom)
    camY = player.y - height / (2 * renderZoom)
  }

  // Live entity counts for the perf overlay (dev-only; noops in release)
  perfCount('enemies', enemies.length)
  perfCount('bullets', enemyBulletVizList.length)
  perfCount('tethers', tetherVizList.length)
  perfCount('particles', particleCount)
  perfCount('bolts', lightningBolts.length)
  perfCount('detons', enemyDetonationVizList.length)

  perfStart('particles_upd'); updateParticles(dt); perfEnd('particles_upd')

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
  // Base render-resolution transform — all drawing uses LOGICAL coords (0..width/height) but
  // rasterizes into the smaller backing store, cutting GPU fill-rate. Re-applied every frame
  // since the nested save/restore + designer-zoom scale ride on top of it.
  ctx.setTransform(renderResScale, 0, 0, renderResScale, 0, 0)
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

  perfStart('arena')
  drawArenaBorder(player)
  // Arena walls — drawn under all entities (floor layer), above the arena fill
  drawWalls()
  // Chill Zone slow-field — on the arena floor, under enemies/orbs/player
  drawChillZone()
  perfEnd('arena')
  perfStart('ripples')
  updateAndDrawDeathRipples(lastDt)
  // Lightning is drawn LATER (just before the player) so the bolts read ON TOP of enemy bodies —
  // including totems — instead of being buried under them. (Was here, under the entities.)
  perfEnd('ripples')

  // NOTE: the arena-bounds clip was removed so ALL animations (rings, orbs, the main particle
  // storm, etc.) spill freely over the edge — consistent with bullets/tethers/blasts, which were
  // always drawn unclipped after this point. (The matching ctx.restore() below was removed too.)

  perfStart('e_occlusion')
  // Pre-compute blocked arcs for all enemies with active rings
  const blockedArcsCache = new Map<Enemy, BlockedArc[]>()
  const allEnemies = getEnemies()
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.dying) continue
    for (const rs of enemy.rings) {
      const ringRadius = rs.ring.radius * getRingExpansion(rs.attackTimer, rs.expandTime)
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

  // Heal sparkles that should sit UNDER enemy bodies — drawn here, just before the bodies, so a
  // healed enemy's gold burst emanates from beneath it (same read as the player heal, whose 'below'
  // pass also precedes its body). Spawned during drawEnemy below, so they first appear next frame.
  perfStart('p_under_enemies'); drawParticles('underEnemies'); perfEnd('p_under_enemies')

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
    if (enemy.weakNodes) drawWeakNodes(enemy)
  }
  perfEnd('e_bodies')

  // Dodge trails — rendered AFTER all enemy bodies so the trail layers on top of any body
  // (otherwise enemies drawn later in the loop cover the dasher's silhouettes). Particles
  // are also spawned here for the same reason — the spawn-then-render is one-frame-correct.
  perfStart('dodge_trails')
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
  perfEnd('dodge_trails')

  perfStart('dash_sweep')
  // Dash sweep band — follows curved dash path
  {
    // Check main ring + all extra rings for peak
    let anyPeak = false
    // Use the SAME peak-capture window as the attack ring (p_ring, below: `< lastDt * 2`) — NOT a
    // fixed 0.03s. A fixed window vs. a frame-scaled one freezes the smear and the ring at different
    // points along the dash when the framerate dips, so the red AOE drifts off the ring. Matching the
    // window means both snapshot the exact same frame → the ring stays flush at the front of the smear.
    const peakWindow = lastDt * 2
    const mainPast = player.attackTimer - ATTACK_EXPAND_TIME
    if (mainPast >= 0 && mainPast < peakWindow) anyPeak = true
    for (let i = 0; i < player.extraRingCount; i++) {
      const extraPast = player.extraRingTimers[i]! - ATTACK_EXPAND_TIME
      if (extraPast >= 0 && extraPast < peakWindow) anyPeak = true
    }

    if (player.dashTimer >= 0 && anyPeak) {
      dashSweepIntensity = 1
      dashSweepFlash = 1   // pop a hot-white flash at the impact frame
      dashSweepRadius = getEffectiveRadius(player) * 1.0  // full radius at peak
      const capStart = Math.floor(player.dashPath.length * 0.7)
      dashSweepPath = player.dashPath.slice(capStart).map(p => ({ x: p.x, y: p.y }))
      dashSweepPath.push({ x: player.x, y: player.y })
    } else {
      // Frame-rate-INDEPENDENT fade: 0.88 per 1/60s of real time, not per rendered frame. A raw
      // per-frame `*= 0.88` decays half as fast at 30fps as at 60fps, so the smear lingers much
      // longer on any framerate dip. Anchoring to lastDt keeps the real-time fade identical at any fps.
      dashSweepIntensity *= Math.pow(0.8, lastDt * 60)   // fade speed (0.8 @ 60fps)
      if (dashSweepIntensity < 0.01) dashSweepIntensity = 0
      dashSweepFlash *= Math.pow(0.4, lastDt * 60)        // hot-white flash dies in ~2-3 frames
      if (dashSweepFlash < 0.02) dashSweepFlash = 0

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
        ctx.strokeStyle = `rgba(255, 210, 80, ${0.62 * fade * (0.3 + posT * 0.7)})`
        ctx.lineWidth = grace * 2
        ctx.stroke()
        // Inner bright core
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 255, 210, ${0.36 * fade * (0.3 + posT * 0.7)})`
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
        ctx.strokeStyle = `rgba(255, 225, 90, ${1.0 * fade})`
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
        ctx.strokeStyle = `rgba(255, 28, 28, ${0.5 * fade})`
        ctx.lineWidth = grace * 1.6
        ctx.stroke()
        // Bright red edges
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius + grace, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 50, 50, ${0.85 * fade})`
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(sx, sy, Math.max(0, dashSweepRadius - grace), 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 50, 50, ${0.85 * fade})`
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
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.72 * fade})`
      ctx.lineWidth = 2
      ctx.stroke()

      // Impact flash — a fat hot-white ring over every smear position for the first ~2-3 frames,
      // drawn LAST so it blows out the color and sells the moment of impact.
      if (dashSweepFlash > 0.02) {
        ctx.beginPath()
        for (const pt of dashSweepPath) {
          const sx = pt.x - camX, sy = pt.y - camY
          ctx.moveTo(sx + dashSweepRadius, sy)
          ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
        }
        ctx.strokeStyle = `rgba(255, 190, 175, ${0.95 * dashSweepFlash})`   // hot white tinted red
        ctx.lineWidth = grace * 1.6
        ctx.stroke()
      }
    }
  }
  perfEnd('dash_sweep')

  perfStart('p_ring')
  // Capture position at ring peak, use it for post-peak so flash + particles align
  const pastPeakPlayer = player.attackTimer - ATTACK_EXPAND_TIME
  if (pastPeakPlayer >= 0 && pastPeakPlayer < lastDt * 2) {
    ringPeakX = player.x
    ringPeakY = player.y
  }
  const ringDrawX = pastPeakPlayer >= 0 ? ringPeakX : player.x
  const ringDrawY = pastPeakPlayer >= 0 ? ringPeakY : player.y
  drawRing(ringDrawX, ringDrawY, player.ring, player.attackTimer, getEffectiveRadius(player), undefined, undefined, player)

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
    drawRing(exDrawX, exDrawY, player.ring, extraTimer, getEffectiveRadius(player), undefined, undefined, player)
  }
  perfEnd('p_ring')

  perfStart('orbs')
  drawXPOrbs(player)
  perfEnd('orbs')

  perfStart('particles')
  drawParticles('below')   // everything except orbit ring shards
  perfEnd('particles')

  perfStart('world_fx')
  drawRitualNodes()

  // Aftershock telegraph — ticking pie under the player marking pending detonations
  updateAndDrawPendingDetonations(lastDt)

  // Echo Step anchor + recall visuals — anchor marker on the ground, ghost streak during warp
  drawEchoStep(player)
  perfEnd('world_fx')

  // Beat dash AOE flash — drawn BEFORE the player so the player visibly stands on top
  perfStart('beatdash_aoe')
  if (beatDashFlash > 0) {
    beatDashFlash -= lastDt
    const t = beatDashFlash / 0.444  // 1→0
    const bsx = beatDashX - camX
    const bsy = beatDashY - camY
    // ── Hitbox-radius arc — built ONCE and reused for 4 fills/strokes (white flash, red fill,
    // red danger edge, cyan border). Canvas2D persists the current path across draw calls,
    // so we save 3 beginPath/arc tessellations per frame. Style is swapped between draws.
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    // (1) White area flash — punchier hot snap on the first frames so the hit reads as an IMPACT
    // (intensity only; still tied to t, so the fade stays exactly as fast).
    const whiteAlpha = t > 0.7 ? t * 0.55 : t * t * 0.22
    ctx.fillStyle = `rgba(255, 255, 255, ${whiteAlpha})`
    ctx.fill()
    // Total-area gold glow flash — its OWN path (different radius=glowR), so it's separated
    {
      const glowR = beatDashRadius * 1.5
      const grad = ctx.createRadialGradient(bsx, bsy, 0, bsx, bsy, glowR)
      // Gold glow dialed back so it no longer dominates — the AOE should read as an ATTACK, not
      // blend with the gold heal/overheal/boost effects. Red + white-hot now lead.
      grad.addColorStop(0, `rgba(255, 240, 160, ${t * 0.5})`)
      grad.addColorStop(0.38, `rgba(255, 215, 90, ${t * 0.32})`)
      grad.addColorStop(0.85, `rgba(255, 190, 50, ${t * 0.1})`)
      grad.addColorStop(1, `rgba(255, 180, 40, 0)`)
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.arc(bsx, bsy, glowR, 0, Math.PI * 2)
      ctx.fillStyle = grad
      ctx.fill()
      ctx.globalCompositeOperation = prevComp
    }
    // (2) Red danger fill, (3) Red danger edge stroke, (4) Cyan border stroke — all share
    // the SAME hitbox-radius arc. Rebuild the path once and chain styles.
    ctx.beginPath()
    ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 40, 40, ${t * t * 0.74})`
    ctx.fill()
    // Gold shockwave expanding to fill attack range — its own path (different radius=shockR)
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
      // Rebuild hitbox-radius path for the remaining red/cyan strokes (current path is now shockR)
      ctx.beginPath()
      ctx.arc(bsx, bsy, beatDashRadius, 0, Math.PI * 2)
    }
    // Red danger edge — bolder, brighter, more saturated outline so the AOE boundary is an
    // unmistakable hit-zone ring (thickness still scales with t → same fast fade).
    ctx.strokeStyle = `rgba(255, 30, 30, ${t * 0.95})`
    ctx.lineWidth = 6 * t + 4
    ctx.stroke()
    // Cyan border — reuses same arc path
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
    // ── Per-enemy "bite" — searing flash on the EXACT overlap of the blast and each damaged enemy.
    // Clip to the enemy circle and fill/stroke the AOE circle, so only the circle-circle lens paints
    // (pixel-perfect — handles partial overlap AND fully-engulfed for free). Gated on beatDashFlash so
    // only enemies the dash actually damaged bite (Reverb / out-of-range enemies don't). Additive
    // white-hot → red on the SAME `t`, so it fades exactly as fast as the rest of the flash.
    const biteR = beatDashRadius
    const prevBiteComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    for (const e of enemies) {
      if (e.beatDashFlash <= 0 || !e.alive) continue
      const ex = e.x - camX, ey = e.y - camY
      const ddx = ex - bsx, ddy = ey - bsy
      if (ddx * ddx + ddy * ddy > (biteR + e.radius) * (biteR + e.radius)) continue   // no overlap
      ctx.save()
      ctx.beginPath(); ctx.arc(ex, ey, e.radius, 0, Math.PI * 2); ctx.clip()   // confine to the enemy
      // Hot sear fill — white-hot early, cooling to red as t fades.
      ctx.beginPath(); ctx.arc(bsx, bsy, biteR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(255, ${Math.floor(80 + t * 175)}, ${Math.floor(60 + t * 180)}, ${t * 0.55})`
      ctx.fill()
      // Seam — the blast boundary slicing through the enemy = the cut line. Bright, thin, white-hot.
      ctx.lineWidth = 2 + t * 2.5
      ctx.strokeStyle = `rgba(255, ${Math.floor(150 + t * 105)}, ${Math.floor(120 + t * 135)}, ${t * 0.9})`
      ctx.stroke()
      ctx.restore()
    }
    ctx.globalCompositeOperation = prevBiteComp
  }
  perfEnd('beatdash_aoe')

  perfStart('shockpush')
  // Reverb shock-push — a dense cascade of expanding wave rings, each staggered slightly so
  // they ripple outward like a fast sonar burst. Ease-out expansion for an impact feel. The
  // OUTERMOST ring reaches exactly shockPushRadius (= the max push range), so what you see is
  // what gets pushed. Drawn AFTER the gold damage flash so the cyan reads clearly on top.
  if (shockPushFlash > 0) {
    shockPushFlash -= lastDt
    const pt = Math.max(0, shockPushFlash / SHOCK_PUSH_DURATION)   // 1 → 0
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    // Reverb's signature cyan: soft halo + bright inner stripe. shockPushRadius = push range,
    // so the body wash + rings scale exactly with the (larger/grown) push zone.
    drawShockWave(ctx, shockPushX - camX, shockPushY - camY, shockPushRadius, pt,
      70, 195, 255, 190, 240, 255)
    ctx.globalCompositeOperation = prevComp
  }

  // Enemy push-mode shock-push waves — list-based version, custom color per entry. Drawn
  // here (BELOW the player) so the cyan player-reverb visual still wins layering when it
  // co-occurs. Mirrors the player shockpush layout: 7 staggered rings, ease-out expansion.
  if (enemyShockPushes.length > 0) {
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    for (let i = enemyShockPushes.length - 1; i >= 0; i--) {
      const w = enemyShockPushes[i]!
      w.timer += lastDt
      if (w.timer >= ENEMY_SHOCK_DUR) {
        enemyShockPushes[i] = enemyShockPushes[enemyShockPushes.length - 1]!
        enemyShockPushes.pop()
        continue
      }
      const pt = 1 - w.timer / ENEMY_SHOCK_DUR     // 1 → 0
      // Brighter mid color for the inner stripe (white-tinted ring color). w.radius = push
      // range, so the body + rings scale with each push's own zone.
      const tR = Math.min(255, w.r + 110)
      const tG = Math.min(255, w.g + 110)
      const tB = Math.min(255, w.b + 110)
      drawShockWave(ctx, w.x - camX, w.y - camY, w.radius, pt, w.r, w.g, w.b, tR, tG, tB)
    }
    ctx.globalCompositeOperation = prevComp
  }
  perfEnd('shockpush')

  // Lightning bolts (beat-dash AOE-center + enemy-hit + shield-break) — drawn here, AFTER all enemy
  // bodies/totems/effects but BEFORE the player, so the bolts read on top of the enemies they hit.
  perfStart('bolts'); updateAndDrawLightningBolts(lastDt); perfEnd('bolts')

  perfStart('player')
  drawPlayer(player)   // (boost star burst is drawn inside, under the dash dots so they stay readable)
  perfEnd('player')

  // Above-player pass for orbit ring shards — when the player is standing at the ring center,
  // these draw ON TOP of the player so the hit/cut clearly reads. Other particles already
  // drew below the player above so the player stays visually layered above ambient effects.
  perfStart('p_above'); drawParticles('above'); perfEnd('p_above')

  // Bolt (Dash-shot) projectiles — ball lightning + lance + muzzle. Drawn AFTER the player so
  // the discharge orb and connecting arc visually stack ON TOP of the player at spawn moment,
  // making the "I fired the bolt" beat punch readable instead of getting buried under the body.
  perfStart('dashshots'); updateAndDrawDashShots(lastDt); perfEnd('dashshots')

  // Blue lightning burst — fired by Reverb at the explosion point. Same arc vocabulary as
  // the Bolt's crackle so the visual language stays consistent.
  perfStart('lightning'); updateAndDrawLightningBursts(lastDt); perfEnd('lightning')

  // Enemy ranged bullets + detonations — Phase 1 minimal visuals: bullet body dot + trail
  // tinted to the enemy's color, detonation ring expanding from the bullet's landing position.
  perfStart('bullets'); drawEnemyBulletsAndDetonations(player); perfEnd('bullets')
  // Tether beams — bright damaging lines snapped between salvo siblings at the detonation
  // beat. Drawn AFTER detonations so beams overlay the expanding rings.
  perfStart('tethers'); updateAndDrawTethers(lastDt); perfEnd('tethers')

  // Volatile / explode-mode blast — drawn AFTER player + enemies + bullets so the red blast
  // radius + flash stack OVER everything (it was under the entities before and got hidden).
  perfStart('volatile'); updateAndDrawVolatileEffects(lastDt); perfEnd('volatile')

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
          drawRing(origin.x, origin.y, rs.ring, rs.attackTimer, undefined, rs.expandTime, arcs, enemy)
        }
      }
    }
  }
  updateAndDrawRevengeRings(lastDt)
  perfEnd('e_rings_overlay')

  // Chill Zone climax visuals — ice shards flying inward + frost-crack shock-ring. Drawn
  // ABOVE enemies + rings so the ice storm reads as the climactic event of the replacement.
  perfStart('chill_fx'); updateAndDrawChillFX(lastDt); perfEnd('chill_fx')

  // Dash-fail flash timer (just decrements — read by pie render to tint red)
  if (dashFailFlash > 0) { dashFailFlash -= lastDt; if (dashFailFlash < 0) dashFailFlash = 0 }

  perfStart('spawn_fx')
  updateAndDrawSpawnEffects(lastDt)
  updateAndDrawAbsorbEffects(lastDt, player)
  perfEnd('spawn_fx')

  if (__DEV__) {
    drawDesignerPreview(player)
    drawSpawnPanel()
    drawChallengePlacements()
  }

  // Damage-frame red snaps — DEAD LAST in world space so they sit on top of every ring, bullet,
  // tether, and the entire particle flurry. This is what makes the "this is the hit" read clear.
  perfStart('ring_snaps'); updateAndDrawRingSnaps(lastDt); updateAndDrawTetherSnaps(lastDt); perfEnd('ring_snaps')

  // End designer zoom-out transform — HUD and UI render in unscaled screen space below
  if (renderZoom !== 1) {
    ctx.restore()
  }

  // On-beat dash screen confirmation — vignette pulse + corner brackets. Drawn in screen space
  // (no camera offset) AFTER the world transform is restored so it overlays everything, but
  // BEFORE the HUD so HUD text + dash pies stay readable on top.
  perfStart('beatdash_confirm'); updateAndDrawBeatDashConfirm(lastDt); perfEnd('beatdash_confirm')

  perfStart('hud'); drawHUD(player, enemies, fps); perfEnd('hud')
  if (getPhase() === 'playing' || getPhase() === 'designer') drawMusicButton()
  perfEnd('R_TOTAL')
  if (__DEV__) {
    perfCount('ringReq', dbgRingReq)     // ring shards asked for this frame
    perfCount('ringDrop', dbgRingDrop)   // ...dropped by a full pool (≈ringReq → throttling is the cause)
    perfCount('poolPeak', dbgPoolAtPeak) // pool level when a ring last peaked (≈cap → pool was full)
    perfCount('slashDrop', dbgSlashDrop) // tether slashes dropped by a full pool
  }
  perfFlush()

  // Perf overlay — dev only, gated. Values are avg ms/frame (perfDisplay), refreshed ~2×/sec.
  // Sections sorted by cost so the expensive ones surface at the top; the two TOTAL rows are
  // pinned/colored as headlines. A counts panel shows live entity counts (the things that
  // drive cost). `\` toggles, `p` exports the raw per-frame CSV.
  if (__DEV__ && debugOverlayVisible) {
    const entries = Object.entries(perfDisplay)
    if (entries.length > 0) {
      const uTotal = perfDisplay['U_TOTAL'] ?? 0
      const dTotal = perfDisplay['D_TOTAL'] ?? 0   // designer-update path (gameplay uses U_TOTAL)
      const pTotal = perfDisplay['PHASE_UPD'] ?? 0 // menu/shop/upgrade update path
      const rTotal = perfDisplay['R_TOTAL'] ?? 0
      const updTotal = uTotal + dTotal + pTotal     // only one runs per frame, so summing is safe
      const frameMs = updTotal + rTotal
      // GC/GPU/step attribution (averaged) — answers "section, GC, or GPU?" without exporting.
      const gcMs = perfDerivedDisplay['unacc_js'] ?? 0
      const gpuMs = perfDerivedDisplay['non_js'] ?? 0
      const logicMs = perfDerivedDisplay['u_unacc'] ?? 0
      const steps = perfDerivedDisplay['update_steps'] ?? 0
      // Section rows: drop the totals (shown in the header) + sub-ms noise, sort desc.
      const rows = entries
        .filter(([k, v]) => k !== 'U_TOTAL' && k !== 'D_TOTAL' && k !== 'PHASE_UPD' && k !== 'R_TOTAL' && v >= 0.02)
        .sort((a, b) => b[1] - a[1])
      const counts = Object.entries(perfCountDisplay)
      const lineH = 13
      const headerRows = 4
      const countRows = Math.ceil(counts.length / 2)
      const worstRows = perfWorstDisplay ? 3 : 0
      const boxW = 248
      const boxH = (headerRows + rows.length + 1 + countRows + worstRows) * lineH + 14
      const bx = width - boxW
      const by = 130
      ctx.fillStyle = 'rgba(0,0,0,0.74)'
      ctx.fillRect(bx, by, boxW, boxH)
      ctx.textAlign = 'left'
      ctx.font = '11px monospace'
      let py = by + 13
      // ── Header: fps + frame budget (60fps = 16.7ms, 120fps = 8.3ms) ──
      ctx.fillStyle = '#7CCFFF'
      ctx.fillText('PERF   \\ hide   p export', bx + 6, py); py += lineH
      ctx.fillStyle = frameMs > 12 ? '#FF5252' : frameMs > 8 ? '#FFD740' : '#9CFF9C'
      ctx.fillText(`${fps}fps  ${frameMs.toFixed(1)}ms  res x${renderResScale.toFixed(2)}`, bx + 6, py); py += lineH
      ctx.fillStyle = '#7CCFFF'
      ctx.fillText(`upd ${updTotal.toFixed(2)}   ren ${rTotal.toFixed(2)}`, bx + 6, py); py += lineH
      // gc = JS outside the timed totals (alloc/GC); gpu = wall-clock outside JS; logic = untimed
      // code inside the update path; steps = update passes this frame (>1 = catch-up spiral).
      ctx.fillStyle = (gcMs > 2 || logicMs > 2 || steps > 1.2) ? '#FFAA6A' : '#8FA0C0'
      ctx.fillText(`gc ${gcMs.toFixed(2)} gpu ${gpuMs.toFixed(2)} logic ${logicMs.toFixed(2)} st ${steps.toFixed(1)}`, bx + 6, py); py += lineH
      // ── Sections, sorted by cost (avg/max ms) ──
      for (const [k, ms] of rows) {
        const pct = frameMs > 0 ? (ms / frameMs) * 100 : 0
        const mx = perfMaxDisplay[k] ?? 0
        ctx.fillStyle = mx > 4 ? '#FF5252' : ms > 1 ? '#FFD740' : '#9a9a9a'
        ctx.fillText(`${k.padEnd(12)}${ms.toFixed(2)}/${mx.toFixed(1)} ${pct.toFixed(0)}%`, bx + 6, py)
        py += lineH
      }
      // ── Worst recent frame (the felt hitch) + its top contributors ──
      if (perfWorstDisplay && perfWorstDisplay.frameMs > 0) {
        py += lineH * 0.4
        ctx.fillStyle = perfWorstDisplay.frameMs > 24 ? '#FF5252' : '#FFD740'
        ctx.fillText(`WORST ${perfWorstDisplay.frameMs.toFixed(1)}ms  ${perfWorstDisplay.phase}`, bx + 6, py); py += lineH
        const contrib = Object.entries(perfWorstDisplay.row)
          .filter(([k]) => k.charCodeAt(0) !== 35 && k !== 'FRAME_REAL' && k !== 'TICK_JS' && !k.endsWith('_TOTAL') && k !== 'PHASE_UPD' && k !== 'update_steps')
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
        ctx.fillStyle = '#c0b0b0'
        ctx.fillText(contrib.map(([k, v]) => `${k} ${v.toFixed(1)}`).join('  '), bx + 6, py); py += lineH
      }
      // ── Live counts (2 columns) ──
      py += lineH * 0.4
      ctx.fillStyle = '#6CC0FF'
      let col = 0
      for (const [k, n] of counts) {
        const cx = col % 2 === 0 ? bx + 6 : bx + boxW * 0.5
        ctx.fillText(`${k} ${n}`, cx, py)
        col++
        if (col % 2 === 0) py += lineH
      }
    }
  }
}

// ── Cached fine-grid pattern ────────────────────────────────────────────────────────────────
// The background grid is full-screen thin lines, redrawn every frame and pulsing with the beat —
// the single most GPU-fill-heavy, least-cacheable thing on screen, so it's the first element to
// stutter on a slower compositor path (Chrome vs Brave, or a packaged Chromium / Steam build).
// We bake ONE grid cell into a tiny offscreen tile and fill the screen with a repeating pattern
// (one fill op instead of hundreds of strokes). The colour/width pulse is baked per quantised
// level (tile rebuilt only when the level or device-cell size changes); the SMOOTH alpha pulse and
// camera scroll are applied per frame via globalAlpha + a fractional pattern transform, so it looks
// the same but costs a fraction. Falls back to direct stroking if patterns are ever unavailable.
const GRID_PULSE_LEVELS = 8
let gridTile: HTMLCanvasElement | null = null
let gridPattern: CanvasPattern | null = null
let gridTileLevel = -1
let gridTileCellDev = 0   // device px per cell the tile was baked at (invalidates on zoom/res change)

function buildGridTile(cellDev: number, level: number): void {
  const pulse = (level / (GRID_PULSE_LEVELS - 1)) * 0.5   // representative pulse for this level
  const tile = gridTile ?? document.createElement('canvas')
  tile.width = cellDev
  tile.height = cellDev
  const tctx = tile.getContext('2d')
  if (!tctx) { gridTile = null; gridPattern = null; return }
  tctx.clearRect(0, 0, cellDev, cellDev)
  const gR = Math.floor(100 + pulse * 150)
  const gG = Math.floor(130 + pulse * 110)
  const gB = Math.floor(200 + pulse * 60)
  // Bake at FULL alpha — the per-frame globalAlpha applies the actual (smooth) gridAlpha. Line
  // width matches the original's device width: (0.5 + pulse*0.5) logical × the cell's scale factor.
  tctx.strokeStyle = `rgb(${gR}, ${gG}, ${gB})`
  tctx.lineWidth = (0.5 + pulse * 0.5) * (cellDev / 8)
  tctx.beginPath()
  tctx.moveTo(0.5, 0); tctx.lineTo(0.5, cellDev)   // left edge  → vertical grid lines
  tctx.moveTo(0, 0.5); tctx.lineTo(cellDev, 0.5)   // top edge   → horizontal grid lines
  tctx.stroke()
  gridTile = tile
  gridPattern = ctx.createPattern(tile, 'repeat')
  gridTileLevel = level
  gridTileCellDev = cellDev
}

function drawGrid(player: Player): void {
  const cellSize = GRID_CELL_PX
  // drawGrid runs INSIDE the ctx.scale(renderZoom) transform, so the screen coords we draw
  // at get multiplied by zoom. To cover the FULL visible area at any zoom, our "screen
  // extent" in pre-transform units is (width/zoom, height/zoom). Without this, vignette
  // and fine grid only cover the top-left zoom*zoom rect, leaving the right/bottom bare
  // (visible as a different shade because the bg fill underneath shows through unblended).
  const zoomNow = (designerZoomedOut && getPhase() === 'designer') ? DESIGNER_ZOOM : cameraZoom
  const effW = width / zoomNow
  const effH = height / zoomNow

  // Fine grid texture — pulses with the global beat. globalBeatPulse caps at 0.5, so we use
  // larger multipliers to actually move the needle. Baseline near-invisible, peak clearly
  // visible especially around the player where the dark vignette doesn't suppress it.
  // Color shifts toward warm lavender-cyan at peak so it reads as the grid being LIT, not
  // just brighter. Line width also bumps slightly for an extra "energized" feel.
  {
    const gridSize = 8
    const gridAlpha = 0.05 + globalBeatPulse * 0.40   // ~0.05 → ~0.25 at peak (0.5)
    // Device px per logical px in this (renderResScale × zoom) transform — the tile is baked at
    // this scale so the pattern blits 1:1 in device space and stays crisp at any zoom / res scale.
    const scale = renderResScale * zoomNow
    const cellDev = Math.max(2, Math.round(gridSize * scale))
    const level = Math.max(0, Math.min(GRID_PULSE_LEVELS - 1, Math.round((globalBeatPulse / 0.5) * (GRID_PULSE_LEVELS - 1))))
    if (!gridPattern || gridTileCellDev !== cellDev || gridTileLevel !== level) buildGridTile(cellDev, level)
    if (gridPattern) {
      // Fill in DEVICE space (identity transform) so the baked tile blits 1:1 — no re-scaling, no
      // blur. Pattern offset = camera scroll in device px; fractional → smooth sub-pixel scrolling
      // (no 1px snap). One fillRect replaces the per-frame stroke storm.
      const offX = -(camX * scale) % cellDev
      const offY = -(camY * scale) % cellDev
      gridPattern.setTransform({ a: 1, b: 0, c: 0, d: 1, e: offX, f: offY })
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = gridAlpha
      ctx.fillStyle = gridPattern
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
    } else {
      // Fallback — original direct stroking if patterns are unavailable for any reason.
      const startX = Math.floor(camX / gridSize) * gridSize
      const startY = Math.floor(camY / gridSize) * gridSize
      const gR = Math.floor(100 + globalBeatPulse * 150)
      const gG = Math.floor(130 + globalBeatPulse * 110)
      const gB = Math.floor(200 + globalBeatPulse * 60)
      ctx.strokeStyle = `rgba(${gR}, ${gG}, ${gB}, ${gridAlpha})`
      ctx.lineWidth = 0.5 + globalBeatPulse * 0.5
      ctx.beginPath()
      for (let gx = startX; gx < camX + effW + gridSize; gx += gridSize) {
        const sx = gx - camX
        ctx.moveTo(sx, 0)
        ctx.lineTo(sx, effH)
      }
      for (let gy = startY; gy < camY + effH + gridSize; gy += gridSize) {
        const sy = gy - camY
        ctx.moveTo(0, sy)
        ctx.lineTo(effW, sy)
      }
      ctx.stroke()
    }
  }

  // Inner vignette — spotlight centered on player, edges darken
  const psx = player.x - camX
  const psy = player.y - camY
  const shape = getArenaShape()
  const maxR = shape === 'circle' ? ARENA_RADIUS
    : shape === 'hex' ? ARENA_RADIUS
    : shape === 'polygon' ? ARENA_RADIUS
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
  ctx.fillRect(0, 0, effW, effH)

  // Background ripple — beat-blast wave passing through the floor. Drawn AFTER the dark
  // vignette so the vignette doesn't dim it as it travels toward the screen edges. Constant
  // alpha through the full lifetime (no fade) so the wave keeps the same visible brightness
  // until it simply disappears past the edge. Wide soft band + gradient on both sides =
  // no defined edge → reads as the floor briefly washed by a wave, not as a ring attack.
  if (bgRipple) {
    bgRipple.time += lastDt
    if (bgRipple.time >= bgRipple.lifetime) {
      bgRipple = null
    } else {
      const t = bgRipple.time / bgRipple.lifetime
      const eased = 1 - Math.pow(1 - t, 2)
      const radius = BG_RIPPLE_MAX_RADIUS * eased
      const bandWidth = 130
      const sx = bgRipple.x - camX
      const sy = bgRipple.y - camY
      // Constant alpha (small fade-in only over first 6% so it doesn't pop in jarringly)
      const fadeIn = Math.min(1, t / 0.06)
      const alphaEnv = fadeIn * 0.057
      if (alphaEnv > 0.005 && radius > 1) {
        const innerR = Math.max(0, radius - bandWidth)
        const outerR = radius + bandWidth
        const grad = ctx.createRadialGradient(sx, sy, innerR, sx, sy, outerR)
        grad.addColorStop(0, 'rgba(160, 195, 250, 0)')
        grad.addColorStop(0.5, `rgba(190, 215, 255, ${alphaEnv})`)
        grad.addColorStop(1, 'rgba(160, 195, 250, 0)')
        const prevComp = ctx.globalCompositeOperation
        ctx.globalCompositeOperation = 'lighter'
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, effW, effH)
        ctx.globalCompositeOperation = prevComp
      }
    }
  }
}

function drawArenaBorder(player: Player): void {
  // drawArenaBorder runs INSIDE the ctx.scale(renderZoom) transform like drawGrid does.
  // Use effective screen size so the clipped/filled rects cover the FULL visible area at
  // any zoom — otherwise the outer-pulse glow + buffer fade only paint the top-left
  // (width*zoom × height*zoom) rect and the rest goes unblended.
  const zoomNow = (designerZoomedOut && getPhase() === 'designer') ? DESIGNER_ZOOM : cameraZoom
  const effW = width / zoomNow
  const effH = height / zoomNow
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
    // Decay rate modulated by beat-dash boost — when bdb is active, the wave intensity decays
    // notably slower so the exaggerated swell lingers and the wave shrinks gradually instead
    // of snapping back. bdb is read BEFORE it decays below; once it tapers to 0, decay returns
    // to baseline so the regular beat wave timing is preserved.
    // dtRef = lastDt * 30 normalizes per-frame rates to a 30fps reference so the lifetime feels
    // the same at any framerate (looked great at 30fps, was way too snappy at 60fps).
    const dtRef = lastDt * 30
    // Baseline 0.89 — normal beat wiggle settles a touch earlier than 0.92. The +bdb factor
    // still slows decay during the boost so the special wave can linger.
    borderWaveIntensity *= Math.pow(0.89 + beatDashBorderBoost * 0.065, dtRef)
    if (borderWaveIntensity < 0.005) borderWaveIntensity = 0
  }
  // On-beat-dash boost decay (dt-corrected, 30fps reference) — tuned so the special wave is
  // mostly out of the way by the time the next normal beat fires (~1s later), to avoid the
  // pink color tint + amplitude multiplier interfering with the next beat's clean cyan wave.
  // After 1s, bdb ≈ 0.116 (small pink hint), wave amp negligible.
  beatDashBorderBoost *= Math.pow(0.93, lastDt * 30)
  if (beatDashBorderBoost < 0.005) beatDashBorderBoost = 0

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
    // Outer clip rect must use the effective viewport, not raw width/height, otherwise the
    // clip region itself is confined to the old (zoom=1) viewport and the buffer fade only
    // paints inside it — leaving the L-band past the old viewport bare on right/bottom.
    ctx.rect(0, 0, effW, effH)
    if (arenaShape === 'cross') {
      crossPath(acx, acy, true)
    } else if (arenaShape === 'pill') {
      pillPath(acx, acy, PILL_HALF_W, PILL_R, true)
    } else if (arenaShape === 'hex' || arenaShape === 'polygon') {
      const verts = arenaConvexVerts()
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
    ctx.fillRect(0, 0, effW, effH)
    ctx.restore()
  } else {
    // Darken the ENTIRE outside of the rect with a TRUE distance-from-edge fade so it matches the
    // round arenas everywhere (no seams). Straight sides use a perpendicular (linear) fade; the four
    // corners use a RADIAL fade centered on the rect corner — so the darkness is identical at equal
    // distance from the play area all the way around, including the corners. Every gradient clamps to
    // 0.85 beyond the buffer width → uniform dark void far out, soft 0.3 near the edge so the glow
    // reads as "lit." The 4 sides + 4 corners tile the whole surround with no overlaps and no gaps.
    const c0 = 'rgba(0, 0, 0, 0.3)'
    const c1 = 'rgba(0, 0, 0, 0.85)'
    const xr = x + w, yb = y + h
    // ── Straight sides (over the edge span only) ──
    const topGrad = ctx.createLinearGradient(0, y, 0, y - buffer)
    topGrad.addColorStop(0, c0); topGrad.addColorStop(1, c1)
    ctx.fillStyle = topGrad; ctx.fillRect(x, 0, w, y)
    const botGrad = ctx.createLinearGradient(0, yb, 0, yb + buffer)
    botGrad.addColorStop(0, c0); botGrad.addColorStop(1, c1)
    ctx.fillStyle = botGrad; ctx.fillRect(x, yb, w, effH - yb)
    const leftGrad = ctx.createLinearGradient(x, 0, x - buffer, 0)
    leftGrad.addColorStop(0, c0); leftGrad.addColorStop(1, c1)
    ctx.fillStyle = leftGrad; ctx.fillRect(0, y, x, h)
    const rightGrad = ctx.createLinearGradient(xr, 0, xr + buffer, 0)
    rightGrad.addColorStop(0, c0); rightGrad.addColorStop(1, c1)
    ctx.fillStyle = rightGrad; ctx.fillRect(xr, y, effW - xr, h)
    // ── Corners (radial fade out from the corner point) ──
    const corner = (ccx: number, ccy: number, rx: number, ry: number, rw: number, rh: number) => {
      const g = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, buffer)
      g.addColorStop(0, c0); g.addColorStop(1, c1)
      ctx.fillStyle = g; ctx.fillRect(rx, ry, rw, rh)
    }
    corner(x,  y,  0,  0,  x,        y)              // top-left
    corner(xr, y,  xr, 0,  effW - xr, y)             // top-right
    corner(x,  yb, 0,  yb, x,        effH - yb)      // bottom-left
    corner(xr, yb, xr, yb, effW - xr, effH - yb)     // bottom-right
  }

  perfEnd('buf_zone')
  perfStart('glow')
  // Border color — normally arena cyan (79, 195, 247). Lerps toward hot pink (255, 115, 200)
  // during the beat-dash boost so the whole arena edge reads as ONE cohesive system with the
  // pink waveform riding on it (instead of pink wave on cyan border — visual clash). Subtler
  // blend than the wave (max ~45% pink) so the border still identifies as the arena rim, not
  // a pink stripe. Tapers back to cyan as bdb fades.
  const bdb = beatDashBorderBoost
  const borderPinkBlend = Math.min(bdb * 0.55, 0.45)
  const brdR = Math.floor(79  + (255 - 79)  * borderPinkBlend)
  const brdG = Math.floor(195 + (115 - 195) * borderPinkBlend)
  const brdB = Math.floor(247 + (200 - 247) * borderPinkBlend)
  // Arena border — layered glow with beat pulse
  const drawBorder = (alpha: number, lw: number, offset = 0) => {
    ctx.strokeStyle = `rgba(${brdR}, ${brdG}, ${brdB}, ${alpha})`
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
    } else if (arenaShape === 'polygon') {
      polyPathScreen(acx, acy, ARENA_RADIUS + offset, getPolygonSides())
      ctx.stroke()
    } else if (arenaShape === 'circle') {
      ctx.beginPath()
      ctx.arc(acx, acy, ARENA_RADIUS + offset, 0, Math.PI * 2)
      ctx.stroke()
    } else {
      ctx.strokeRect(x - offset, y - offset, w + offset * 2, h + offset * 2)
    }
  }
  // Border alphas — additive beat-dash boost layered on top of the normal beat pulse so the
  // border punches THROUGH the warm-gold flash from the on-beat-dash confirmation. Each layer
  // gets progressively more boost (inner layers brighter than outer halo) so the ARENA edge
  // remains visually dominant during the flash, not buried under the gold rim.
  drawBorder(0.03 + beatPulse * 0.04 + bdb * 0.08, 30 + bdb * 8, 10)
  drawBorder(0.06 + beatPulse * 0.06 + bdb * 0.14, 18 + bdb * 6, 4)
  drawBorder(0.12 + beatPulse * 0.10 + bdb * 0.25, 8 + bdb * 4, 0)
  drawBorder(0.40 + beatPulse * 0.25 + bdb * 0.55, 2 + bdb * 2, 0)

  perfEnd('glow')
  perfStart('waveform')
  // Waveform line — spikes on beat, flattens out smoothly. On-beat-dash boost adds an
  // explicit amplitude multiplier on top so the wave really swings out through the gold flash.
  if (borderWaveIntensity > 0.005) {
    const baseAmp = borderWaveIntensity * 11 * (1 + bdb * 1.1)
    // Lower frequency during beat-dash boost — wider, slower-undulating waves that read as
    // heavier / more dramatic than the normal tight ripple. Returns to 0.25 as bdb tapers.
    const freq = 0.25 * (1 - bdb * 0.55)
    // Time-phase scaling to keep crest travel speed constant despite the lower freq. Without
    // this, lowering freq makes the crests shift across the arena faster (phase velocity =
    // 1/freq), reading as a "moving so fast" wave. Scaling t by (freq/0.25) cancels it out.
    const tScale = freq / 0.25
    const alpha = Math.min(borderWaveIntensity * 1.5, 0.85)
    const step = 5
    const t = performance.now() * 0.005

    const whiteBlend = Math.min(borderWaveIntensity * 0.6, 0.4)
    // Beat-dash boost shifts the wave color from arena cyan (79,195,247) toward deep saturated
    // hot pink (255,40,165). The whiteBlend (which lifts color toward white at high intensity)
    // is dampened during the boost so the pink stays vivid instead of washing to a pale
    // lavender. Matches the bracket accent + ember palette. Tapers with bdb so the wave
    // returns to its normal arena cyan + white-blend behavior as the boost fades.
    const pinkBlend = Math.min(bdb * 1.3, 0.97)
    const baseR = 79  + (255 - 79)  * pinkBlend
    const baseG = 195 + (115 - 195) * pinkBlend
    const baseB = 247 + (200 - 247) * pinkBlend
    const effectiveWhite = whiteBlend * (1 - bdb * 0.35)
    const cr = Math.floor(baseR + (255 - baseR) * effectiveWhite)
    const cg = Math.floor(baseG + (255 - baseG) * effectiveWhite)
    const cb = Math.floor(baseB + (255 - baseB) * effectiveWhite)

    const coreWidth = 1 + borderWaveIntensity * 2
    const midWidth = 3 + borderWaveIntensity * 3
    const outerWidth = 6 + borderWaveIntensity * 6

    const px = player.x
    const py = player.y

    // Vary frequency scales with the same (1 - bdb * 0.55) factor as the main wave so the
    // per-position amplitude modulation stays in proportion. Without this, slowing only the
    // main wave leaves the vary at its tight 0.73 rate — reads as two conflicting waves
    // (slow swell + fast wiggle on top).
    const varyFreqMul = 1 - bdb * 0.55
    const vary = (i: number, seed: number) => {
      const h = Math.sin(i * 0.73 * varyFreqMul + seed * 3.17) * 0.5 + 0.5
      return 0.3 + h * 0.7
    }

    // ── Compute waveform points once into wavePts, stroke 3x ──
    wavePts.length = 0
    let totalLen = 0
    const waveStep = arenaShape === 'cross' ? 12 : step
    const addWavePt = (wx: number, wy: number, nx: number, ny: number, prox: number, seed: number) => {
      const wave = Math.sin(totalLen * freq + t * tScale) * baseAmp * prox * vary(Math.floor(totalLen), seed)
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
    } else if (arenaShape === 'hex' || arenaShape === 'polygon') {
      const verts = arenaConvexVerts()
      const n = verts.length
      for (let e = 0; e < n; e++) {
        const v0 = verts[e]!, v1 = verts[(e + 1) % n]!
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
    // Clip to outside arena only. Outer rect must use the EFFECTIVE viewport (width/zoom)
    // not raw width/height, otherwise the outer pulse glow only paints in the old viewport
    // rect and the L-band past the original viewport gets no glow.
    ctx.beginPath()
    ctx.rect(0, 0, effW, effH)
    if (arenaShape === 'cross') {
      crossPath(acx, acy, true)
    } else if (arenaShape === 'pill') {
      pillPath(acx, acy, PILL_HALF_W, PILL_R, true)
    } else if (arenaShape === 'hex' || arenaShape === 'polygon') {
      const verts = arenaConvexVerts()
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
    ctx.fillRect(0, 0, effW, effH)
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

// ── Damage-frame red SNAP — top-most overlay ────────────────────────────────────────────────
// The red "this is the hit" ring used to draw inline in drawRing, where it got buried under the
// particle flurry (player ring) or fought same-radius shards (enemy rings). Instead, on the exact
// peak/damage frame the ring pushes a snap here, and we draw the whole list DEAD LAST (after every
// particle pass) so it's guaranteed on top. Fat-then-thin width + 0.2s fade, same as before.
interface RingSnap { x: number; y: number; radius: number; timer: number; arcs: BlockedArc[]; follow: { x: number; y: number } | null; offX: number; offY: number; flash: boolean }
const ringSnaps: RingSnap[] = []
const RING_SNAP_DUR = 0.2
const RING_SNAP_LEAD = 0.066   // telegraph appears ~4 frames (@60fps) BEFORE the hit and holds at full, then fades over RING_SNAP_DUR — so it STARTS earlier but ENDS at the same time
function pushRingSnap(x: number, y: number, radius: number, blockedArcs: BlockedArc[], follow: { x: number; y: number } | null = null, flash = false): void {
  ringSnaps.push({ x, y, radius, timer: 0, arcs: blockedArcs.length > 0 ? [...blockedArcs] : [],
    follow, offX: follow ? x - follow.x : 0, offY: follow ? y - follow.y : 0, flash })
}
function updateAndDrawRingSnaps(dt: number): void {
  if (ringSnaps.length === 0) return
  for (let i = ringSnaps.length - 1; i >= 0; i--) {
    const s = ringSnaps[i]!
    // Hold at full (1) during the lead-in (timer < LEAD), then fade 1 → 0 over RING_SNAP_DUR. The
    // snap is pushed LEAD seconds before the peak, so the fade still bottoms out at the same moment.
    const redFade = Math.max(0, Math.min(1, 1 - (s.timer - RING_SNAP_LEAD) / RING_SNAP_DUR))
    if (redFade <= 0) { ringSnaps[i] = ringSnaps[ringSnaps.length - 1]!; ringSnaps.pop(); continue }
    // Track the enemy during the lead/expansion (the real ring follows it pre-peak), then freeze at
    // the peak — keeps the telegraph aligned with a moving attacker instead of lagging behind.
    if (s.follow && s.timer < RING_SNAP_LEAD) { s.x = s.follow.x + s.offX; s.y = s.follow.y + s.offY }
    // Frame-by-frame strobe for player rings — alternate bright/dim every render frame so the
    // player's own red hit-circle visibly flickers (distinct from the steady enemy snap).
    const strobe = s.flash ? ((frameTick & 1) ? 0.3 : 1) : 1
    const redAlpha = 0.8 * redFade * strobe
    const wMul = 0.5 + 2.2 * redFade * redFade          // ~2.7× at fire → 0.5× as it thins out
    const sx = s.x - camX, sy = s.y - camY
    const resolved = s.arcs.length > 0 ? resolveArcs(s.arcs) : []
    ctx.strokeStyle = `rgba(255, 100, 100, ${redAlpha * 0.08})`; ctx.lineWidth = 26 * wMul; drawArcWithGapsResolved(sx, sy, s.radius, resolved)
    ctx.strokeStyle = `rgba(255, 100, 100, ${redAlpha * 0.18})`; ctx.lineWidth = 10 * wMul; drawArcWithGapsResolved(sx, sy, s.radius, resolved)
    ctx.strokeStyle = `rgba(255, 80, 80, ${redAlpha * 0.5})`;    ctx.lineWidth = 5 * wMul;  drawArcWithGapsResolved(sx, sy, s.radius, resolved)
    ctx.strokeStyle = `rgba(255, 80, 80, ${redAlpha})`;          ctx.lineWidth = 3 * wMul;  drawArcWithGapsResolved(sx, sy, s.radius, resolved)
    s.timer += dt
  }
}

// Tether equivalent of the ring snap — a red "bar" along the beam segments, drawn DEAD LAST (on top
// of the slash flurry), pushed RING_SNAP_LEAD before the strike and using the same hold-then-fade +
// fat-then-thin width. Tether endpoints are frozen at fire, so no follow needed.
interface TetherSnap { xs: number[]; ys: number[]; topology: TetherTopology; width: number; timer: number }
const tetherSnaps: TetherSnap[] = []
// Tethers get a tiny lead (not the ring's 4 frames): staccato beams TELEPORT between hops, so a big
// early lead leaves the bar stranded at the wrong hop's geometry. ~1 frame keeps it snapped to the
// strike, aligned with the live beam.
const TETHER_SNAP_LEAD = 0.04
function pushTetherSnap(xs: number[], ys: number[], topology: TetherTopology, width: number): void {
  tetherSnaps.push({ xs: [...xs], ys: [...ys], topology, width, timer: 0 })
}
function updateAndDrawTetherSnaps(dt: number): void {
  if (tetherSnaps.length === 0) return
  ctx.lineCap = 'round'
  for (let i = tetherSnaps.length - 1; i >= 0; i--) {
    const s = tetherSnaps[i]!
    const redFade = Math.max(0, Math.min(1, 1 - (s.timer - TETHER_SNAP_LEAD) / RING_SNAP_DUR))
    if (redFade <= 0) { tetherSnaps[i] = tetherSnaps[tetherSnaps.length - 1]!; tetherSnaps.pop(); continue }
    const redAlpha = 0.8 * redFade
    const wMul = 0.5 + 2.2 * redFade * redFade
    const n = s.xs.length
    let hubWx = 0, hubWy = 0
    if (s.topology === 'star') {
      for (let k = 0; k < n; k++) { hubWx += s.xs[k]!; hubWy += s.ys[k]! }
      hubWx /= n; hubWy /= n
    }
    const w = s.width
    // Three red passes (wide glow → mid → sharp core). Each batches all segments into one stroke so
    // overlaps at a star hub don't double-darken (source-over).
    const passes: [number, number, number, number, number][] = [
      [w * 1.2 + 3,   redAlpha * 0.10, 255, 100, 100],
      [w * 0.6 + 1.5, redAlpha * 0.5,  255, 80, 80],
      [w * 0.3 + 1,   redAlpha,        255, 70, 70],
    ]
    for (const [lw, a, pr, pg, pb] of passes) {
      ctx.strokeStyle = `rgba(${pr}, ${pg}, ${pb}, ${a})`
      ctx.lineWidth = lw * wMul
      ctx.beginPath()
      for (const [pa, pb2] of tetherVizPairs(s.topology, n)) {
        const ax = s.xs[pa]! - camX, ay = s.ys[pa]! - camY
        const bx = pb2 === n ? hubWx - camX : s.xs[pb2]! - camX
        const by = pb2 === n ? hubWy - camY : s.ys[pb2]! - camY
        ctx.moveTo(ax, ay); ctx.lineTo(bx, by)
      }
      ctx.stroke()
    }
    s.timer += dt
  }
  ctx.lineCap = 'butt'
}

function drawRing(worldX: number, worldY: number, ring: Ring, attackTimer: number, radiusOverride?: number, expandTime = ATTACK_EXPAND_TIME, blockedArcs: BlockedArc[] = [], followEntity?: { x: number; y: number }, boldStart = false): void {
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

  // boldStart (bullet detonation rings only): start noticeably visible (0.30) and ramp LINEARLY so
  // you can read where the ring is growing from the get-go. Normal rings (player/enemy in-place) keep
  // the subtle 0.12 + buildup² charge-up so the peak still punches.
  const baseAlpha = boldStart ? (0.30 + 0.50 * buildup) : (0.12 + 0.68 * buildup * buildup)
  const alpha = attackTimer <= expandTime ? baseAlpha
    : (attackTimer < expandTime + 0.05 ? baseAlpha * (1 - (attackTimer - expandTime) / 0.05) : 0)
  const lineW = boldStart ? (1.7 + 1.9 * buildup) : (1.3 + 2.2 * buildup)
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

  // Explosion at peak — white-hot sparks racing along the ring circumference. LOD-scaled (not
  // hard-gated on a full pool) so a fractal-tether finale THINS these to a floor instead of
  // dropping to zero — which left only the red ring showing.
  if (!isFrozenDeath && showRedRing && pastPeak < lastDt * 2) {
    const ringScale = Math.max(1, currentRadius / 140)
    // Floored at 50% of full so a saturated finale keeps a readable shard ring, not 2 sparks.
    const baseShards = Math.round(8 * ringScale)
    const totalCount = lodCount(baseShards, Math.ceil(baseShards * 0.5))
    const poolBefore = particleCount
    let ringDropped = 0
    if (__DEV__) { dbgPoolAtPeak = particleCount; dbgRingReq += totalCount }
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
      // Tangential velocity — races along the ring. With orbit mode (set below) the velocity
      // gets reoriented tangent at the new position each frame, so the particle FOLLOWS the
      // ring's curve instead of departing on a straight tangent line.
      const dir = i % 2 === 0 ? 1 : -1  // alternating CW/CCW
      const tangentAngle = angle + (Math.PI / 2) * dir
      const tangentSpeed = 1130 + Math.random() * 380  // 30% faster — sparse, fast, dramatic
      const vx = Math.cos(tangentAngle) * tangentSpeed
      const vy = Math.sin(tangentAngle) * tangentSpeed
      const isRed = i % 10 === 0
      const isWhite = !isRed && i % 4 === 0
      const lt = 0.22 + Math.random() * 0.10  // 0.22–0.32s — tightened so the earliest don't die too soon
      // Size scales with ring size — anchored to the player ring (MAX_RING_RADIUS = 180).
      // Smaller rings get smaller shards, bigger rings get bigger shards. Capped at R=250
      // so anything larger doesn't keep scaling — shards plateau at ~sqrt(250/180)=1.18×.
      const sizeScale = Math.sqrt(Math.min(currentRadius, 250) / 180)
      const sz = (isWhite ? 15.25 : 12.87) * sizeScale * (0.9 + Math.random() * 0.3)
      const pr = isRed ? 255 : isWhite ? 255 : Math.min(255, ri + 100)
      const pg = isRed ? 60 + Math.floor(Math.random() * 40) : isWhite ? 255 : Math.min(255, gi + 60)
      const pb = isRed ? 50 + Math.floor(Math.random() * 30) : isWhite ? 255 : Math.min(255, bi + 60)
      const isPlayerRing = ring.owner === 'player'
      const tintGold = Math.random() < 0.5
      let tR: number, tG: number, tB: number
      if (isRed) { tR = -1; tG = 0; tB = 0 }
      else if (isPlayerRing) { tR = 255; tG = tintGold ? 200 : 50; tB = tintGold ? 60 : 50 }
      else { tR = pr; tG = pg; tB = pb }
      // Minor random radius offset — ±2% normally, but capped at ±4px absolute (the spread
      // at R=200) so bigger rings don't get a thick fuzzy hitbox edge. Same proportional
      // shimmer below R=200, tightens automatically as rings grow past that.
      const absVariance = Math.min(currentRadius * 0.02, 4)
      const orbitStartR = currentRadius - absVariance + Math.random() * 2 * absVariance
      if (__DEV__ && particleCount >= MAX_PARTICLES) { ringDropped++; dbgRingDrop++ }
      spawnParticle(px, py, vx, vy, pr, pg, pb, lt, sz, 0, tR, tG, tB, worldX, worldY, orbitStartR, true)   // priority — use the reserved slice
    }
    if (__DEV__) console.log(`[ring] owner=${ring.owner} r=${Math.round(currentRadius)} req=${totalCount} dropped=${ringDropped} pool=${poolBefore}/${MAX_PARTICLES}`)
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

  // Red damage SNAP — fire ONCE the frame the ring crosses its peak (the actual hit frame), into
  // the top-most overlay list so it draws above the whole particle flurry instead of under/among
  // it. The inline per-frame red draw that used to be here was the thing getting buried.
  // Red hit-circle snap for ALL rings (player + enemy). Pushed RING_SNAP_LEAD before the peak
  // (telegraph), at the FULL hit radius (baseRadius), tracking the owner during the lead, so it
  // warns a touch early but still fades out at the same moment.
  if (!isFrozenDeath && pastPeak >= -RING_SNAP_LEAD && pastPeak - lastDt < -RING_SNAP_LEAD && baseRadius > 1) {
    pushRingSnap(worldX, worldY, baseRadius, blockedArcs, followEntity ?? null, ring.owner === 'player')
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

        // Absorb stream — only for player-collected orbs. HP = heal gold blended 60/40 with the
        // orb's own red so the suck-up carries the orb's colour (still reads as a heal). XP keeps its
        // own colour (slightly brightened).
        if (orb.consumedBy !== 'enemy') {
          const absR = isHP ? Math.round(255 * 0.8 + orbR * 0.2) : Math.min(255, orbR + 50)
          const absG = isHP ? Math.round(222 * 0.8 + orbG * 0.2) : Math.min(255, orbG + 30)
          const absB = isHP ? Math.round(150 * 0.8 + orbB * 0.2) : Math.min(255, orbB + 30)
          addAbsorbEffect(orb.x, orb.y, absR, absG, absB)
        }

        // Spark explosion — orb-colored burst. LOD-scaled: sweeping a big orb cluster in one beat
        // started dozens of these at once (the measured pile-up), so the per-orb count tapers as
        // the pool fills. A lone orb at low load is unchanged.
        const sparkN = lodCount(18)
        for (let i = 0; i < sparkN; i++) {
          const angle = (i / sparkN) * Math.PI * 2 + (Math.random() - 0.5) * 0.4
          const speed = 765 + Math.random() * 425
          spawnParticle(orb.x, orb.y,
            Math.cos(angle) * speed, Math.sin(angle) * speed,
            Math.min(255, orbR + 60), Math.min(255, orbG + 50), Math.min(255, orbB + 50),
            0.15 + Math.random() * 0.1, 2.5 + Math.random() * 2)
        }
        // Hot white core sparks
        const coreN = lodCount(8)
        for (let i = 0; i < coreN; i++) {
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
    // HP heart stays essentially white with just a faint warm hint; XP plus stays pure white.
    const iconCol = isHP ? `255, 251, 240` : `255, 255, 255`
    ctx.fillStyle = `rgba(${iconCol}, ${Math.min(1, iconAlpha)})`
    ctx.strokeStyle = `rgba(${iconCol}, ${Math.min(1, iconAlpha)})`
    if (isHP) {
      // Heart — single combined path
      const hs = iconScale * 2.2
      const cy = sy - hs * 0.1
      const humpR = hs * 0.45
      const lx = sx - humpR * 0.9  // left hump center
      const rx = sx + humpR * 0.9  // right hump center
      const hy = cy - hs * 0.15    // hump center y
      // Cached glow sprite under the heart — near-white with a faint warm hint, large + low alpha.
      {
        const sprite = getGlowSprite(255, 246, 225)
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

// ── Boost-pickup STAR burst — dramatic gold sparkle-stars erupt from the player on a boost grab ──
interface StarGlint { x: number; y: number; vx: number; vy: number; size: number; rot: number; rotSpeed: number; life: number; maxLife: number; parent: ParticleParent; lastPX: number; lastPY: number; shrink?: boolean; friction?: number; lastRot?: number }
const starGlints: StarGlint[] = []

export function spawnBoostStarBurst(parent: ParticleParent, bodyR: number, count = 1): void {
  // Ring of 4-point sparkle-stars flung outward + a couple big slow ones + a round energy spray.
  // PARENT-ATTACHED to the player so the burst rides with you (you're moving fast on a boost) while
  // each star still flies outward relative to your body — reads as bursting OUT of the player. They
  // SPAWN at the body edge and launch fast so they're already outside you while still bright. The
  // overheal `count` (1–3) scales star quantity + size, so a 200% grab erupts noticeably bigger.
  const px = parent.x, py = parent.y
  const edge = bodyR * 0.65   // spawn a bit further out from center toward the body edge
  const lvl = Math.max(0, (count - 1) / 2)        // 0/0.5/1 at count 1/2/3
  const ringN = 6 + Math.round(lvl * 6)           // 6 / 9 / 12 stars
  const szMul = 1 + lvl * 0.35
  const widthMul = 1 + lvl * 1.0                  // count 3 flings stars ~2× as far = much wider burst
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * Math.PI * 2 + Math.random() * 0.5
    const sp = (175 + Math.random() * 185) * widthMul
    starGlints.push({ x: px + Math.cos(a) * edge * (1 + lvl * 0.4), y: py + Math.sin(a) * edge * (1 + lvl * 0.4), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      size: (9 + Math.random() * 10) * szMul, rot: Math.random() * Math.PI, rotSpeed: (Math.random() - 0.5) * 6,
      life: 0, maxLife: 0.45 + Math.random() * 0.25, parent, lastPX: px, lastPY: py })
  }
  for (let i = 0; i < 2; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 90 + Math.random() * 90
    starGlints.push({ x: px + Math.cos(a) * edge, y: py + Math.sin(a) * edge, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      size: 18 + Math.random() * 9, rot: Math.random() * Math.PI, rotSpeed: (Math.random() - 0.5) * 3,
      life: 0, maxLife: 0.5 + Math.random() * 0.28, parent, lastPX: px, lastPY: py })
  }
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 130 + Math.random() * 180
    spawnParticleAttached(px + Math.cos(a) * edge, py + Math.sin(a) * edge, Math.cos(a) * sp, Math.sin(a) * sp,
      255, 245, 210, 0.22 + Math.random() * 0.18, 2.5 + Math.random() * 2, 255, 235, 185, parent)
  }
}

function updateAndDrawStarGlints(dt: number): void {
  if (starGlints.length === 0) return
  const prevComp = ctx.globalCompositeOperation
  ctx.globalCompositeOperation = 'lighter'
  for (let i = starGlints.length - 1; i >= 0; i--) {
    const g = starGlints[i]!
    g.life += dt / g.maxLife
    if (g.life >= 1) { starGlints[i] = starGlints[starGlints.length - 1]!; starGlints.pop(); continue }
    // Ride with the parent (player) — shift by its per-frame delta, then apply own outward velocity.
    g.x += g.parent.x - g.lastPX; g.y += g.parent.y - g.lastPY
    g.lastPX = g.parent.x; g.lastPY = g.parent.y
    // Rotational attachment — rotate the star's offset + velocity around the parent center by its
    // per-frame angle delta, so it rigidly rides a SPINNING wall (rot is undefined for point parents
    // like the player → skipped).
    const prot = g.parent.rot
    if (prot !== undefined && prot !== (g.lastRot ?? 0)) {
      const dR = prot - (g.lastRot ?? 0)
      const cs = Math.cos(dR), sn = Math.sin(dR)
      const ox = g.x - g.parent.x, oy = g.y - g.parent.y
      g.x = g.parent.x + ox * cs - oy * sn
      g.y = g.parent.y + ox * sn + oy * cs
      const gvx = g.vx, gvy = g.vy
      g.vx = gvx * cs - gvy * sn
      g.vy = gvx * sn + gvy * cs
      g.lastRot = prot
    }
    g.x += g.vx * dt; g.y += g.vy * dt
    const fr = g.friction ?? 0.91   // per-star friction (default boost-star value); higher = coasts farther
    g.vx *= fr; g.vy *= fr
    g.rot += g.rotSpeed * dt
    const grow = g.life < 0.25 ? g.life / 0.25 : 1            // pop in, then hold
    const fade = g.life < 0.25 ? 1 : 1 - (g.life - 0.25) / 0.75
    const R = g.size * grow * (g.shrink ? fade : 1)          // shrink stars also dwindle in size as they fade
    const sx = g.x - camX, sy = g.y - camY
    // soft center glow
    ctx.beginPath(); ctx.arc(sx, sy, R * 0.5, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(255, 250, 228, ${fade * 0.5})`; ctx.fill()
    // 4-point sparkle star
    ctx.beginPath()
    for (let k = 0; k < 4; k++) {
      const ao = g.rot + k * Math.PI / 2
      const ai = ao + Math.PI / 4
      ctx.lineTo(sx + Math.cos(ao) * R, sy + Math.sin(ao) * R)
      ctx.lineTo(sx + Math.cos(ai) * R * 0.34, sy + Math.sin(ai) * R * 0.34)
    }
    ctx.closePath()
    ctx.fillStyle = `rgba(255, 242, 200, ${fade})`
    ctx.fill()
  }
  ctx.globalCompositeOperation = prevComp
}

// ── Heal-at-full SPEED BOOST trail — gold afterimages while the 1s +50% boost is active ──
interface VitGhost { x: number; y: number; r: number; life: number; maxLife: number }
const vitGhosts: VitGhost[] = []
const MAX_VIT_GHOSTS = 44
let vitTrailDist = 0
let lastVitX = 0, lastVitY = 0
let lastSeenBoost = 0

// Draws the gold afterimage speed trail + idle aura while the boost is active. Called at the START
// of drawPlayer so ghosts render UNDER the body. Intensity tracks the REMAINING timer, so the trail
// is brightest right after a pickup and fades out over the second — conveying the 1s countdown.
function updateAndDrawSpeedBoostTrail(player: Player, bodyR: number): void {
  const timer = player.speedBoostTimer
  const frac = Math.max(0, Math.min(1, timer / SPEED_BOOST_DURATION))   // 1 fresh → 0 expired
  const lvl = Math.max(0, Math.min(1, (player.speedBoostCount - 1) / 2))  // 0/0.5/1 at count 1/2/3
  const cx = player.x - camX, cy = player.y - camY
  // Dash tint — while a dash is in effect (dashTimer >= 0), shade the gold trail/aura toward
  // dash-green so the boost visibly feeds the dash. Partial blend keeps it reading as the gold
  // boost, just greener. tintGold(r,g,b) lerps a gold channel-trio toward dash-green (110,255,130).
  const dashGreen = player.dashTimer >= 0 ? 0.4 : 0
  const tintGold = (r: number, g: number, b: number): [number, number, number] =>
    [Math.round(r + (110 - r) * dashGreen), Math.round(g + (255 - g) * dashGreen), Math.round(b + (130 - b) * dashGreen)]
  // Pickup response — a dramatic gold STAR burst out of the player whenever the boost is (re)granted.
  // Burst + SFX scale with the overheal count so 1 vs 3 (100% vs 200%) reads distinctly.
  if (timer > lastSeenBoost + 0.001) {
    spawnBoostStarBurst(player, bodyR, player.speedBoostCount)
    playSpeedBoost(player.speedBoostCount)   // surge SFX, layers over the orb-collect chime
  }
  lastSeenBoost = timer

  // Spawn afterimages while moving + boosted.
  if (timer > 0) {
    const dvx = player.x - lastVitX, dvy = player.y - lastVitY
    const moved = Math.sqrt(dvx * dvx + dvy * dvy)
    vitTrailDist += moved
    if (moved > 0.4 && vitTrailDist >= 12) {
      vitTrailDist = 0
      if (vitGhosts.length >= MAX_VIT_GHOSTS) vitGhosts.shift()
      vitGhosts.push({ x: player.x, y: player.y, r: bodyR, life: 0, maxLife: 0.45 + lvl * 0.25 })
    }
  }
  lastVitX = player.x; lastVitY = player.y

  // Draw + decay ghosts (additive gold, under the body). Brightness scales with the remaining timer
  // (frac) so the whole streak dims as the boost runs out.
  if (vitGhosts.length > 0) {
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    const briScale = (0.18 + frac * 0.42) * (1 + lvl * 0.5)
    const [c0r, c0g, c0b] = tintGold(255, 242, 195)
    const [c1r, c1g, c1b] = tintGold(255, 226, 150)
    const [c2r, c2g, c2b] = tintGold(255, 216, 130)
    for (let i = vitGhosts.length - 1; i >= 0; i--) {
      const g = vitGhosts[i]!
      g.life += lastDt / g.maxLife
      if (g.life >= 1) { vitGhosts[i] = vitGhosts[vitGhosts.length - 1]!; vitGhosts.pop(); continue }
      const a = (1 - g.life) * briScale
      const gx = g.x - camX, gy = g.y - camY
      const gr = g.r * (0.8 + 0.2 * (1 - g.life))
      const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr)
      grad.addColorStop(0, `rgba(${c0r}, ${c0g}, ${c0b}, ${a})`)
      grad.addColorStop(0.6, `rgba(${c1r}, ${c1g}, ${c1b}, ${a * 0.6})`)
      grad.addColorStop(1, `rgba(${c2r}, ${c2g}, ${c2b}, 0)`)
      ctx.fillStyle = grad
      ctx.beginPath(); ctx.arc(gx, gy, gr, 0, Math.PI * 2); ctx.fill()
    }
    ctx.globalCompositeOperation = prevComp
  }

  // Idle aura — soft gold ring on the body so the boost reads even standing still; fades with the
  // remaining timer.
  if (timer > 0) {
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.012)
    const aA = (0.05 + frac * 0.18) * (0.7 + pulse * 0.3) * (1 + lvl * 0.6)
    const aR = bodyR * 1.7
    const [a0r, a0g, a0b] = tintGold(255, 232, 170)
    const [a1r, a1g, a1b] = tintGold(255, 226, 150)
    const [a2r, a2g, a2b] = tintGold(255, 216, 130)
    const grad = ctx.createRadialGradient(cx, cy, bodyR * 0.7, cx, cy, aR)
    grad.addColorStop(0, `rgba(${a0r}, ${a0g}, ${a0b}, 0)`)
    grad.addColorStop(0.7, `rgba(${a1r}, ${a1g}, ${a1b}, ${aA})`)
    grad.addColorStop(1, `rgba(${a2r}, ${a2g}, ${a2b}, 0)`)
    ctx.fillStyle = grad
    ctx.beginPath(); ctx.arc(cx, cy, aR, 0, Math.PI * 2); ctx.fill()
    ctx.globalCompositeOperation = prevComp
  }
}

function drawPlayer(player: Player): void {
  const baseRadius = getBodyRadius(player)
  let sx = player.x - camX
  let sy = player.y - camY
  updateAndDrawSpeedBoostTrail(player, baseRadius)

  // Heal-pulse tracking — fire from the EVENT (HP actually gained this frame), not a net-HP diff,
  // so a heal still flashes gold even when a same-frame hit cancels it on the HP total.
  if (player.pendingHeal > 0) {
    const gained = player.pendingHeal
    player.pendingHeal = 0
    healPulseAmount = Math.max(healPulseAmount, gained)   // stack: keep biggest if multiple in one tick
    healPulseRemain = HEAL_PULSE_DURATION

    // Golden sparkle burst — one-shot on the heal TRIGGER frame (not per frame), twinkles
    // radiating up-and-out around the player so the heal "lifts". Count scales with the amount
    // healed and is capped so big heals can't flood the shared particle pool (MAX_PARTICLES also
    // backstops). Gold TINT TARGET makes each sparkle's cached glow halo bloom gold — reuses the
    // existing cheap glow-sprite path, no per-frame cost.
    const sparkCount = Math.min(28, 8 + Math.round(gained * 5))
    for (let i = 0; i < sparkCount; i++) {
      const a = (i / sparkCount) * Math.PI * 2 + Math.random() * 0.4
      const spd = 55 + Math.random() * 90            // SLOW = floaty (vs the fast, sharp red hit spray)
      const dist = player.hitRadius * (0.3 + Math.random() * 0.5)
      // Parent-attached to the player so the burst RIDES WITH the body — its own outward
      // velocity still plays out, but the whole spray translates with the player each frame
      // (even through a beat-dash teleport) instead of being stranded in world space.
      spawnParticleAttached(
        player.x + Math.cos(a) * dist, player.y + Math.sin(a) * dist,
        Math.cos(a) * spd, Math.sin(a) * spd - 55,   // strong upward drift = gentle, benevolent rise
        255, 245, 215,                                // bright white-gold body
        0.75 + Math.random() * 0.55, 3.6 + Math.random() * 3.2,   // long-lived + big = round, floaty glow
        255, 232, 180,                                // pale-gold tint target → white-gold glow halo
        player)
    }
    // White-hot twinkle highlights — a few soft bright motes drifting up from the center
    const hotCount = Math.min(6, 2 + Math.round(gained))
    for (let i = 0; i < hotCount; i++) {
      const a = Math.random() * Math.PI * 2
      const spd = 65 + Math.random() * 100
      spawnParticleAttached(
        player.x, player.y,
        Math.cos(a) * spd, Math.sin(a) * spd - 45,
        255, 252, 238,
        0.55 + Math.random() * 0.35, 2.4 + Math.random() * 2.2,
        255, 242, 205,
        player)
    }
  }
  // Hurt-pulse tracking — mirror of the heal burst, in red, fired from the EVENT (HP actually lost
  // this frame). pendingHurt is only set on real HP loss (not shield absorbs), so shield breaks are
  // naturally skipped, and a same-frame heal+hit shows BOTH pulses instead of cancelling.
  if (player.pendingHurt > 0) {
    const lost = player.pendingHurt
    player.pendingHurt = 0
    hurtPulseAmount = Math.max(hurtPulseAmount, lost)
    hurtPulseRemain = HURT_PULSE_DURATION
    // Red dot burst — radiates straight out (no upward lift; damage bursts, doesn't rise) and a
    // touch faster/bigger than the heal sparkles so it reads as a violent hit. Red tint target →
    // red glow halo blooms on each dot (same cheap cached-sprite path).
    const dmgCount = Math.min(30, 10 + Math.round(lost * 5))
    for (let i = 0; i < dmgCount; i++) {
      const a = (i / dmgCount) * Math.PI * 2 + Math.random() * 0.4
      const spd = 175 + Math.random() * 250
      const dist = player.hitRadius * (0.3 + Math.random() * 0.5)
      spawnParticleAttached(
        player.x + Math.cos(a) * dist, player.y + Math.sin(a) * dist,
        Math.cos(a) * spd, Math.sin(a) * spd,
        255, 95, 75,                                  // hot red body
        0.6 + Math.random() * 0.45, 2.6 + Math.random() * 3.0,
        255, 45, 35,                                  // deep-red tint target → red glow halo blooms in
        player)
    }
    // White-hot impact sparks from the center
    const hotCount = Math.min(8, 3 + Math.round(lost))
    for (let i = 0; i < hotCount; i++) {
      const a = Math.random() * Math.PI * 2
      const spd = 140 + Math.random() * 215
      spawnParticleAttached(
        player.x, player.y,
        Math.cos(a) * spd, Math.sin(a) * spd,
        255, 235, 215,
        0.42 + Math.random() * 0.3, 1.9 + Math.random() * 2.0,
        255, 110, 80,
        player)
    }
  }
  if (healPulseRemain > 0) {
    healPulseRemain -= lastDt
    if (healPulseRemain < 0) {
      healPulseRemain = 0
      healPulseAmount = 0
    }
  }
  if (hurtPulseRemain > 0) {
    hurtPulseRemain -= lastDt
    if (hurtPulseRemain < 0) {
      hurtPulseRemain = 0
      hurtPulseAmount = 0
    }
  }

  // Hit jitter
  if (player.hitFlash > 0) {
    const jitter = 6 * (player.hitFlash / HIT_FLASH_DURATION)
    sx += (Math.random() - 0.5) * 2 * jitter
    sy += (Math.random() - 0.5) * 2 * jitter
  }

  // Quiet Storm charge ring — loading wheel at 2× the beat-dash AOE radius. Telegraphs
  // both progress (arc fills clockwise as charge builds) AND the area the powered dash
  // will hit (radius = 2× beat-dash shockRadius = ring.radius * 1.4 * beatBlastMult).
  // When ready: full ring pulses gold. While filling: thinner cyan arc.
  if (player.chargeTimer > 0 || player.chargeReady) {
    const beatDashAOE = player.ring.radius * BEAT_DASH_RADIUS_MULT * player.modifiers.beatBlastMult
    const chargeR = beatDashAOE * 2
    const fillFrac = player.chargeReady ? 1 : Math.min(1, player.chargeTimer / 3)
    const arcEnd = -Math.PI / 2 + fillFrac * Math.PI * 2   // start at top, fill clockwise

    if (player.chargeReady) {
      // Pulsing gold ring when fully charged — beat-synced pulse for "primed" feel
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120)
      // Outer halo
      ctx.beginPath()
      ctx.arc(sx, sy, chargeR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 215, 64, ${0.30 + pulse * 0.30})`
      ctx.lineWidth = 8 + pulse * 4
      ctx.stroke()
      // Bright core ring
      ctx.beginPath()
      ctx.arc(sx, sy, chargeR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(255, 240, 180, ${0.85 + pulse * 0.15})`
      ctx.lineWidth = 2.5
      ctx.stroke()
      // Subtle inward energy lines — 8 spokes converging toward center
      const spokeAlpha = 0.25 + pulse * 0.25
      ctx.strokeStyle = `rgba(255, 220, 100, ${spokeAlpha})`
      ctx.lineWidth = 1.5
      for (let i = 0; i < 8; i++) {
        const ang = i * Math.PI / 4 + performance.now() / 800
        const innerR = chargeR * 0.55
        ctx.beginPath()
        ctx.moveTo(sx + Math.cos(ang) * chargeR, sy + Math.sin(ang) * chargeR)
        ctx.lineTo(sx + Math.cos(ang) * innerR, sy + Math.sin(ang) * innerR)
        ctx.stroke()
      }
    } else {
      // Filling arc — cyan, sweeps clockwise from top. Dashed faint full-circle behind to
      // show the destination radius even while empty.
      ctx.beginPath()
      ctx.setLineDash([4, 6])
      ctx.arc(sx, sy, chargeR, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(120, 220, 255, 0.18)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.setLineDash([])
      // Filled arc
      ctx.beginPath()
      ctx.arc(sx, sy, chargeR, -Math.PI / 2, arcEnd)
      ctx.strokeStyle = 'rgba(120, 240, 255, 0.85)'
      ctx.lineWidth = 4
      ctx.stroke()
      // Bright leading edge dot
      ctx.beginPath()
      ctx.arc(sx + Math.cos(arcEnd) * chargeR, sy + Math.sin(arcEnd) * chargeR, 4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(220, 250, 255, 0.95)'
      ctx.fill()
    }
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
  // Slipstream braid — visible during the dash AND for SLIPSTREAM_LINGER seconds after, so
  // the braid fades to zero smoothly instead of cutting off when dashTimer crosses below 0.
  // Hold-then-fade alpha: bright for the bulk of the visible window, smoothly tapers to 0
  // in the final 40% of the window.
  const SLIPSTREAM_LINGER = 0.15
  if (player.dashTimer + SLIPSTREAM_LINGER >= 0 && player.dashChainBoost > 1 && player.dashPath.length >= 2) {
    const path = player.dashPath
    // visibleFrac: 1 at dash start, smoothly decreases to 0 at end of linger.
    const totalVisible = player.dashDuration + SLIPSTREAM_LINGER
    const visibleFrac = Math.max(0, Math.min(1, (player.dashTimer + SLIPSTREAM_LINGER) / totalVisible))
    // Hold full alpha while visibleFrac > 0.4 (dash + early linger), then linear fade to 0
    // over the final 40% of the visible window. Smooth single-curve, no discontinuities.
    const fade = visibleFrac >= 0.4 ? 1 : visibleFrac / 0.4
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

  // Hit particles — burst from inside the damage wedge.
  // Cone is always RADIAL OUTWARD FROM ENTITY CENTER through the damage wedge. No velocity
  // offset on spawn position (which would skew the apparent origin when the player is moving
  // or just bounced). Instead, particles are PARENTED to the player so they translate WITH
  // the player during their lifetime — the entire burst follows the entity instead of being
  // stranded in world space.
  if (player.hitFlash > HIT_FLASH_DURATION - 0.02 && player.shieldBreakFlash <= 0) {
    const dmgFraction = 1 / player.maxHp
    const intensity = Math.min(Math.max(dmgFraction / 0.05, 1), 3)
    const count = Math.floor(3 * intensity)
    const dmgArcStart = hpStart + actualPlayerHp * Math.PI * 2
    const dmgArcEnd = dmgArcStart + dmgFraction * Math.PI * 2
    const arcSpan = dmgArcEnd - dmgArcStart
    for (let i = 0; i < count; i++) {
      const angle = dmgArcStart + Math.random() * arcSpan
      const dist = Math.random() * drawRadius
      const px = player.x + Math.cos(angle) * dist
      const py = player.y + Math.sin(angle) * dist
      // Faster launch (~1.5x) so the spray flings out hard on impact, then the existing light
      // drag settles it within its lifetime — punchier than the old slower spray.
      const speed = (640 + Math.random() * 1000) * (0.8 + intensity * 0.2)
      const spread = (Math.random() - 0.5) * speed * 0.2
      const size = (10.0 + Math.random() * 8.0) * (0.8 + intensity * 0.2)
      const isBlue = Math.random() < 0.2
      // Tint TARGETS = where the particle color shifts to as it ages. Cooler targets so red
      // blood drops fade toward a dark cool blue/purple over their lifetime (like blood
      // oxidizing/drying); blue drops fade to a deeper cooler blue. Glow halo also tints to
      // these colors so the dying particles sit in a cool palette.
      const tR = isBlue ? 60 : 100
      const tG = isBlue ? 130 : 70
      const tB = isBlue ? 210 : 175
      // Random spawn delay (0–60ms) staggers when each drop appears so the burst rolls out
      // over a brief window instead of all firing on a single frame.
      const delay = Math.random() * 0.06
      spawnParticleAttached(px, py,
        Math.cos(angle) * speed + spread, Math.sin(angle) * speed + spread,
        isBlue ? 79 : 255, isBlue ? 195 : 60 + Math.floor(Math.random() * 45), isBlue ? 247 : 55,
        0.31 + Math.random() * 0.22, size,
        tR, tG, tB,
        player, delay, true)
    }
    // Extra center spray — white-hot core burst, just one chunky drop. Tinted hot orange/peach
    // so its glow halo reads as a bright impact flash distinct from the red/blue debris.
    {
      const angle = dmgArcStart + Math.random() * arcSpan
      const speed = 345 + Math.random() * 740   // ~1.5x — snappier core burst
      spawnParticleAttached(player.x, player.y,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        255, 200 + Math.floor(Math.random() * 55), 180,
        0.31 + Math.random() * 0.22, 11.0 + Math.random() * 6.0,
        130, 100, 160,
        player, Math.random() * 0.04, true)
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
    } else if (actualPlayerHp > hpFraction) {
      // GOLD heal band [display, actual] — fills up as displayHp catches the new HP (same as nodes/enemies)
      const goldGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      goldGrad.addColorStop(0, 'rgba(255, 228, 140, 0.85)')
      goldGrad.addColorStop(0.7, 'rgba(255, 208, 95, 0.7)')
      goldGrad.addColorStop(1, 'rgba(232, 178, 60, 0.55)')
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, hpStart + hpFraction * Math.PI * 2, hpStart + actualPlayerHp * Math.PI * 2)
      ctx.closePath()
      ctx.fillStyle = goldGrad
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
      // Base fill — softer middle ground between the original bright white-cyan and the over-
      // saturated medium-blue. Bright enough to feel like glowing health, dim enough that the
      // additive blue pulse glow can still visibly add brightness on top.
      if (shielded) {
        // Subtle violet tint — closer to the normal blue, just enough R to read as "shielded"
        // without being a drastic color shift.
        bodyGrad.addColorStop(0, `rgba(170, 200, 250, ${0.62 + bp})`)
        bodyGrad.addColorStop(0.35, `rgba(135, 175, 240, ${0.5 + bp * 0.5})`)
        bodyGrad.addColorStop(1, `rgba(95, 145, 220, ${0.34 + bp * 0.3})`)
      } else {
        bodyGrad.addColorStop(0, `rgba(140, 210, 250, ${0.62 + bp})`)
        bodyGrad.addColorStop(0.35, `rgba(90, 180, 240, ${0.5 + bp * 0.5})`)
        bodyGrad.addColorStop(1, `rgba(50, 150, 220, ${0.34 + bp * 0.3})`)
      }
      ctx.fillStyle = bodyGrad
    }
    ctx.fill()

    // On-hit red glow — equivalent visual strength to the blood particle tint halos so the
    // body flash reads as the same impact event as the blood. Additive 'lighter' red gradient
    // over the wedge plus a halo extending past the body edge. Fades with hitFlash.
    if (player.hitFlash > 0 && !isGhostDashing) {
      const hitT = player.hitFlash / HIT_FLASH_DURATION
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      // Inner glow over the wedge — brightens the red HP fill so it pops
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
      ctx.closePath()
      const innerGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      innerGrad.addColorStop(0,    `rgba(255, 100, 70, ${hitT * 0.55})`)
      innerGrad.addColorStop(0.45, `rgba(230, 55, 35, ${hitT * 0.75})`)
      innerGrad.addColorStop(0.80, `rgba(200, 35, 20, ${hitT * 0.30})`)
      innerGrad.addColorStop(1,    `rgba(180, 25, 10, 0)`)
      ctx.fillStyle = innerGrad
      ctx.fill()
      ctx.globalCompositeOperation = prevComp
    }

    // Early-impact bloom — a bright white-hot → red flash at the spot the blood sprays from,
    // punched on the hit frame and gone fast (hitT² spike). Fills the visually-weak first ~0.1s
    // where the drops are still flat unglowed kites. Reuses the cached glow sprites (2 additive
    // drawImage blits TOTAL per frame — not per particle), so it's effectively free. Gated to
    // real HP damage; shield breaks have their own pink shards + shockwave.
    if (player.hitFlash > 0 && !isGhostDashing && player.shieldBreakFlash <= 0) {
      const hitT = player.hitFlash / HIT_FLASH_DURATION
      const punch = hitT * hitT                       // spike at impact, fast drop-off
      // Origin biased toward the damage wedge so the bloom reads as the impact point.
      const dmgAngle = hpStart + actualPlayerHp * Math.PI * 2
      const ox = sx + Math.cos(dmgAngle) * drawRadius * 0.55
      const oy = sy + Math.sin(dmgAngle) * drawRadius * 0.55
      const prevComp = ctx.globalCompositeOperation
      const prevA = ctx.globalAlpha
      ctx.globalCompositeOperation = 'lighter'
      // Soft red bloom — larger, the body of the flash
      const redSprite = getGlowSprite(255, 60, 45)
      const redDim = drawRadius * 3.2 * (0.7 + punch * 0.5)
      ctx.globalAlpha = punch * 0.9
      ctx.drawImage(redSprite, ox - redDim / 2, oy - redDim / 2, redDim, redDim)
      // White-hot core — smaller, brightest, fades even faster (punch²) for a sharp pop
      const whiteSprite = getGlowSprite(255, 235, 205)
      const whiteDim = drawRadius * 1.6 * (0.6 + punch * 0.6)
      ctx.globalAlpha = punch * punch * 0.95
      ctx.drawImage(whiteSprite, ox - whiteDim / 2, oy - whiteDim / 2, whiteDim, whiteDim)
      ctx.globalAlpha = prevA
      ctx.globalCompositeOperation = prevComp
    }

    // Pulsing glow on the HP fill — additive radial gradient layered over the WHOLE filled
    // wedge so the health area reads as glowing/alive energy. Two pulse sources mix: a slow
    // continuous sin "breath" + the beat-synced globalBeatPulse. Brightest at center, fades
    // outward so the wedge appears to glow from within. Shield state shifts the color violet.
    if (player.hitFlash <= 0 && !isGhostDashing) {
      const slowPulse = 0.5 + 0.5 * Math.sin(performance.now() / 380)
      const totalPulse = slowPulse * 0.45 + globalBeatPulse * 0.55
      // Additive blue glow — works now that the base HP fill is darker/more saturated. Adds
      // brightness on top instead of saturating channels to white. Peaks in the middle of the
      // wedge, fades to zero at the edges (kept from before).
      const glowA = 0.22 + totalPulse * 0.35
      const shieldedHP = player.shieldCharges > 0
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
      ctx.closePath()
      // Gradient peaks in the MIDDLE of the wedge and fades to zero before the edges so the
      // outer arc rim and the wedge boundary don't pick up the glow. Concentrates the light
      // inside the fill area.
      const glowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      if (shieldedHP) {
        // Subtle violet tint — slight R boost over the normal blue glow, not a full shift.
        glowGrad.addColorStop(0,    `rgba(140, 170, 255, ${glowA * 0.55})`)
        glowGrad.addColorStop(0.45, `rgba(110, 145, 255, ${glowA})`)
        glowGrad.addColorStop(0.80, `rgba(80, 115, 255, ${glowA * 0.20})`)
        glowGrad.addColorStop(1,    `rgba(70, 105, 255, 0)`)
      } else {
        // Saturated blue palette — was washing to white from too-high G channel at low alpha.
        glowGrad.addColorStop(0,    `rgba(90, 180, 255, ${glowA * 0.55})`)
        glowGrad.addColorStop(0.45, `rgba(50, 150, 255, ${glowA})`)
        glowGrad.addColorStop(0.80, `rgba(30, 110, 255, ${glowA * 0.20})`)
        glowGrad.addColorStop(1,    `rgba(20, 90, 255, 0)`)
      }
      ctx.fillStyle = glowGrad
      ctx.fill()
      ctx.globalCompositeOperation = prevComp
    }

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
    // Gold heal halo — triggered by HP-increase (healPulseRemain timer), separate from the
    // filling-tip effect. Lasts ~1.2s so it's clearly visible even after displayHp catches up.
    if (healPulseRemain > 0) {
      const healEnv = healPulseRemain / HEAL_PULSE_DURATION       // 1 → 0
      // Power curve so the fade tail drops faster than linear — feels snappier instead of
      // lingering. Still holds near full for the first ~15%.
      const sustain = healEnv < 0.85 ? Math.pow(healEnv / 0.85, 1.6) : 1
      // Anchor the pulse to ELAPSED time since trigger — cos(0)=1 so the halo always starts
      // at max alpha. Slow ~1.4 Hz breath with a gentle 15% amplitude swing so it reads as
      // smooth breathing, not flickering. Period ~0.7s.
      const elapsed = HEAL_PULSE_DURATION - healPulseRemain
      const fastPulse = 0.85 + 0.15 * Math.cos(elapsed * 9)
      // Scale by heal amount — power 1.5 curve with a 20% floor so even a 1 HP heal gets a
      // visible whisper of glow, and larger heals ramp curve-up to full bloom at 5+ HP.
      const sizeScale = Math.max(0.20, Math.min(1, Math.pow(healPulseAmount / 5, 1.5)))
      const baseA = sustain * fastPulse * sizeScale * 1.95
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      // (1) Inner glow over the HP wedge — subtle gold tint on the body so the character
      // appears to softly glow, not blast with light
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
      ctx.closePath()
      const innerGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      innerGrad.addColorStop(0,    `rgba(255, 248, 218, ${baseA * 0.30})`)
      innerGrad.addColorStop(0.5,  `rgba(255, 238, 188, ${baseA * 0.35})`)
      innerGrad.addColorStop(1,    `rgba(255, 226, 158, ${baseA * 0.12})`)
      ctx.fillStyle = innerGrad
      ctx.fill()
      // (2) Outer halo ring extending past the body — softer reach, lower alpha
      const haloR = drawRadius * 1.85
      const haloGrad = ctx.createRadialGradient(sx, sy, drawRadius * 0.85, sx, sy, haloR)
      haloGrad.addColorStop(0,    'rgba(255, 246, 205, 0)')
      haloGrad.addColorStop(0.35, `rgba(255, 244, 200, ${baseA * 0.32})`)
      haloGrad.addColorStop(0.55, `rgba(255, 240, 192, ${baseA * 0.42})`)
      haloGrad.addColorStop(0.80, `rgba(255, 230, 170, ${baseA * 0.16})`)
      haloGrad.addColorStop(1,    'rgba(255, 226, 158, 0)')
      ctx.fillStyle = haloGrad
      ctx.beginPath()
      ctx.arc(sx, sy, haloR, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = prevComp
    }
    // Red hurt halo — mirror of the gold heal halo, in red, on taking damage. Breathing inner
    // glow over the wedge + an outer halo ring past the body. Lingers ~0.5s past the brief hit
    // flash so the damage reads clearly.
    if (hurtPulseRemain > 0) {
      const env = hurtPulseRemain / HURT_PULSE_DURATION
      const sustain = env < 0.85 ? Math.pow(env / 0.85, 1.6) : 1
      const elapsed = HURT_PULSE_DURATION - hurtPulseRemain
      const fastPulse = 0.85 + 0.15 * Math.cos(elapsed * 9)
      const sizeScale = Math.max(0.25, Math.min(1, Math.pow(hurtPulseAmount / 4, 1.2)))
      const baseA = sustain * fastPulse * sizeScale * 1.95
      const prevComp = ctx.globalCompositeOperation
      ctx.globalCompositeOperation = 'lighter'
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
      ctx.closePath()
      const innerGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, drawRadius)
      innerGrad.addColorStop(0,    `rgba(255, 120, 95, ${baseA * 0.30})`)
      innerGrad.addColorStop(0.5,  `rgba(255, 70, 55, ${baseA * 0.36})`)
      innerGrad.addColorStop(1,    `rgba(225, 40, 30, ${baseA * 0.13})`)
      ctx.fillStyle = innerGrad
      ctx.fill()
      const haloR2 = drawRadius * 1.95
      const haloGrad2 = ctx.createRadialGradient(sx, sy, drawRadius * 0.85, sx, sy, haloR2)
      haloGrad2.addColorStop(0,    'rgba(255, 90, 70, 0)')
      haloGrad2.addColorStop(0.35, `rgba(255, 80, 60, ${baseA * 0.34})`)
      haloGrad2.addColorStop(0.55, `rgba(255, 55, 45, ${baseA * 0.44})`)
      haloGrad2.addColorStop(0.80, `rgba(230, 40, 30, ${baseA * 0.16})`)
      haloGrad2.addColorStop(1,    'rgba(220, 30, 25, 0)')
      ctx.fillStyle = haloGrad2
      ctx.beginPath()
      ctx.arc(sx, sy, haloR2, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = prevComp
    }
    if (healGap > 0.01) {
      const tipAngle = mainEnd
      const tipX = sx + Math.cos(tipAngle) * drawRadius * 0.7
      const tipY = sy + Math.sin(tipAngle) * drawRadius * 0.7
      // Leading edge glow — gold to match the heal halo palette
      const glowR = drawRadius * 0.5
      const healGlow = ctx.createRadialGradient(tipX, tipY, 0, tipX, tipY, glowR)
      healGlow.addColorStop(0, 'rgba(255, 215, 120, 0.45)')
      healGlow.addColorStop(1, 'rgba(255, 215, 120, 0)')
      ctx.beginPath()
      ctx.arc(tipX, tipY, glowR, 0, Math.PI * 2)
      ctx.fillStyle = healGlow
      ctx.fill()
      // Bright tip dot — warm white-gold
      const edgeX = sx + Math.cos(tipAngle) * drawRadius
      const edgeY = sy + Math.sin(tipAngle) * drawRadius
      ctx.beginPath()
      ctx.arc(edgeX, edgeY, 4, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 240, 180, 0.9)'
      ctx.fill()
      // Outer glow on tip — gold
      ctx.beginPath()
      ctx.arc(edgeX, edgeY, 8, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255, 215, 120, 0.15)'
      ctx.fill()
      // Heal particles — spawn from the tip, gold-colored
      for (let hp = 0; hp < 2; hp++) {
        if (Math.random() < 0.4) {
          const pAngle = tipAngle + (Math.random() - 0.5) * 0.8
          const pDist = drawRadius * (0.6 + Math.random() * 0.4)
          const speed = 25 + Math.random() * 40
          spawnParticle(
            player.x + Math.cos(pAngle) * pDist,
            player.y + Math.sin(pAngle) * pDist,
            Math.cos(pAngle) * speed, Math.sin(pAngle) * speed,
            255, 215, 120, 0.2 + Math.random() * 0.15, 3.5 + Math.random() * 3)
        }
      }
    }

    // HP segment lines — across full pie including missing health
    if (player.maxHp <= 40) {
      const now = performance.now()
      const inAttack = player.attackTimer >= 0 && player.attackTimer < ATTACK_EXPAND_TIME
      const segBeat = inAttack
        ? Math.min(player.attackTimer / (ATTACK_EXPAND_TIME * 0.80), 0.6)
        : globalBeatPulse
      // Extend and shrink want opposite curves: while expanding (attack), EASE-OUT (fast at the start,
      // settling into the peak) so the lines whip in right on the beat. While decaying, square the pulse
      // so it retracts FAST at the start then settles. The two match at the handoff (attack peak 0.18 ≈
      // decay start 0.5²·0.72 = 0.18), so there's no jump.
      const et = Math.min(1, segBeat / 0.6)
      const extendEase = 1 - (1 - et) * (1 - et)   // ease-out
      const segInner = inAttack
        ? drawRadius * (0.60 - 0.18 * extendEase)
        : drawRadius * (0.60 - segBeat * segBeat * 0.72)
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
            : `rgba(255, 255, 255, ${segAlpha + 0.18})`
          : shielded
            ? `rgba(255, 50, 200, ${segAlpha + 0.35})`
            : `rgba(255, 255, 255, ${segAlpha + 0.18})`
        ctx.lineWidth = isMissing ? (shielded ? 5 : 3) : shielded ? 6 : 4
        ctx.stroke()
        // Core line — pure white but at a softer alpha so the lines don't feel too hot
        ctx.beginPath()
        ctx.moveTo(ix, iy)
        ctx.lineTo(ox, oy)
        ctx.strokeStyle = isMissing
          ? shielded
            ? `rgba(255, 180, 255, ${segAlpha + 0.25})`
            : `rgba(255, 255, 255, ${segAlpha + 0.38})`
          : shielded
            ? `rgba(255, 180, 255, ${segAlpha + 0.5})`
            : `rgba(255, 255, 255, ${segAlpha + 0.38})`
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

  // Shield break particles — matches the blood spray vocabulary (fewer chunky drops,
  // parent-attached so they translate with the player, late tint with cool magenta target,
  // staggered spawn delays). Pink palette instead of red because shield = pink identity.
  if (player.shieldBreakFlash > SHIELD_BREAK_FLASH - 0.02 && player.shieldBreakFlash <= SHIELD_BREAK_FLASH) {
    // Main pink shards — uniform spread, chunky drops like player blood (more than blood
    // since shield break is a bigger event)
    const shardCount = 15
    for (let i = 0; i < shardCount; i++) {
      const angle = (i / shardCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5
      const dist = Math.random() * drawRadius
      const px = player.x + Math.cos(angle) * dist
      const py = player.y + Math.sin(angle) * dist
      // Faster than blood (~1.6x) so the shatter reads as a bigger, more violent burst.
      const speed = 680 + Math.random() * 1067
      const spread = (Math.random() - 0.5) * speed * 0.2
      const size = 10.0 + Math.random() * 8.0
      // Cool magenta tint target so shards "cool off" right before dissolving (like blood)
      spawnParticleAttached(px, py,
        Math.cos(angle) * speed + spread, Math.sin(angle) * speed + spread,
        255, 60 + Math.floor(Math.random() * 50), 215,
        0.31 + Math.random() * 0.22, size,
        130, 90, 200,
        player, Math.random() * 0.06, true)
    }
    // Hot white-pink core sparks — chunky impact drops, like the blood center burst
    for (let i = 0; i < 3; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 368 + Math.random() * 790   // ~1.6x — harder core shatter
      spawnParticleAttached(player.x, player.y,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        255, 220, 255,
        0.31 + Math.random() * 0.22, 11.0 + Math.random() * 6.0,
        180, 130, 220,
        player, Math.random() * 0.05, true)
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

  // Boost-pickup star burst — drawn here (over the body, for drama) but BEFORE the dash charge dots
  // below, so the dash dots stay readable on top of the burst.
  updateAndDrawStarGlints(lastDt)

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

    // Local dark knockback halo behind each dash dot — mutes the additive gold/heal noise right
    // where the dots live so they read against a busy screen (drawn under both states below).
    {
      const haloR = 24
      const halo = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, haloR)
      halo.addColorStop(0, 'rgba(0, 8, 4, 0.5)')
      halo.addColorStop(0.55, 'rgba(0, 6, 3, 0.3)')
      halo.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = halo
      ctx.beginPath(); ctx.arc(dotX, dotY, haloR, 0, Math.PI * 2); ctx.fill()
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
      // Dark backing disc — the green bead sits on dark (not on gold noise); the margin past the
      // body also forms the dark outer ring of the two-tone "target" edge.
      ctx.beginPath(); ctx.arc(dotX, dotY, dotR + 2.5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fill()
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
      // White-hot core — static now (no beat growth; the dark backing gives enough contrast).
      const coreR = dotR * 0.5
      const coreAlpha = 0.7
      ctx.beginPath()
      ctx.arc(dotX, dotY, coreR, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(170, 255, 190, ${coreAlpha})`
      ctx.fill()
      // Bright inner rim — two-tone with the dark backing margin = a crisp edge on any background.
      ctx.strokeStyle = 'rgba(190, 255, 205, 0.95)'
      ctx.lineWidth = 1.6
      ctx.stroke()
    } else {
      // Charging — bright white pie on dark backing (NOT green — green = ready)
      const fill = 1 - (timer / (player.dashChargeTime * player.modifiers.dashChargeMult))
      const pieR = 11.87   // 10.32 * 1.15 — 15% bigger than the ready dot for visibility
      // Dark backing disc — extends past the pie so there's a dark ring around the white (contrast
      // + the dark outer edge of the two-tone target).
      ctx.beginPath()
      ctx.arc(dotX, dotY, pieR + 2.5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
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

// Cyan-white shatter burst when a weak-node breaks (and for every husk on enemy death).
function spawnNodeShatter(x: number, y: number, nodeR: number, th: MetalTheme, parent: ParticleParent): void {
  const n = lodCount(20)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 180 + Math.random() * 420   // spread further
    // Mix hot sparks (drain color) with metal debris (fill color) so a break reads as struck metal.
    const c = Math.random() < 0.6 ? th.drain : th.fill
    spawnParticleAttached(x, y, Math.cos(a) * sp, Math.sin(a) * sp,
      c[0], c[1], c[2],
      0.22 + Math.random() * 0.22, nodeR * 0.3 + Math.random() * nodeR * 0.4,
      c[0], c[1], c[2],   // glow tint → additive bloom
      parent)
  }
  spawnParticleAttached(x, y, 0, 0, 255, 240, 210, 0.12, nodeR * 1.8, 255, 220, 160, parent)  // white-hot strike flash
}

// Damage burst when a node is hit (and survives) — FEWER but BIGGER blood-red gobs, non-additive so
// they read as blood (not glow). Parent-ATTACHED to the node so the spray rides it (same as enemy
// blood riding the body). Gobs are DISTRIBUTED across the losing arc [center±half] of the rim (radius
// `dr`), each erupting radially outward from its own point so the blood spreads along the perimeter.
function spawnNodeBlood(cx: number, cy: number, dr: number, center: number, half: number, parent: ParticleParent): void {
  const n = lodCount(9)
  for (let k = 0; k < n; k++) {
    const frac = n > 1 ? k / (n - 1) : 0.5
    const ang = center + (frac - 0.5) * 2 * half + (Math.random() - 0.5) * 0.3   // along the arc + jitter
    const bx = cx + Math.cos(ang) * dr * 0.85
    const by = cy + Math.sin(ang) * dr * 0.85
    const sp = 80 + Math.random() * 120
    spawnParticleAttached(bx, by, Math.cos(ang) * sp, Math.sin(ang) * sp,   // straight out from this rim point
      225 + Math.floor(Math.random() * 30), 30 + Math.floor(Math.random() * 28), 32,
      0.24 + Math.random() * 0.16, dr * 0.26 + Math.random() * dr * 0.34,
      -1, 0, 0,   // tintR -1 = non-additive (blood, not glow)
      parent)
  }
}

// Gold burst when a heal revives a broken node (husk → live).
function spawnNodeRevive(x: number, y: number, nodeR: number, parent: ParticleParent): void {
  const n = lodCount(12)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2
    const sp = 60 + Math.random() * 130
    spawnParticleAttached(x, y, Math.cos(a) * sp, Math.sin(a) * sp - 20,
      255, 235, 170, 0.30 + Math.random() * 0.2, nodeR * 0.2 + Math.random() * nodeR * 0.22,
      255, 225, 160,   // pale-gold glow tint
      parent)
  }
  spawnParticleAttached(x, y, 0, 0, 255, 245, 200, 0.12, nodeR * 1.3, 255, 230, 170, parent)  // gold flash
}

// ── Metal "pie" node theming ──────────────────────────────────────────────────
// Each node renders as its own HP pie (reusing the enemy pie structure) themed as a metal plate.
// Selectable per boss for variety.
interface MetalTheme {
  fill: [number, number, number]      // HP wedge metal color (bright inner / dark outer derived)
  bg: [number, number, number]        // recessed background plate
  drain: [number, number, number]     // drain wedge — hot/damaged metal
  rimLight: [number, number, number]  // bevel highlight (top)
  rimDark: [number, number, number]   // bevel shadow (bottom)
  glint: [number, number, number]     // specular glint
  husk: [number, number, number]      // broken slug
}
const METAL_THEMES: Record<string, MetalTheme> = {
  chrome:   { fill: [200, 212, 224], bg: [26, 30, 36], drain: [255, 140, 50], rimLight: [240, 248, 255], rimDark: [40, 46, 56], glint: [220, 240, 255], husk: [54, 58, 66] },
  brass:    { fill: [210, 170, 90],  bg: [38, 28, 14], drain: [255, 90, 40],  rimLight: [255, 232, 160], rimDark: [60, 44, 18], glint: [255, 244, 200], husk: [70, 56, 30] },
  gunmetal: { fill: [96, 104, 118],  bg: [14, 16, 20], drain: [255, 110, 40], rimLight: [180, 196, 214], rimDark: [22, 24, 30], glint: [235, 245, 255], husk: [34, 36, 42] },
  molten:   { fill: [184, 84, 42],   bg: [24, 12, 8],  drain: [255, 180, 40], rimLight: [255, 150, 70],  rimDark: [50, 18, 10], glint: [255, 230, 120], husk: [50, 26, 18] },
}
function metalTheme(name: string): MetalTheme { return METAL_THEMES[name] ?? METAL_THEMES.chrome! }
// rgba string with depth-brightness applied + clamp
function mc(c: [number, number, number], bri: number, a: number): string {
  return `rgba(${Math.min(255, Math.floor(c[0] * bri))}, ${Math.min(255, Math.floor(c[1] * bri))}, ${Math.min(255, Math.floor(c[2] * bri))}, ${a})`
}

/** One weak-node as a metal HP pie — reuses the enemy pie structure (bg → drain wedge → HP wedge →
 * segment etches → beveled rim → specular glint), themed metal. Always shown (full HP = full plate).
 * displayFrac ≥ actualFrac (the gap is the hot drain wedge). depthBri/depthA carry the 3D depth cue. */
function drawNodePie(sx: number, sy: number, r: number, displayFrac: number, actualFrac: number, segs: number, th: MetalTheme, flashT: number, depthBri: number, depthA: number): void {
  const start = -Math.PI / 2
  const TAU = Math.PI * 2
  // Recessed dark background plate
  const bg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
  bg.addColorStop(0, mc(th.bg, depthBri, 0.85 * depthA))
  bg.addColorStop(1, mc([th.bg[0] * 0.4, th.bg[1] * 0.4, th.bg[2] * 0.4], depthBri, 0.92 * depthA))
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fillStyle = bg; ctx.fill()
  // The solid metal extends to lo = min(display, actual); the band [lo, hi] is the recent CHANGE —
  // RED (hot) when draining (display > actual), GOLD when healing (display < actual, filling up).
  const lo = Math.min(actualFrac, displayFrac)
  const hi = Math.max(actualFrac, displayFrac)
  const healing = displayFrac < actualFrac - 0.001
  if (hi - lo > 0.001) {
    ctx.beginPath(); ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, r, start + lo * TAU, start + hi * TAU); ctx.closePath()
    ctx.fillStyle = healing ? `rgba(255, 215, 110, ${0.6 * depthA})` : mc(th.drain, depthBri, 0.6 * depthA)
    ctx.fill()
  }
  // Solid metal HP wedge — bright inner → dark outer, up to lo
  if (lo > 0) {
    const bri = depthBri * (1 + 0.5 * flashT)   // hit flash brightens the plate
    const fg = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
    fg.addColorStop(0, mc([th.fill[0] + 40, th.fill[1] + 40, th.fill[2] + 40], bri, 0.95 * depthA))
    fg.addColorStop(0.7, mc(th.fill, bri, 0.92 * depthA))
    fg.addColorStop(1, mc([th.fill[0] * 0.5, th.fill[1] * 0.5, th.fill[2] * 0.5], bri, 0.92 * depthA))
    ctx.beginPath(); ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, r, start, start + lo * TAU); ctx.closePath()
    ctx.fillStyle = fg; ctx.fill()
  }
  // Segment etches — one per HP point, reads as a multi-plate pie
  if (segs > 1) {
    ctx.strokeStyle = mc(th.rimDark, depthBri, 0.55 * depthA); ctx.lineWidth = 1
    for (let s = 0; s < segs; s++) {
      const ang = start + (s / segs) * TAU
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(ang) * r, sy + Math.sin(ang) * r); ctx.stroke()
    }
  }
  // Bright metal rim — full, uniform all the way around
  ctx.lineWidth = 2
  ctx.strokeStyle = mc(th.rimLight, depthBri, 0.9 * depthA)
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.stroke()
  // Specular glint — CLIPPED to the filled wedge, so it never glows over the drained (black) area
  if (hi > 0) {
    ctx.save()
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.arc(sx, sy, r, start, start + hi * TAU); ctx.closePath(); ctx.clip()
    const gx = sx - r * 0.4, gy = sy - r * 0.4
    const gl = ctx.createRadialGradient(gx, gy, 0, gx, gy, r * 0.55)
    gl.addColorStop(0, mc(th.glint, depthBri, (0.45 + 0.45 * flashT) * depthA))
    gl.addColorStop(1, mc(th.glint, depthBri, 0))
    ctx.beginPath(); ctx.arc(gx, gy, r * 0.55, 0, TAU); ctx.fillStyle = gl; ctx.fill()
    ctx.restore()
  }
}

/** The weak-node body: dark metal hub + an enemy-colored CHAMBER (lit sphere + beat core) so it reads
 * as a 3D ball the nodes orbit, + a full metal rim. `aura` scales the chamber (0 = plain hub). Shared
 * by the live enemy (drawEnemy) and the designer preview so they match. */
function drawNodeBody(sx: number, sy: number, r: number, th: MetalTheme, cr: number, cg: number, cb: number, aura: number, flash: number): void {
  const TAU = Math.PI * 2
  // Dark metal hub base
  const hub = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
  hub.addColorStop(0, mc(th.bg, 1 + 0.6 * flash, 0.95))
  hub.addColorStop(1, mc([th.bg[0] * 0.5, th.bg[1] * 0.5, th.bg[2] * 0.5], 1, 0.95))
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fillStyle = hub; ctx.fill()
  // Chamber — lit sphere (highlight offset top-left) + beat-pulsing core
  if (aura > 0.001) {
    ctx.save(); ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.clip()
    const lx = sx - r * 0.36, ly = sy - r * 0.36
    const sph = ctx.createRadialGradient(lx, ly, r * 0.08, sx + r * 0.18, sy + r * 0.18, r * 1.25)
    sph.addColorStop(0, `rgba(${Math.min(255, cr + 70)}, ${Math.min(255, cg + 70)}, ${Math.min(255, cb + 70)}, ${0.5 * aura})`)
    sph.addColorStop(0.5, `rgba(${cr}, ${cg}, ${cb}, ${0.26 * aura})`)
    sph.addColorStop(1, `rgba(${Math.floor(cr * 0.3)}, ${Math.floor(cg * 0.3)}, ${Math.floor(cb * 0.3)}, 0)`)
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fillStyle = sph; ctx.fill()
    const coreR = r * (0.34 + 0.12 * globalBeatPulse)
    const core = ctx.createRadialGradient(sx, sy, 0, sx, sy, coreR)
    core.addColorStop(0, `rgba(${Math.min(255, cr + 90)}, ${Math.min(255, cg + 90)}, ${Math.min(255, cb + 90)}, ${(0.35 + 0.3 * globalBeatPulse) * aura})`)
    core.addColorStop(1, `rgba(${cr}, ${cg}, ${cb}, 0)`)
    ctx.beginPath(); ctx.arc(sx, sy, coreR, 0, TAU); ctx.fillStyle = core; ctx.fill()
    ctx.restore()
  }
  // Full metal rim
  ctx.lineWidth = 2.5
  ctx.strokeStyle = mc(th.rimLight, 1 + 0.4 * flash, 0.85)
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.stroke()
}

/** Constellation STRUTS — engineered metal rods between adjacent live nodes: a dark cylindrical body
 * with an OFFSET highlight stripe (reads as a round rod lit from above), BOLT joints where it meets
 * each pie, DEPTH-scaled width/brightness, and (with Aura) a glowing enemy-color energy filament that
 * pulses on the beat. A broken node frays its two struts. Shared by game + preview. Drawn UNDER pies. */
function drawNodeStruts(e: Enemy, t: number, nodeR: number, th: MetalTheme, aura: number): void {
  const nN = e.nodeHp.length
  if (nN < 2) return
  const beatGlow = globalBeatPulse
  const lim = nN === 2 ? 1 : nN
  ctx.lineCap = 'round'
  for (let i = 0; i < lim; i++) {
    const j = (i + 1) % nN
    if (e.nodeHp[i]! <= 0 || e.nodeHp[j]! <= 0) continue   // frayed — an end is a husk
    const pa = nodeWorldPos(e, i, t), pb = nodeWorldPos(e, j, t)
    let ax = pa.x - camX, ay = pa.y - camY, bx = pb.x - camX, by = pb.y - camY
    const zi = nodeDepth(e, i, t), zj = nodeDepth(e, j, t), zAvg = (zi + zj) / 2
    const dFront = (zAvg + 1) / 2
    const depthBri = 1 + 0.15 * zAvg
    const depthA = Math.min(1, 1 + 0.12 * zAvg)
    const str = Math.min(e.nodeHp[i]!, e.nodeHp[j]!) / e.nodeMaxHp
    // Pull the ends back to each pie's rim so the bolts sit ON the metal, not under it.
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey) || 1
    const dirX = ex / len, dirY = ey / len
    const riA = nodeR * (0.7 + 0.3 * (zi + 1)), riB = nodeR * (0.7 + 0.3 * (zj + 1))
    ax += dirX * riA * 0.9; ay += dirY * riA * 0.9
    bx -= dirX * riB * 0.9; by -= dirY * riB * 0.9
    let px = -dirY, py = dirX
    if (py > 0) { px = -px; py = -py }   // perpendicular pointing up (toward the light)
    const w = 2.8 + 1.7 * dFront
    // Rod body — light metal so it pops against the dark chamber, round
    ctx.lineWidth = w
    ctx.strokeStyle = mc(th.fill, depthBri, (0.6 + 0.3 * str) * depthA)
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    // Energy filament — glowing enemy-color core, brightens on the beat (Aura-gated)
    if (aura > 0.001) {
      ctx.lineWidth = Math.max(0.8, w * 0.4)
      ctx.strokeStyle = `rgba(${e.cr}, ${e.cg}, ${e.cb}, ${(0.1 + 0.45 * beatGlow) * str * aura * depthA})`
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
    }
    // Offset highlight stripe → cylindrical read
    const off = w * 0.32
    ctx.lineWidth = 1
    ctx.strokeStyle = mc(th.rimLight, depthBri, (0.45 + 0.4 * str) * depthA)
    ctx.beginPath(); ctx.moveTo(ax + px * off, ay + py * off); ctx.lineTo(bx + px * off, by + py * off); ctx.stroke()
    // Bolt joints at the rims
    const br = Math.max(1.2, w * 0.55)
    ctx.fillStyle = mc(th.rimLight, depthBri, 0.7 * depthA)
    ctx.beginPath(); ctx.arc(ax, ay, br, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(bx, by, br, 0, Math.PI * 2); ctx.fill()
  }
  ctx.lineCap = 'butt'
}

// Weak-node enemies (see boss_nodes_plan.md). Each node is a metal HP pie; broken nodes stay in the
// pattern as dark slugs; the body is a metal hub with an enemy-colored chamber.
function drawWeakNodes(enemy: Enemy): void {
  const t = gameTimeMs / 1000
  const nodeR = nodeRadius(enemy)
  const th = metalTheme(enemy.nodeMetal)
  // Death cascade — fire each node's staggered burst as deathTimer passes its delay, so the final hit
  // ripples out to the rest instead of everything popping at once.
  if (enemy.dying) {
    for (let k = 0; k < enemy.nodeDeathStagger.length; k++) {
      if (enemy.nodeDeathStagger[k]! >= 0 && enemy.deathTimer >= enemy.nodeDeathStagger[k]!) {
        enemy.nodeDeathStagger[k] = -1
        enemy.nodeJustBroke[k] = true
      }
    }
  }
  // Per-node transient FX (break shatter / beat-dash lightning AT the node / heal revive). Runs even
  // while dying so the death animation includes the shards.
  for (let i = 0; i < enemy.nodeJustBroke.length; i++) {
    if (!enemy.nodeJustBroke[i] && !enemy.nodeBeatDashHit[i] && !enemy.nodeJustRevived[i] && !enemy.nodeJustHit[i]) continue
    const p = nodeWorldPos(enemy, i, t)
    // Node parent — getter returns the node's live position each frame so attached bursts (blood,
    // shatter, revive) ride the node/husk as it keeps moving on the pattern.
    const np: ParticleParent = {
      get x() { return nodeWorldPos(enemy, i, gameTimeMs / 1000).x },
      get y() { return nodeWorldPos(enemy, i, gameTimeMs / 1000).y },
    }
    if (enemy.nodeJustHit[i]) {
      enemy.nodeJustHit[i] = false
      // Erupt ACROSS the pie section that's losing HP — gobs distributed along the just-lost arc of the
      // rim, each spraying radially outward from its own point. The wedge starts at -π/2 and fills
      // clockwise, so the lost arc is [newFrac, displayFrac] in screen angles.
      const newFrac = enemy.nodeHp[i]! / enemy.nodeMaxHp
      const oldFrac = enemy.nodeDisplayHp[i]! / enemy.nodeMaxHp
      const center = -Math.PI / 2 + ((newFrac + oldFrac) / 2) * Math.PI * 2
      const half = Math.max((oldFrac - newFrac) * Math.PI, 0.5)   // half-width of the spread (≥ ±0.5 rad)
      const dr = nodeR * (0.7 + 0.3 * (nodeDepth(enemy, i, t) + 1))
      spawnNodeBlood(p.x, p.y, dr, center, half, np)
    }
    if (enemy.nodeBeatDashHit[i]) {
      enemy.nodeBeatDashHit[i] = false
      const bolts = 4
      for (let b = 0; b < bolts; b++) {
        const a = (b / bolts) * Math.PI * 2 + Math.random() * 0.6
        spawnNodeLightningBolt(enemy, i, a, nodeR * (1.5 + Math.random() * 0.8), 1.1, 0.30 + Math.random() * 0.06)
      }
    }
    if (enemy.nodeJustBroke[i]) { enemy.nodeJustBroke[i] = false; spawnNodeShatter(p.x, p.y, nodeR, th, np) }
    if (enemy.nodeJustRevived[i]) { enemy.nodeJustRevived[i] = false; spawnNodeRevive(p.x, p.y, nodeR, np) }
  }
  if (enemy.dying) return   // body dissolve handles the rest (armored body drawn in drawEnemy)

  // Per-node depth — shared by the struts (below) and the back-to-front node draw.
  const nN = enemy.nodeHp.length
  const zs: number[] = []
  for (let i = 0; i < nN; i++) zs.push(nodeDepth(enemy, i, t))
  const aura = enemy.nodeAura

  drawNodeStruts(enemy, t, nodeR, th, aura)

  // Node pies — DEAD nodes first (so they stack UNDER the live ones), then live nodes back-to-front
  // so near ones occlude far ones; far ones dim/fade (atmospheric depth).
  const order = zs.map((_, i) => i).sort((p, q) => {
    const dead = (enemy.nodeHp[p]! <= 0 ? 0 : 1) - (enemy.nodeHp[q]! <= 0 ? 0 : 1)
    return dead !== 0 ? dead : zs[p]! - zs[q]!
  })
  for (const i of order) {
    const z = zs[i]!
    const depthBri = 1 + 0.15 * z               // back darker, front brighter
    const depthA = Math.min(1, 1 + 0.12 * z)   // back fades out
    const p = nodeWorldPos(enemy, i, t)
    const sx = p.x - camX, sy = p.y - camY
    const dr = nodeR * (0.7 + 0.3 * (z + 1))
    const hp = enemy.nodeHp[i]!
    if (hp > 0) {
      const flashT = Math.min(1, Math.max(0, enemy.nodeFlash[i]!) / 0.2)
      const actualFrac = hp / enemy.nodeMaxHp
      const displayFrac = enemy.nodeDisplayHp[i]! / enemy.nodeMaxHp
      drawNodePie(sx, sy, dr, displayFrac, actualFrac, enemy.nodeMaxHp, th, flashT, depthBri, depthA)
    } else {
      // Dead node — a dull RED slug, SAME size as a live node, obviously inert (no metal sheen/glint).
      // Drawn first (above) so it stacks UNDER the live nodes.
      ctx.beginPath(); ctx.arc(sx, sy, dr, 0, Math.PI * 2)
      ctx.fillStyle = mc([112, 44, 44], depthBri, 0.88 * depthA)
      ctx.fill()
      ctx.strokeStyle = mc([64, 24, 24], depthBri, 0.9 * depthA)
      ctx.lineWidth = 2
      ctx.stroke()
      // Dead cracks
      ctx.strokeStyle = mc([54, 20, 20], depthBri, 0.7 * depthA)
      ctx.lineWidth = 1
      for (let c = 0; c < 3; c++) {
        const ca = (c / 3) * Math.PI * 2 + i
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(ca) * dr * 0.85, sy + Math.sin(ca) * dr * 0.85); ctx.stroke()
      }
    }
    // Depth haze — back nodes sink into the enemy-colored chamber atmosphere (soft colored veil that
    // grows the further back the node is). Front nodes (z ≥ 0) stay crisp metal.
    const hazeT = Math.max(0, -z)
    if (hazeT > 0.02 && aura > 0.001) {
      const hz = ctx.createRadialGradient(sx, sy, 0, sx, sy, dr * 1.35)
      hz.addColorStop(0, `rgba(${enemy.cr}, ${enemy.cg}, ${enemy.cb}, ${0.5 * hazeT * aura * depthA})`)
      hz.addColorStop(1, `rgba(${enemy.cr}, ${enemy.cg}, ${enemy.cb}, 0)`)
      ctx.beginPath(); ctx.arc(sx, sy, dr * 1.35, 0, Math.PI * 2); ctx.fillStyle = hz; ctx.fill()
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
    // Re-anchor the ENTIRE death render to the kill spot captured at death (deathX/deathY). The sim
    // shoves a just-killed enemy ~one radius (worse for big/fast bouncers), so reading live enemy.x
    // here would slide the dissolve away from the volatile blast. deathX is immune to that.
    const ex = enemy.deathX, ey = enemy.deathY
    sx = ex - camX
    sy = ey - camY
    const sizeScale = 1 + Math.max(0, (r - 60) / 60) * 0.5  // floor at 1x, gentle scale above radius 60
    const deathDur = 0.21
    const t = Math.min(dt / deathDur, 1)

    const hr = enemy.cr, hg = enemy.cg, hb = enemy.cb

    // Death ripples + red hit particles on first frame
    if (dt < 0.02) {
      spawnDeathRipples(ex, ey, r, enemy.color)
    }
    if (dt < 0.02) {
      const redCount = Math.max(4, Math.floor(10 * sizeScale))
      for (let i = 0; i < redCount; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = r * Math.random() * 0.5
        const px = ex + Math.cos(angle) * dist
        const py = ey + Math.sin(angle) * dist
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
        const px = ex + Math.cos(angle) * dist
        const py = ey + Math.sin(angle) * dist
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

  // Weak-node enemy — armored, invulnerable body (dim disc + colored rim). No HP pie: the orbiting
  // node ring (drawn in drawWeakNodes) IS the health read. Body flicker on a node hit (enemy.hitFlash).
  if (enemy.weakNodes) {
    const flash = Math.min(1, enemy.hitFlash / HIT_FLASH_DURATION)
    drawNodeBody(sx, sy, r, metalTheme(enemy.nodeMetal), enemy.cr, enemy.cg, enemy.cb, enemy.nodeAura, flash)
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

  // Heal pulse — the SAME gold effect the player gets, mirrored onto enemies. Auto-detects any HP
  // increase since last frame (heal-blast nourish, consume-orb heal, revenge-consume heal — every
  // source) and fires the gold halo timer + a floaty golden sparkle burst that lifts off the body.
  if (enemy.pendingHeal > 0) {
    const gained = enemy.pendingHeal
    enemy.pendingHeal = 0
    enemy.healAmount = Math.max(enemy.healAmount, gained)
    enemy.healFlash = HEAL_PULSE_DURATION
    // Match the PLAYER heal's relaxed round feel on enemies of any size: keep the SAME slow speed +
    // gentle upward drift (NOT scaled by size — scaling speed is what made big enemies spray sharp
    // spikes). Only the spawn spread (dist), particle SIZE, and COUNT scale with the body, so a big
    // enemy gets a fuller, bigger cloud — still slow and round, not a fast burst. `sizeMult` is mild.
    const s = Math.max(0.6, Math.min(2.5, r / Math.max(1, player.hitRadius)))
    const sizeMult = Math.max(0.8, Math.min(1.8, s))
    const sparkCount = Math.min(40, 8 + Math.round(gained * 5) + Math.round((s - 1) * 8))
    for (let i = 0; i < sparkCount; i++) {
      const a = (i / sparkCount) * Math.PI * 2 + Math.random() * 0.4
      const spd = 75 + Math.random() * 110                      // gentle outward drift (still floaty)
      const dist = r * (0.55 + Math.random() * 0.75)            // spawn out to the body edge + beyond
      spawnParticleAttached(
        enemy.x + Math.cos(a) * dist, enemy.y + Math.sin(a) * dist,
        Math.cos(a) * spd, Math.sin(a) * spd - 55,             // drift outward + gentle upward rise
        255, 245, 215,                                          // bright white-gold body
        0.75 + Math.random() * 0.55, (3.6 + Math.random() * 3.2) * sizeMult,   // big, round, floaty glow
        255, 232, 180,                                          // pale-gold glow tint → white-gold halo
        enemy, 0, false, true)                                  // belowEnemies → render UNDER the body
    }
    // White-gold twinkle highlights drifting up from the center (same as the player heal burst)
    const hotCount = Math.min(7, 2 + Math.round(gained) + Math.round((s - 1) * 2))
    for (let i = 0; i < hotCount; i++) {
      const a = Math.random() * Math.PI * 2
      const spd = 65 + Math.random() * 100
      spawnParticleAttached(enemy.x, enemy.y, Math.cos(a) * spd, Math.sin(a) * spd - 45,
        255, 252, 238, 0.55 + Math.random() * 0.35, (2.4 + Math.random() * 2.2) * sizeMult,
        255, 242, 205, enemy, 0, false, true)
    }
  }
  if (enemy.healFlash > 0) {
    enemy.healFlash -= lastDt
    if (enemy.healFlash < 0) { enemy.healFlash = 0; enemy.healAmount = 0 }
  }

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
  // Gold heal halo — mirror of the player's heal halo (Renderer.drawPlayer): a breathing inner glow
  // over the body + a soft outer halo ring spilling past the edge. Drawn under the pie/body so the
  // enemy color still reads. Scales with how much was healed and breathes at the same ~1.4 Hz.
  if (enemy.healFlash > 0) {
    const env = enemy.healFlash / HEAL_PULSE_DURATION
    const sustain = env < 0.85 ? Math.pow(env / 0.85, 1.6) : 1
    const elapsed = HEAL_PULSE_DURATION - enemy.healFlash
    const fastPulse = 0.85 + 0.15 * Math.cos(elapsed * 9)
    const sizeScale = Math.max(0.3, Math.min(1, Math.pow(enemy.healAmount / 4, 1.2)))
    const baseA = sustain * fastPulse * sizeScale * 1.7
    const prevComp = ctx.globalCompositeOperation
    ctx.globalCompositeOperation = 'lighter'
    const innerGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
    innerGrad.addColorStop(0,   `rgba(255, 248, 218, ${baseA * 0.30})`)
    innerGrad.addColorStop(0.5, `rgba(255, 238, 188, ${baseA * 0.35})`)
    innerGrad.addColorStop(1,   `rgba(255, 226, 158, ${baseA * 0.12})`)
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = innerGrad
    ctx.fill()
    const haloR = r * 1.85
    const haloGrad = ctx.createRadialGradient(sx, sy, r * 0.85, sx, sy, haloR)
    haloGrad.addColorStop(0,    'rgba(255, 246, 205, 0)')
    haloGrad.addColorStop(0.35, `rgba(255, 244, 200, ${baseA * 0.32})`)
    haloGrad.addColorStop(0.55, `rgba(255, 240, 192, ${baseA * 0.42})`)
    haloGrad.addColorStop(0.80, `rgba(255, 230, 170, ${baseA * 0.16})`)
    haloGrad.addColorStop(1,    'rgba(255, 226, 158, 0)')
    ctx.beginPath()
    ctx.arc(sx, sy, haloR, 0, Math.PI * 2)
    ctx.fillStyle = haloGrad
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
    // Particles spawn AT enemy center (no velocity offset which would skew the apparent origin
    // during bounces/direction changes). They're parented to the enemy so the whole burst
    // translates with the enemy during the animation — stays visually attached to the body.
    for (let i = 0; i < count; i++) {
      const angle = damageArcStart + Math.random() * arcSpan
      const dist = Math.random() * r
      const px = enemy.x + Math.cos(angle) * dist
      const py = enemy.y + Math.sin(angle) * dist
      const speed = (274 + Math.random() * 430) * (0.8 + intensity * 0.2)
      const vx = Math.cos(angle) * speed + (Math.random() - 0.5) * speed * 0.2
      const vy = Math.sin(angle) * speed + (Math.random() - 0.5) * speed * 0.2
      const sizeScale = Math.min(r / 44, 1)
      const size = (3.2 + Math.random() * 3.2) * (0.8 + intensity * 0.2) * sizeScale * sizeScale
      spawnParticleAttached(px, py, vx, vy,
        255, 60 + Math.floor(Math.random() * 45), 55,
        0.31 + Math.random() * 0.22, size,
        -1, 0, 0,
        enemy)
    }
    // Blood spray from center — enemy colored
    const sprayCount = Math.floor(1.5 * intensity)
    for (let i = 0; i < sprayCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 118 + Math.random() * 254 * intensity
      const sizeScale2 = Math.min(r / 44, 1)
      const size = (2.8 + Math.random() * 3.2) * (0.8 + intensity * 0.2) * sizeScale2 * sizeScale2
      spawnParticleAttached(enemy.x, enemy.y,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        235 + Math.floor(Math.random() * 20), 30 + Math.floor(Math.random() * 35), 30,
        0.31 + Math.random() * 0.22, size,
        -1, 0, 0,
        enemy)
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
    } else if (actualHpFraction > hpFraction) {
      // Heal — GOLD fill band [display, actual] that fills up as displayHp catches the new HP (same as nodes)
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, r, startAngle + hpFraction * Math.PI * 2, startAngle + actualHpFraction * Math.PI * 2)
      ctx.closePath()
      ctx.fillStyle = 'rgba(255, 215, 110, 0.55)'
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
  // Snow flake drizzle on chilled enemies — emit the existing 6-armed MiniSnowflake (same kind
  // used by the Chill Zone shatter burst, just at a sparse drizzle rate). Drift slightly
  // outward + downward with the existing snowflake physics (gravity + drag). Rendered on top
  // of the enemy because updateAndDrawChillFX runs AFTER drawEnemy + drawPlayer in the pipeline.
  if (chillIntensity > 0.2 && Math.random() < chillIntensity * 0.15) {
    const sa = Math.random() * Math.PI * 2
    const sd = Math.random() * enemy.radius * 0.7
    const spawnX = enemy.x + Math.cos(sa) * sd
    const spawnY = enemy.y + Math.sin(sa) * sd
    const outAng = Math.atan2(spawnY - enemy.y, spawnX - enemy.x)
    const speed = 18 + Math.random() * 22
    miniSnowflakes.push({
      x: spawnX, y: spawnY,
      vx: Math.cos(outAng) * speed * 0.5 + (Math.random() - 0.5) * 14,
      vy: Math.sin(outAng) * speed * 0.5 + 8 + Math.random() * 14,
      rot: Math.random() * Math.PI * 2,
      rotVel: (Math.random() - 0.5) * 4,
      size: 3.5 + Math.random() * 2.5,
      timer: 0, lifetime: 0.65 + Math.random() * 0.4,
    })
  }
  if (chillIntensity > 0) {
    // Saturated tint, dialed back from 0.14+0.42 (cap 0.56) so chilled enemies don't get
    // washed out behind a wall of blue. 0.10+0.28 = cap 0.38 — clearly readable, less heavy.
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(80, 200, 255, ${0.10 + chillIntensity * 0.28})`
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

  // Volatile indicator — pulsing inner glow + ambient embers. A HEAL-tagged volatile (volatileHeal)
  // sheds white-gold NOURISH embers + a warm gold glow instead of the hot-orange fire, so you read
  // "this one will heal" the same way the heal bullet does — never confused with a damage volatile.
  if (enemy.volatile && r > 5 && !enemy.dying) {
    const heal = enemy.volatileHeal
    // Inner glow — slow pulse
    const vPulse = 0.5 + Math.sin(performance.now() * 0.004) * 0.5
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = heal
      ? `rgba(255, 240, 200, ${0.12 + vPulse * 0.15})`
      : `rgba(255, 100, 0, ${0.12 + vPulse * 0.15})`
    ctx.fill()

    // Ambient embers — rising from body edge, scales with enemy size
    const fireScale = Math.min(r / 44, 1.4)
    if (Math.random() < 0.2 + fireScale * 0.1) {
      const a = Math.random() * Math.PI * 2
      const edgeDist = r * (0.7 + Math.random() * 0.3)
      const px = enemy.x + Math.cos(a) * edgeDist
      const py = enemy.y + Math.sin(a) * edgeDist
      const tint = Math.random()
      if (heal) {
        // White-gold nourish embers — biased bright toward white with a pale-gold glow tint
        // (same palette as the heal bullet's in-flight motes), drifting up off the body.
        spawnParticle(px, py,
          (Math.random() - 0.5) * 16, -25 - Math.random() * 35,
          255, 246 + Math.floor(tint * 9), 218 + Math.floor(tint * 30),
          0.2 + Math.random() * 0.15, (4.95 + Math.random() * 4.14) * fireScale,
          0, 255, 235, 188)
      } else {
        spawnParticle(px, py,
          (Math.random() - 0.5) * 20, -25 - Math.random() * 35,
          255, Math.floor(60 + tint * 80), Math.floor(tint * 30),
          0.15 + Math.random() * 0.12, (4.95 + Math.random() * 4.14) * fireScale)
      }
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
        const ruptureN = lodCount(24)
        for (let p = 0; p < ruptureN; p++) {
          const a = (p / ruptureN) * Math.PI * 2 + (Math.random() - 0.5) * 0.3
          const speed = 250 + Math.random() * 300
          spawnParticle(enemy.x, enemy.y,
            Math.cos(a) * speed, Math.sin(a) * speed,
            255, 255, 255, 0.2 + Math.random() * 0.15, 4.5 + Math.random() * 3.5)
        }
        // Pink energy burst
        const pinkN = lodCount(14)
        for (let p = 0; p < pinkN; p++) {
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
        const consumeN = lodCount(25)   // enemy dodge (not the player's dash — that's exempt)
        for (let p = 0; p < consumeN; p++) {
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
        // Ready — dark backing + radial-gradient bead + STATIC white-hot core + bright rim, mirroring
        // the player dash dot's depth treatment. Static core (no globalBeatPulse) = no "bounce".
        const readyR = dotR * 1.15
        // Dark backing disc — depth + a dark two-tone edge so the bead reads on a busy screen.
        ctx.beginPath(); ctx.arc(dx, dy, readyR + 2.5, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'; ctx.fill()
        // Radial gradient body — bright center → darker edge (glowing bead look)
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
        // Static white-hot core (no beat pulse → no bounce)
        const coreR = readyR * 0.5
        ctx.beginPath()
        ctx.arc(dx, dy, coreR, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.7)`
        ctx.fill()
        // Bright inner rim — two-tone with the dark backing margin = crisp edge on any background.
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.95)`
        ctx.lineWidth = 1.6
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
        // Recharging — white pie on a dark backing that extends past it (dark ring margin = depth),
        // matching the player dash-slot pie.
        const fill = 1 - (timer / chargeTime)
        const pieR = dotR * 1.15
        ctx.beginPath()
        ctx.arc(dx, dy, pieR + 2.5, 0, Math.PI * 2)
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
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
      const expansion = getRingExpansion(pr.attackTimer, pr.expandTime)
      const currentRadius = pr.ringRadius * expansion
      if (currentRadius > 1) {
        const pExpandTime = pr.expandTime
        const buildup = Math.min(pr.attackTimer / pExpandTime, 1)
        const alpha = getRingAlpha(pr.attackTimer, 0.3 + 0.5 * buildup, pr.expandTime)

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

  // Weak-node preview — all-live glowing nodes moving on the chosen pattern (uses the SAME
  // nodeWorldPos as the real enemy, so what you tune here is exactly what you'll play).
  if (preview.weakNodes) {
    const t = gameTimeMs / 1000
    const pMaxHp = Math.max(1, preview.weakNodeHp)
    // Parse the #rrggbb color to RGB for the enemy-colored aura/filament.
    const pcr = parseInt(preview.color.slice(1, 3), 16) || 0
    const pcg = parseInt(preview.color.slice(3, 5), 16) || 0
    const pcb = parseInt(preview.color.slice(5, 7), 16) || 0
    const stub = {
      x: worldX, y: worldY, radius: preview.radius,
      nodeHp: new Array(Math.max(1, preview.weakNodeCount)).fill(pMaxHp),
      nodeDisplayHp: new Array(Math.max(1, preview.weakNodeCount)).fill(pMaxHp),
      nodeMaxHp: pMaxHp,
      nodeMetal: preview.weakNodeMetal,
      nodeAura: preview.weakNodeAura,
      cr: pcr, cg: pcg, cb: pcb,
      nodeSeed: 0,
      nodeOrbitFrac: preview.weakNodeOrbitFrac,
      nodeSizeFrac: preview.weakNodeSizeFrac,
      nodePattern: preview.weakNodePattern,
      nodeSpeed: preview.weakNodeSpeed,
      nodeWorldSpin: preview.weakNodeWorldSpin,
      nodeBeatDiv: preview.weakNodeBeatDiv,
      nodeAmp: preview.weakNodeAmp,
    } as unknown as Enemy
    const nr = nodeRadius(stub)
    const th = metalTheme(stub.nodeMetal)
    drawNodeBody(worldX - camX, worldY - camY, preview.radius, th, pcr, pcg, pcb, preview.weakNodeAura, 0)
    drawNodeStruts(stub, t, nr, th, preview.weakNodeAura)
    const nP = stub.nodeHp.length
    const zsP: number[] = []
    for (let i = 0; i < nP; i++) zsP.push(nodeDepth(stub, i, t))
    const orderP = zsP.map((_, i) => i).sort((p, q) => zsP[p]! - zsP[q]!)
    for (const i of orderP) {
      const z = zsP[i]!
      const depthBri = 1 + 0.15 * z
      const depthA = Math.min(1, 1 + 0.12 * z)
      const p = nodeWorldPos(stub, i, t)
      const nx = p.x - camX, ny = p.y - camY
      const pdr = nr * (0.7 + 0.3 * (z + 1))
      drawNodePie(nx, ny, pdr, 1, 1, pMaxHp, th, 0, depthBri, depthA)
      const hazeT = Math.max(0, -z)
      if (hazeT > 0.02 && preview.weakNodeAura > 0.001) {
        const hz = ctx.createRadialGradient(nx, ny, 0, nx, ny, pdr * 1.35)
        hz.addColorStop(0, `rgba(${pcr}, ${pcg}, ${pcb}, ${0.5 * hazeT * preview.weakNodeAura * depthA})`)
        hz.addColorStop(1, `rgba(${pcr}, ${pcg}, ${pcb}, 0)`)
        ctx.beginPath(); ctx.arc(nx, ny, pdr * 1.35, 0, Math.PI * 2); ctx.fillStyle = hz; ctx.fill()
      }
    }
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

// Music-note HUD button (top-left) — click cycles the background track. Drawn over the HUD.
let musicBtnRect = { x: 14, y: 14, w: 30, h: 30 }
function drawMusicButton(): void {
  const { x, y, w, h } = musicBtnRect
  const pulse = 0.6 + 0.4 * globalBeatPulse   // gentle beat-synced glow so it feels musical
  ctx.save()
  ctx.fillStyle = 'rgba(13,10,26,0.5)'
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill()
  ctx.strokeStyle = `rgba(79,195,247,${0.3 + 0.25 * pulse})`
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = `rgba(180,225,255,${0.7 + 0.25 * pulse})`
  ctx.font = '18px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('♫', x + w / 2, y + h / 2 + 1)   // ♫
  ctx.restore()
}
/** True if (mx,my) is on the music-note HUD button. */
export function getMusicButtonClick(mx: number, my: number): boolean {
  const { x, y, w, h } = musicBtnRect
  return mx >= x && mx <= x + w && my >= y && my <= y + h
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

    particleCount = 0  // kill all game particles

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

    // Zoom slider — placed below volume in the pause menu
    const pauseZoomRect = drawZoomSlider(pcx - pauseVolW / 2, pauseVolRect.y + pauseVolRect.h + 40, pauseVolW)
    zoomSliderRect = pauseZoomRect

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

// Camera zoom slider — mirrors the volume slider pattern. Maps the slider position 0..1
// onto the cameraZoom range [CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX]. Labelled "ZOOM" and tinted
// gold to visually distinguish from the cyan volume slider.
export function drawZoomSlider(x: number, y: number, sliderW = 200): { x: number; y: number; w: number; h: number } {
  const range = getCameraZoomRange()
  const norm = (cameraZoom - range.min) / (range.max - range.min)
  const trackH = 6
  const thumbR = 10
  const trackY = y + thumbR

  ctx.font = 'bold 16px monospace'
  ctx.textAlign = 'center'
  ctx.fillStyle = 'rgba(255, 215, 64, 0.7)'
  ctx.fillText('Z O O M', x + sliderW / 2, y - 6)

  ctx.beginPath()
  ctx.roundRect(x, trackY - trackH / 2, sliderW, trackH, 3)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.fill()

  const fillW = sliderW * norm
  if (fillW > 0) {
    ctx.beginPath()
    ctx.roundRect(x, trackY - trackH / 2, fillW, trackH, 3)
    ctx.fillStyle = 'rgba(255, 215, 64, 0.3)'
    ctx.fill()
  }

  const thumbX = x + fillW
  ctx.beginPath()
  ctx.arc(thumbX, trackY, thumbR, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(255, 215, 64, 0.85)'
  ctx.fill()

  return { x, y: trackY - thumbR, w: sliderW, h: thumbR * 2 }
}

let zoomSliderRect: { x: number; y: number; w: number; h: number } | null = null
let zoomDragging = false
export function getZoomSliderRect(): typeof zoomSliderRect { return zoomSliderRect }
export function setZoomSliderRect(r: typeof zoomSliderRect): void { zoomSliderRect = r }
export function isZoomDragging(): boolean { return zoomDragging }
export function startZoomDrag(mx: number, my: number): boolean {
  if (!zoomSliderRect) return false
  const r = zoomSliderRect
  if (mx >= r.x - 5 && mx <= r.x + r.w + 5 && my >= r.y - 5 && my <= r.y + r.h + 5) {
    zoomDragging = true
    return true
  }
  return false
}
export function updateZoomDrag(mx: number): number | null {
  if (!zoomDragging || !zoomSliderRect) return null
  const r = zoomSliderRect
  const norm = Math.max(0, Math.min(1, (mx - r.x) / r.w))
  const range = getCameraZoomRange()
  return range.min + norm * (range.max - range.min)
}
export function stopZoomDrag(): void { zoomDragging = false }

export function getScreenWidth(): number { return width }
export function getScreenHeight(): number { return height }

import type { Player } from '../entities/Player.ts'
import { getEffectiveRadius } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import type { Ring } from '../entities/Ring.ts'
import { getRingExpansion, getRingAlpha, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import { getPattern, getLoopPosition, getLoopLength } from '../audio/PatternClock.ts'
import { getPreviewEnemy } from '../game/EnemyDesigner.ts'
import type { Camera } from '../game/Arena.ts'
import { ARENA_W, ARENA_H, ARENA_RADIUS, ARENA_CX, ARENA_CY, PILL_R, PILL_HALF_W, CROSS_HW, CROSS_HE, getArenaShape, getHexVertices, getCrossVertices } from '../game/Arena.ts'
import { getBlockedArcs } from '../game/RingOcclusion.ts'
import type { BlockedArc } from '../game/RingOcclusion.ts'
import { getEnemies } from '../core/GameState.ts'
import { hasBonus } from '../game/UpgradeManager.ts'
import { getOrbs } from '../entities/XPOrb.ts'
import { getBeatName } from '../audio/AudioEngine.ts'
import { BEAT_SEC } from '../utils/constants.ts'
import {
  GRID_ALPHA,
  GRID_CELL_PX,
  COLOR_PLAYER,
  PLAYER_RADIUS,
  PARTICLE_CAP,
  ARENA_BUFFER,
  HIT_FLASH_DURATION,
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
let playerGlowIntensity = 0
let outerPulseIntensity = 0
let dashSweepIntensity = 0
let dashSweepStartX = 0
let dashSweepStartY = 0
let dashSweepEndX = 0
let dashSweepEndY = 0
let dashSweepRadius = 0
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
  absorbEffects.push({ originX: x, originY: y, targetX, targetY, r, g, b, timer: 0, duration: 0.6 })
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
        ? Math.sin(orbT * 12 + c * 1.5) * 15 * orbLife  // wave that fades near player
        : 0
      const wnx = perpLen > 1 ? perpX / perpLen : 0
      const wny = perpLen > 1 ? perpY / perpLen : 0

      const orbX = sx1 + ddx * orbEase + wnx * wave
      const orbY = sy1 + ddy * orbEase + wny * wave
      const orbSize = (13 - c * 1.4) * orbLife

      // Glow
      ctx.beginPath()
      ctx.arc(orbX, orbY, orbSize + 10, 0, Math.PI * 2)
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
          const nextWave = Math.sin(nextT * 12 + (c + 1) * 1.5) * 15 * (1 - nextT)
          const nextX = sx1 + ddx * nextEase + wnx * nextWave
          const nextY = sy1 + ddy * nextEase + wny * nextWave
          ctx.beginPath()
          ctx.moveTo(orbX, orbY)
          ctx.lineTo(nextX, nextY)
          ctx.strokeStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${orbLife * 0.2})`
          ctx.lineWidth = 3 * orbLife
          ctx.stroke()
        }
      }
    }
    ctx.lineCap = 'butt'
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
      const pulseR = 10 + pulseT * 40
      const pulseAlpha = (1 - pulseT) * (1 - pulseT) * 0.4
      ctx.beginPath()
      ctx.arc(sx2, sy2, pulseR, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(${fx.r}, ${fx.g}, ${fx.b}, ${pulseAlpha})`
      ctx.lineWidth = 2 * (1 - pulseT)
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
      duration: 0.4 + i * 0.1,
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
    const lw = 6 * (1 - t)

    // Single combined stroke
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rip.r}, ${rip.g}, ${rip.b}, ${alpha * 0.2})`
    ctx.lineWidth = lw
    ctx.stroke()
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
    const vx = Math.cos(angle) * speed * (0.5 + Math.random())
    const vy = Math.sin(angle) * speed * (0.5 + Math.random())
    spawnParticle(px, py, vx, vy, ri, gi, bi, lifetime * (0.5 + Math.random() * 0.5), size)
  }
}

function updateParticles(dt: number): void {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]!
    p.life += dt / p.lifetime
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.vx *= 0.96
    p.vy *= 0.96
    if (p.life >= 1) {
      particles[i] = particles[particles.length - 1]!
      particles.pop()
    }
  }
}

function drawParticles(): void {
  for (const p of particles) {
    const t = 1 - p.life
    const alpha = t * t  // ease-out: stays visible longer, fades smoothly at end
    const sx = p.x - camX
    const sy = p.y - camY
    ctx.fillStyle = `rgba(${p.r}, ${p.g}, ${p.b}, ${alpha})`
    ctx.fillRect(sx - p.size / 2, sy - p.size / 2, p.size, p.size)
  }
}

export function init(c: HTMLCanvasElement): void {
  canvas = c
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Could not get 2d context')
  ctx = context
  resize()
  window.addEventListener('resize', resize)
}

function resize(): void {
  width = window.innerWidth
  height = window.innerHeight
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
  borderWaveIntensity = 0
  playerGlowIntensity = 0
  outerPulseIntensity = 0
  dashSweepIntensity = 0
}

export function render(player: Player, enemies: Enemy[], _alpha: number, fps = 0, dt = 0.016, cam?: Camera): void {
  perfStart('R_TOTAL')
  lastDt = dt
  if (cam) {
    camX = cam.x - width / 2
    camY = cam.y - height / 2
  } else {
    camX = player.x - width / 2
    camY = player.y - height / 2
  }

  updateParticles(dt)

  ctx.fillStyle = '#0D0A1A'
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
        drawRing(enemy.x, enemy.y, rs.ring, rs.attackTimer, undefined, rs.expandTime, arcs)
      }
    }
  }
  perfEnd('e_rings')

  perfStart('e_bodies')
  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    drawEnemy(enemy, player)
  }
  perfEnd('e_bodies')

  // Dash sweep band — snap on at explosion, smooth fade out
  {
    const pastPeak = player.attackTimer - ATTACK_EXPAND_TIME
    if (player.dashTimer >= 0 && pastPeak >= 0 && pastPeak < 0.03) {
      // Snap: capture sweep state at explosion
      dashSweepIntensity = 1
      // Match the 30% cap from HitDetection
      const capT = 0.55
      dashSweepStartX = player.dashStartX + (player.x - player.dashStartX) * capT
      dashSweepStartY = player.dashStartY + (player.y - player.dashStartY) * capT
      dashSweepEndX = player.x
      dashSweepEndY = player.y
      dashSweepRadius = getEffectiveRadius(player) * getRingExpansion(player.attackTimer)
    } else {
      dashSweepIntensity *= 0.92
      if (dashSweepIntensity < 0.005) dashSweepIntensity = 0
    }

    if (dashSweepIntensity > 0.005) {
      const fade = dashSweepIntensity
      const grace = 8
      const fillSteps = 20
      for (let s = 0; s < fillSteps; s++) {
        const t = s / fillSteps
        const sx = dashSweepStartX + (dashSweepEndX - dashSweepStartX) * t - camX
        const sy = dashSweepStartY + (dashSweepEndY - dashSweepStartY) * t - camY
        ctx.beginPath()
        ctx.arc(sx, sy, dashSweepRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(255, 80, 80, ${0.06 * fade})`
        ctx.lineWidth = grace * 2
        ctx.stroke()
      }
      for (const edgeR of [dashSweepRadius + grace, Math.max(0, dashSweepRadius - grace)]) {
        ctx.beginPath()
        for (let s = 0; s <= fillSteps; s++) {
          const t = s / fillSteps
          const sx = dashSweepStartX + (dashSweepEndX - dashSweepStartX) * t - camX
          const sy = dashSweepStartY + (dashSweepEndY - dashSweepStartY) * t - camY
          ctx.moveTo(sx + edgeR, sy)
          ctx.arc(sx, sy, edgeR, 0, Math.PI * 2)
        }
        ctx.strokeStyle = `rgba(255, 80, 80, ${0.25 * fade})`
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
  }

  perfStart('p_ring')
  drawRing(player.x, player.y, player.ring, player.attackTimer, getEffectiveRadius(player))

  // Extra rings from upgrades
  for (let i = 0; i < player.extraRingCount; i++) {
    drawRing(player.x, player.y, player.ring, player.extraRingTimers[i]!, getEffectiveRadius(player))
  }
  perfEnd('p_ring')

  perfStart('orbs')
  drawXPOrbs(player)
  perfEnd('orbs')

  perfStart('particles')
  drawParticles()
  perfEnd('particles')

  ctx.restore()

  perfStart('player')
  drawPlayer(player)
  perfEnd('player')

  updateAndDrawSpawnEffects(lastDt)
  updateAndDrawAbsorbEffects(lastDt, player)

  drawDesignerPreview(player)
  drawSpawnPanel()
  drawHUD(player, enemies, fps)
  perfEnd('R_TOTAL')
  perfFlush()

  // Perf overlay — below HUD info
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

function drawGrid(player: Player): void {
  const cellSize = GRID_CELL_PX

  // Radial floor gradient — subtle darkening toward arena edges
  const arenaCx = ARENA_CX - camX
  const arenaCy = ARENA_CY - camY
  const gradR = getArenaShape() === 'circle' ? ARENA_RADIUS * 0.7 : Math.max(ARENA_W, ARENA_H) * 0.6
  const floorGrad = ctx.createRadialGradient(arenaCx, arenaCy, 0, arenaCx, arenaCy, gradR)
  floorGrad.addColorStop(0, 'rgba(20, 16, 40, 0.15)')
  floorGrad.addColorStop(1, 'rgba(0, 0, 0, 0.25)')
  ctx.fillStyle = floorGrad
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
  const expansion = getRingExpansion(attackTimer)
  const currentRadius = baseRadius * expansion
  if (currentRadius < 1) return

  const [r, g, b] = ring.color
  const ri = Math.floor(r * 255)
  const gi = Math.floor(g * 255)
  const bi = Math.floor(b * 255)

  const buildup = Math.min(attackTimer / expandTime, 1)
  const alpha = getRingAlpha(attackTimer, 0.12 + 0.68 * buildup * buildup)
  const lineW = 1.5 + 2.5 * buildup
  // Red ring visible from peak for a short fade-out
  const pastPeak = attackTimer - expandTime
  const showRedRing = pastPeak >= 0 && pastPeak < 0.11

  // Trail particles — reduced count to leave room for explosions
  if (buildup > 0.3) {
    const trailCount = Math.floor(buildup * 2)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, trailCount, 20 + buildup * 40, 0.3, 2, blockedArcs)
  }

  // Explosion at peak — count scales with ring size for even distribution
  if (showRedRing && pastPeak < lastDt * 2 && particles.length < MAX_PARTICLES - 20) {
    const ringScale = Math.max(1, currentRadius / 140)  // 140 = baseline ring radius
    const whiteCount = Math.round(15 * ringScale)
    const colorCount = Math.round(10 * ringScale)
    spawnRingParticles(worldX, worldY, currentRadius, 255, 255, 255, whiteCount, 20, 0.5, 8, blockedArcs)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, colorCount, 15, 0.6, 7, blockedArcs)
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
    const redAlpha = 0.8 * (1 - pastPeak / 0.11)
    // Soft red glow
    ctx.strokeStyle = `rgba(255, 100, 100, ${redAlpha * 0.15})`
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

    // Edge stroke
    ctx.strokeStyle = ringOver ? '#FFFFFF' : `rgba(${orbR}, ${orbG}, ${orbB}, ${isDouble ? 0.6 : 0.4})`
    ctx.lineWidth = isDouble ? 1.5 : 1
    ctx.stroke()
  }
}

function drawPlayer(player: Player): void {
  const sx = player.x - camX
  const sy = player.y - camY

  // Glow aura — soft radial gradient behind player, pulses on beat
  {
    // Gradual buildup following ring expansion, smooth fast decay after
    if (player.attackTimer >= 0) {
      const buildup = Math.min(player.attackTimer / ATTACK_EXPAND_TIME, 1)
      const target = buildup * buildup * 0.5  // ease-in, gradual
      if (target > playerGlowIntensity) playerGlowIntensity = target
    } else {
      playerGlowIntensity *= 0.9  // smooth decay
      if (playerGlowIntensity < 0.005) playerGlowIntensity = 0
    }
    const beatPulse = playerGlowIntensity
    const glowRadius = PLAYER_RADIUS * (2.5 + beatPulse * 0.8)
    const glowAlpha = 0.18 + beatPulse * 0.22
    const grad = ctx.createRadialGradient(sx, sy, PLAYER_RADIUS * 0.3, sx, sy, glowRadius)
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
  for (let i = 0; i < player.trail.length; i++) {
    const t = player.trail[i]!
    const tx = t.x - camX
    const ty = t.y - camY
    const alpha = (i / player.trail.length) * 0.12
    ctx.beginPath()
    ctx.arc(tx, ty, PLAYER_RADIUS * (0.5 + 0.5 * i / player.trail.length), 0, Math.PI * 2)
    ctx.fillStyle = `rgba(79, 195, 247, ${alpha})`
    ctx.fill()
  }
  ctx.restore()

  // Ghost dash — semi-transparent + white shimmer
  const isGhostDashing = player.dashTimer >= 0 && hasBonus('ghostDash')
  if (isGhostDashing) {
    ctx.globalAlpha = 0.4 + Math.sin(performance.now() / 50) * 0.15
  }

  // Hit shrink + color fade
  let drawRadius = PLAYER_RADIUS
  let fillColor = isGhostDashing ? 'rgba(255, 255, 255, 0.2)' : 'rgba(79, 195, 247, 0.15)'
  let strokeColor = isGhostDashing ? '#FFFFFF' : COLOR_PLAYER
  if (player.hitFlash > 0) {
    const t = player.hitFlash / HIT_FLASH_DURATION // 1 = just hit, 0 = recovered
    drawRadius = PLAYER_RADIUS * (0.7 + 0.3 * (1 - t)) // shrinks to 70% then bounces back
    fillColor = `rgba(255, ${Math.floor(30 + 225 * (1 - t))}, ${Math.floor(30 + 217 * (1 - t))}, ${0.2 + 0.5 * t})`
    strokeColor = `rgb(255, ${Math.floor(30 + 225 * (1 - t))}, ${Math.floor(30 + 217 * (1 - t))})`
  }

  // Dash trail — interpolate from current pos back to dash start
  if (player.dashTimer >= 0) {
    const dsx = player.dashStartX - camX
    const dsy = player.dashStartY - camY
    for (let i = 1; i <= 9; i++) {
      const t = i / 6  // 0→1 from player toward dash start
      const trailAlpha = (player.dashTimer / 0.5) * (1 - i * 0.1)
      if (trailAlpha <= 0) continue
      const trailX = sx + (dsx - sx) * t
      const trailY = sy + (dsy - sy) * t
      ctx.beginPath()
      ctx.arc(trailX, trailY, PLAYER_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(79, 195, 247, ${0.1 * trailAlpha})`
      ctx.fill()
      ctx.strokeStyle = `rgba(79, 195, 247, ${0.2 * trailAlpha})`
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }

  // Hit particles — red burst from pie edge on hit
  if (player.hitFlash > HIT_FLASH_DURATION - 0.02) {
    const dmgFraction = 1 / player.maxHp  // enemy.damage is always 1
    const intensity = Math.min(Math.max(dmgFraction / 0.002, 1), 4)
    const count = Math.floor(8 * intensity)
    const biteAngle = -Math.PI / 2 + (player.hp / player.maxHp) * Math.PI * 2
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * (0.6 + intensity * 0.15)
      const angle = biteAngle + spread
      const dist = drawRadius * (0.5 + Math.random() * 0.5)
      const px = player.x + Math.cos(angle) * dist
      const py = player.y + Math.sin(angle) * dist
      const speed = (30 + Math.random() * 50) * (0.8 + intensity * 0.2)
      const size = (2.5 + Math.random() * 2.5) * (0.8 + intensity * 0.2)
      spawnParticle(px, py, Math.cos(angle) * speed, Math.sin(angle) * speed,
        255, 80 + Math.floor(Math.random() * 50), 70, 0.4 + Math.random() * 0.3, size)
    }
  }

  // HP pie chart
  const hpFraction = player.displayHp / player.maxHp
  const actualPlayerHp = player.hp / player.maxHp
  const hpStart = -Math.PI / 2
  const hpEnd = hpStart + hpFraction * Math.PI * 2

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

    // Main HP fill
    const mainEnd = hpStart + actualPlayerHp * Math.PI * 2
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, drawRadius, hpStart, mainEnd)
    ctx.closePath()
    ctx.fillStyle = fillColor
    ctx.fill()
  }

  ctx.beginPath()
  ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 2.5
  ctx.stroke()

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

  // Green dash particles — trail behind during entire dash
  if (player.dashTimer >= 0 && player.dashTimer > 0) {
    for (let i = 0; i < 2; i++) {
      const a = Math.random() * Math.PI * 2
      const px = player.x + Math.cos(a) * orbitR * (0.5 + Math.random() * 0.5)
      const py = player.y + Math.sin(a) * orbitR * (0.5 + Math.random() * 0.5)
      spawnParticle(px, py,
        -player.dashDirX * 30 + (Math.random() - 0.5) * 20,
        -player.dashDirY * 30 + (Math.random() - 0.5) * 20,
        100, 255, 120, 0.4, 2.5)
    }
  }

  // Cyan dash trail burst
  if (player.dashTimer >= 0 && player.dashTimer > 0.48) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2
      const px = player.x + Math.cos(a) * orbitR
      const py = player.y + Math.sin(a) * orbitR
      const speed = 60 + Math.random() * 80
      spawnParticle(px, py, Math.cos(a) * speed, Math.sin(a) * speed, 79, 195, 247, 0.3, 2.5)
    }
  }

  // Beat indicator
  const beatGlow = player.ring.phase > 0.8 ? (player.ring.phase - 0.8) / 0.2 : 0
  if (beatGlow > 0) {
    ctx.beginPath()
    ctx.arc(sx, sy + PLAYER_RADIUS + 10, 3, 0, Math.PI * 2)
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
    const jitterStrength = 4 * (enemy.hitFlash / HIT_FLASH_DURATION)
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
        const dist = r * (0.5 + Math.random() * 0.5)
        const px = enemy.x + Math.cos(angle) * dist
        const py = enemy.y + Math.sin(angle) * dist
        const speed = 40 + Math.random() * 70
        spawnParticle(px, py, Math.cos(angle) * speed, Math.sin(angle) * speed,
          255, 80 + Math.floor(Math.random() * 50), 70, 0.4 + Math.random() * 0.3, 4 + Math.random() * 2.5)
      }
    }

    if (dt < deathDur) {
      const count = t < 0.1 ? 15 : 4
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = Math.random() * r
        const px = enemy.x + Math.cos(angle) * dist
        const py = enemy.y + Math.sin(angle) * dist
        const speed = 30 + Math.random() * 80
        const vx = Math.cos(angle) * speed + (Math.random() - 0.5) * 40
        const vy = Math.sin(angle) * speed + (Math.random() - 0.5) * 40 - 20
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
  const ringOverEnemy = playerRadius > 0 && Math.abs(distToPlayer - playerRadius) < r

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

  // Hit particles — burst from the pie edge, intensity scales with damage fraction
  if (enemy.hitFlash > HIT_FLASH_DURATION - 0.02) {
    const hitFraction = damageFraction  // fraction of maxHp dealt
    const intensity = Math.min(Math.max(hitFraction / 0.20, 1), 4)  // 1x at <=20%, up to 4x at 80%+
    const count = Math.floor(8 * intensity)
    // Only the fresh bite — from actual HP to where displayHp is (the red drain wedge)
    const damageArcStart = startAngle + (enemy.hp / enemy.maxHp) * Math.PI * 2
    const damageArcEnd = damageArcStart + damageFraction * Math.PI * 2
    const arcSpan = damageArcEnd - damageArcStart
    for (let i = 0; i < count; i++) {
      const angle = damageArcStart + Math.random() * arcSpan
      const dist = Math.random() * r
      const px = enemy.x + Math.cos(angle) * dist
      const py = enemy.y + Math.sin(angle) * dist
      const speed = (60 + Math.random() * 120) * (0.8 + intensity * 0.2)
      const outAngle = Math.atan2(py - enemy.y, px - enemy.x)
      const vx = Math.cos(outAngle) * speed
      const vy = Math.sin(outAngle) * speed
      const size = (2.5 + Math.random() * 2.5) * (0.8 + intensity * 0.2)
      spawnParticle(px, py, vx, vy, 255, 80 + Math.floor(Math.random() * 50), 70, 0.4 + Math.random() * 0.3, size)
    }
    // Blood spray from center — enemy colored
    const sprayCount = Math.floor(4 * intensity)
    for (let i = 0; i < sprayCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 40 + Math.random() * 100 * intensity
      const sizeScale = r / 44
      const size = (1.9 + Math.random() * 2.5) * (0.8 + intensity * 0.2) * sizeScale
      spawnParticle(enemy.x, enemy.y,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        230 + Math.floor(Math.random() * 25), 40 + Math.floor(Math.random() * 40), 40, 0.4 + Math.random() * 0.3, size)
    }
  }

  // HP display
  const actualHpFraction = enemy.hp / enemy.maxHp

  if (isTotem && hpFraction > 0) {
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

    const mainEnd = startAngle + actualHpFraction * Math.PI * 2
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
    // Normal enemy: crisp thin edge
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.strokeStyle = ringOverEnemy ? '#FFFFFF' : enemy.color
    ctx.lineWidth = 1.5
    ctx.stroke()
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

  // Immovable indicator — corner brackets
  if (enemy.immovable && r > 5) {
    const scale = r / 44
    const br = r + 6 * scale
    const bLen = r * 0.3
    ctx.strokeStyle = `rgba(255, 255, 255, 0.55)`
    ctx.lineWidth = 6 * scale
    ctx.lineCap = 'round'
    // 4 corners at 45°, 135°, 225°, 315°
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2
      const cx = sx + Math.cos(a) * br
      const cy = sy + Math.sin(a) * br
      // Two arms of the L-bracket, perpendicular to the diagonal
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
    if (pr.attackTimer >= 0) {
      const expansion = getRingExpansion(pr.attackTimer)
      const currentRadius = pr.ringRadius * expansion
      if (currentRadius > 1) {
        const pExpandTime = pr.expandTime
        const buildup = Math.min(pr.attackTimer / pExpandTime, 1)
        const alpha = getRingAlpha(pr.attackTimer, 0.3 + 0.5 * buildup)

        ctx.beginPath()
        ctx.arc(sx, sy, currentRadius, 0, Math.PI * 2)
        ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, ${alpha})`
        ctx.lineWidth = 2 + 4 * buildup
        ctx.stroke()
      }
    }

    // Max ring range — dashed
    ctx.beginPath()
    ctx.arc(sx, sy, pr.ringRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.1)`
    ctx.lineWidth = 1
    ctx.setLineDash([4, 6])
    ctx.stroke()
    ctx.setLineDash([])
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

  // Labels
  ctx.fillStyle = preview.color
  ctx.font = '11px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('PREVIEW', sx, sy - preview.radius - (preview.immovable ? 16 : 8))
  ctx.fillText(preview.name, sx, sy + preview.radius + 14)
  ctx.textAlign = 'left'
  ctx.globalAlpha = 1
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

function drawHUD(player: Player, enemies: Enemy[], fps: number): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
  ctx.font = '12px monospace'
  const x = width - 200
  const pat = getPattern()
  const loopPos = getLoopPosition()
  const loopLen = getLoopLength()
  ctx.fillText(`FPS: ${fps}`, x, 20)
  ctx.fillText(`HP: ${player.hp}/${player.maxHp}`, x, 36)
  ctx.fillText(`Enemies: ${enemies.filter(e => e.alive).length}`, x, 52)
  ctx.fillText(`XP: ${player.xp}`, x, 68)
  ctx.fillText(`Beat: ${getBeatName()} | Song: ${pat?.name ?? 'none'} [${loopPos.toFixed(1)}/${loopLen}]`, x - 80, 84)
  ctx.fillText(`WASD=move  LMB=dash  Tab=designer  F1-F11=beats`, 10, height - 12)
  ctx.fillText(`1-5=spawn  0=spawn 100`, 10, height - 28)
}

export function getScreenWidth(): number { return width }
export function getScreenHeight(): number { return height }

import type { Player } from '../entities/Player.ts'
import { getEffectiveRadius } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import type { Ring } from '../entities/Ring.ts'
import { getRingExpansion, getRingAlpha, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import { getPattern, getLoopPosition, getLoopLength } from '../audio/PatternClock.ts'
import { getPreviewEnemy } from '../game/EnemyDesigner.ts'
import type { Camera } from '../game/Arena.ts'
import { ARENA_W, ARENA_H } from '../game/Arena.ts'
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

function spawnDeathRipples(x: number, y: number, radius: number, color: string): void {
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  for (let i = 0; i < 3; i++) {
    deathRipples.push({
      x, y, r, g, b,
      startRadius: radius,
      maxRadius: radius * (5.5 + i * 2),
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
      deathRipples.splice(i, 1)
      continue
    }
    const t = elapsed / rip.duration
    const eased = 1 - (1 - t) * (1 - t)  // ease-out
    const radius = rip.startRadius + (rip.maxRadius - rip.startRadius) * eased
    const alpha = (1 - t) * (1 - t)  // fade out
    const sx = rip.x - camX
    const sy = rip.y - camY

    // Soft radial glow behind the ring
    const glowWidth = 12 * (1 - t)
    const glowGrad = ctx.createRadialGradient(sx, sy, Math.max(0, radius - glowWidth), sx, sy, radius + glowWidth)
    glowGrad.addColorStop(0, `rgba(${rip.r}, ${rip.g}, ${rip.b}, 0)`)
    glowGrad.addColorStop(0.4, `rgba(${rip.r}, ${rip.g}, ${rip.b}, ${alpha * 0.007})`)
    glowGrad.addColorStop(0.6, `rgba(${rip.r}, ${rip.g}, ${rip.b}, ${alpha * 0.007})`)
    glowGrad.addColorStop(1, `rgba(${rip.r}, ${rip.g}, ${rip.b}, 0)`)
    ctx.beginPath()
    ctx.arc(sx, sy, radius + glowWidth, 0, Math.PI * 2)
    ctx.fillStyle = glowGrad
    ctx.fill()

    // Outer stroke
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rip.r}, ${rip.g}, ${rip.b}, ${alpha * 0.035})`
    ctx.lineWidth = 6 * (1 - t)
    ctx.stroke()

    // Core ring
    ctx.beginPath()
    ctx.arc(sx, sy, radius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rip.r}, ${rip.g}, ${rip.b}, ${alpha * 0.1})`
    ctx.lineWidth = 2 * (1 - t)
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
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2
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
    const alpha = 1 - p.life
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

export function render(player: Player, enemies: Enemy[], _alpha: number, fps = 0, dt = 0.016, cam?: Camera): void {
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

  drawGrid(player)
  drawArenaBorder(player)
  updateAndDrawDeathRipples(lastDt)

  // Clip rings and particles to arena bounds
  ctx.save()
  ctx.beginPath()
  ctx.rect(-camX, -camY, ARENA_W, ARENA_H)
  ctx.clip()

  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    if (!enemy.dying) {
      for (const rs of enemy.rings) {
        const ringRadius = rs.ring.radius * getRingExpansion(rs.attackTimer)
        const arcs = ringRadius > 1 ? getBlockedArcs(enemy.x, enemy.y, ringRadius, getEnemies(), enemy) : []
        drawRing(enemy.x, enemy.y, rs.ring, rs.attackTimer, undefined, rs.expandTime, arcs)
      }
    }
    drawEnemy(enemy, player)
  }

  // Dash sweep band — snap on at explosion, smooth fade out
  {
    const pastPeak = player.attackTimer - ATTACK_EXPAND_TIME
    if (player.dashTimer >= 0 && pastPeak >= 0 && pastPeak < 0.03) {
      // Snap: capture sweep state at explosion
      dashSweepIntensity = 1
      dashSweepStartX = player.dashStartX
      dashSweepStartY = player.dashStartY
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
        ctx.strokeStyle = `rgba(255, 80, 80, ${0.04 * fade})`
        ctx.lineWidth = grace * 2
        ctx.stroke()
      }
      for (const edgeR of [dashSweepRadius + grace, Math.max(0, dashSweepRadius - grace)]) {
        ctx.beginPath()
        for (let s = 0; s <= fillSteps; s++) {
          const t = s / fillSteps
          const sx = dashSweepStartX + (dashSweepEndX - dashSweepStartX) * t - camX
          const sy = dashSweepStartY + (dashSweepEndY - dashSweepStartY) * t - camY
          if (s === 0) ctx.moveTo(sx + edgeR, sy)
          ctx.arc(sx, sy, edgeR, 0, Math.PI * 2)
        }
        ctx.strokeStyle = `rgba(255, 80, 80, ${0.18 * fade})`
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
  }

  drawRing(player.x, player.y, player.ring, player.attackTimer, getEffectiveRadius(player))

  // Extra rings from upgrades
  for (let i = 0; i < player.extraRingCount; i++) {
    drawRing(player.x, player.y, player.ring, player.extraRingTimers[i]!, getEffectiveRadius(player))
  }

  drawXPOrbs(player)
  drawParticles()

  ctx.restore()
  drawPlayer(player)
  drawDesignerPreview(player)
  drawSpawnPanel()
  drawHUD(player, enemies, fps)
}

function drawGrid(player: Player): void {
  const cellSize = GRID_CELL_PX

  // Radial floor gradient — subtle darkening toward arena edges
  const arenaCx = ARENA_W / 2 - camX
  const arenaCy = ARENA_H / 2 - camY
  const floorGrad = ctx.createRadialGradient(arenaCx, arenaCy, 0, arenaCx, arenaCy, Math.max(ARENA_W, ARENA_H) * 0.6)
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

  // Dark buffer — gradient edges that make the arena pop
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

  // Arena border — layered glow with beat pulse
  ctx.strokeStyle = `rgba(79, 195, 247, ${0.03 + beatPulse * 0.04})`
  ctx.lineWidth = 30
  ctx.strokeRect(x - 10, y - 10, w + 20, h + 20)

  ctx.strokeStyle = `rgba(79, 195, 247, ${0.06 + beatPulse * 0.06})`
  ctx.lineWidth = 18
  ctx.strokeRect(x - 4, y - 4, w + 8, h + 8)

  ctx.strokeStyle = `rgba(79, 195, 247, ${0.12 + beatPulse * 0.1})`
  ctx.lineWidth = 8
  ctx.strokeRect(x, y, w, h)

  ctx.strokeStyle = `rgba(79, 195, 247, ${0.4 + beatPulse * 0.25})`
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, w, h)

  // Waveform line — spikes on beat, flattens out smoothly
  if (borderWaveIntensity > 0.005) {
    const baseAmp = borderWaveIntensity * 11
    const freq = 0.25
    const alpha = Math.min(borderWaveIntensity * 1.5, 0.85)
    const step = 5
    const t = performance.now() * 0.005

    // White→cyan color blend: white at peak, fades to cyan
    const whiteBlend = Math.min(borderWaveIntensity * 0.6, 0.4)  // subtle white shift at peak
    const cr = Math.floor(79 + (255 - 79) * whiteBlend)
    const cg = Math.floor(195 + (255 - 195) * whiteBlend)
    const cb = Math.floor(247 + (255 - 247) * whiteBlend)

    // Line thickness pulse: thick at impact, thins as it decays
    const coreWidth = 1 + borderWaveIntensity * 2
    const midWidth = 3 + borderWaveIntensity * 3
    const outerWidth = 6 + borderWaveIntensity * 6

    // Player position relative to arena for proximity-based amplitude
    const px = player.x
    const py = player.y

    const vary = (i: number, seed: number) => {
      const h = Math.sin(i * 0.73 + seed * 3.17) * 0.5 + 0.5
      return 0.3 + h * 0.7
    }

    // Proximity multiplier: stronger near player, weaker far side
    const proximityH = (posX: number, edgeY: number) => {
      const dx = posX - px
      const dy = edgeY - py
      const dist = Math.sqrt(dx * dx + dy * dy)
      const maxDist = Math.sqrt(ARENA_W * ARENA_W + ARENA_H * ARENA_H)
      return 0.3 + 0.7 * (1 - dist / maxDist)
    }

    const proximityV = (edgeX: number, posY: number) => {
      const dx = edgeX - px
      const dy = posY - py
      const dist = Math.sqrt(dx * dx + dy * dy)
      const maxDist = Math.sqrt(ARENA_W * ARENA_W + ARENA_H * ARENA_H)
      return 0.3 + 0.7 * (1 - dist / maxDist)
    }

    const drawWaveH = (startX: number, baseY: number, len: number, seed: number) => {
      ctx.beginPath()
      const p0 = proximityH(startX, baseY)
      const w0 = Math.sin(0 * freq + t + seed) * baseAmp * p0 * vary(0, seed)
      ctx.moveTo(startX, baseY + w0)
      for (let i = step; i <= len; i += step) {
        const prox = proximityH(startX + i, baseY)
        const wave = Math.sin(i * freq + t + seed) * baseAmp * prox * vary(i, seed)
        const prevProx = proximityH(startX + i - step, baseY)
        const prevWave = Math.sin((i - step) * freq + t + seed) * baseAmp * prevProx * vary(i - step, seed)
        const cpx = startX + i - step * 0.5
        const cpy = baseY + (prevWave + wave) * 0.5
        ctx.quadraticCurveTo(startX + i - step, baseY + prevWave, cpx, cpy)
      }
      ctx.stroke()
    }

    const drawWaveV = (baseX: number, startY: number, len: number, seed: number) => {
      ctx.beginPath()
      const p0 = proximityV(baseX, startY)
      const w0 = Math.sin(0 * freq + t + seed) * baseAmp * p0 * vary(0, seed)
      ctx.moveTo(baseX + w0, startY)
      for (let i = step; i <= len; i += step) {
        const prox = proximityV(baseX, startY + i)
        const wave = Math.sin(i * freq + t + seed) * baseAmp * prox * vary(i, seed)
        const prevProx = proximityV(baseX, startY + i - step)
        const prevWave = Math.sin((i - step) * freq + t + seed) * baseAmp * prevProx * vary(i - step, seed)
        const cpx = baseX + (prevWave + wave) * 0.5
        const cpy = startY + i - step * 0.5
        ctx.quadraticCurveTo(baseX + prevWave, startY + i - step, cpx, cpy)
      }
      ctx.stroke()
    }

    // Outer glow pass
    ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha * 0.15})`
    ctx.lineWidth = outerWidth
    drawWaveH(x, y, w, 0)
    drawWaveH(x, y + h, w, 2)
    drawWaveV(x, y, h, 4)
    drawWaveV(x + w, y, h, 6)

    // Mid glow pass
    ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha * 0.35})`
    ctx.lineWidth = midWidth
    drawWaveH(x, y, w, 0)
    drawWaveH(x, y + h, w, 2)
    drawWaveV(x, y, h, 4)
    drawWaveV(x + w, y, h, 6)

    // Sharp core
    ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`
    ctx.lineWidth = coreWidth
    drawWaveH(x, y, w, 0)
    drawWaveH(x, y + h, w, 2)
    drawWaveV(x, y, h, 4)
    drawWaveV(x + w, y, h, 6)
  }

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
    const cx = x + w / 2
    const cy = y + h / 2
    const innerR = Math.min(w, h) / 2
    const outerR = Math.max(width, height)

    ctx.save()
    // Clip to outside arena only — draw screen rect, cut out arena
    ctx.beginPath()
    ctx.rect(0, 0, width, height)
    ctx.rect(x + w, y, -w, h)  // counter-clockwise = cut out
    ctx.clip('evenodd')

    const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR)
    grad.addColorStop(0, `rgba(79, 195, 247, ${pulseAlpha})`)
    grad.addColorStop(0.4, `rgba(79, 195, 247, ${pulseAlpha * 0.4})`)
    grad.addColorStop(1, 'rgba(79, 195, 247, 0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }
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

  // Trail particles
  if (buildup > 0.2) {
    const trailCount = Math.floor(buildup * 3)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, trailCount, 20 + buildup * 40, 0.3, 2, blockedArcs)
  }

  // Explosion at peak
  if (showRedRing && pastPeak < lastDt * 2) {
    spawnRingParticles(worldX, worldY, currentRadius, 255, 255, 255, 40, 40, 0.5, 5, blockedArcs)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, 30, 25, 0.6, 3.6, blockedArcs)
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

    // Death animation — dissolve like enemies
    if (orb.dying) {
      const t = Math.min(orb.deathTimer / 0.2, 1)
      const r = orb.baseRadius * (1 - t * 0.5)

      // Spawn particles + ripple on first frame
      if (orb.deathTimer < 0.02) {
        spawnRingParticles(orb.x, orb.y, r * 0.5, 100, 255, 200, 10, 80, 0.3, 3)
        spawnRingParticles(orb.x, orb.y, r * 0.3, 255, 255, 255, 6, 50, 0.2, 2)
        // Mini ripple — same color as orb
        const orbColor = orb.value >= 2 ? '#64D732' : '#64FFc8'
        spawnDeathRipples(orb.x, orb.y, r * 1.5, orbColor)
      }

      ctx.globalAlpha = (1 - t) * (1 - t)
      ctx.beginPath()
      ctx.arc(sx, sy, r, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(100, 255, 200, 0.5)'
      ctx.fill()
      ctx.globalAlpha = 1
      continue
    }

    const r = orb.radius

    // Check if player ring is over this orb
    const distToPlayer = Math.sqrt((orb.x - player.x) ** 2 + (orb.y - player.y) ** 2)
    const ringOver = playerRadius > 0 && Math.abs(distToPlayer - playerRadius) < r

    // Double XP orbs are gold, normal are teal
    const isDouble = orb.value >= 2
    const orbR = isDouble ? 100 : 100
    const orbG = isDouble ? 215 : 255
    const orbB = isDouble ? 50 : 200

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

  // Movement trail
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
    drawRadius = PLAYER_RADIUS * (0.85 + 0.15 * (1 - t)) // shrinks to 90% then bounces back
    fillColor = `rgba(${Math.floor(255 - 176 * (1 - t))}, ${Math.floor(50 + 145 * (1 - t))}, ${Math.floor(50 + 197 * (1 - t))}, ${0.15 + 0.35 * t})`
    strokeColor = `rgb(${Math.floor(255 - 176 * (1 - t))}, ${Math.floor(50 + 145 * (1 - t))}, ${Math.floor(50 + 197 * (1 - t))})`
  }

  // Dash trail
  if (player.dashTimer >= 0) {
    for (let i = 1; i <= 6; i++) {
      const trailAlpha = (player.dashTimer / 0.5) * (1 - i * 0.14)
      if (trailAlpha <= 0) continue
      const trailX = sx - player.dashDirX * 20 * i
      const trailY = sy - player.dashDirY * 20 * i
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
    const count = Math.floor(12 * intensity)
    const biteAngle = -Math.PI / 2 + (player.hp / player.maxHp) * Math.PI * 2
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * (0.6 + intensity * 0.15)
      const angle = biteAngle + spread
      const dist = drawRadius * (0.5 + Math.random() * 0.5)
      const px = player.x + Math.cos(angle) * dist
      const py = player.y + Math.sin(angle) * dist
      const speed = (30 + Math.random() * 50) * (0.8 + intensity * 0.2)
      const size = (2 + Math.random() * 2) * (0.8 + intensity * 0.2)
      spawnParticle(px, py, Math.cos(angle) * speed, Math.sin(angle) * speed,
        255, 60 + Math.floor(Math.random() * 40), 60, 0.3 + Math.random() * 0.2, size)
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
  const sx = enemy.x - camX
  const sy = enemy.y - camY
  let r = enemy.radius

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
      for (let i = 0; i < 16; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = r * (0.5 + Math.random() * 0.5)
        const px = enemy.x + Math.cos(angle) * dist
        const py = enemy.y + Math.sin(angle) * dist
        const speed = 40 + Math.random() * 70
        spawnParticle(px, py, Math.cos(angle) * speed, Math.sin(angle) * speed,
          255, 60 + Math.floor(Math.random() * 40), 60, 0.3 + Math.random() * 0.2, 3 + Math.random() * 2)
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

  const hpFraction = enemy.displayHp / enemy.maxHp
  const damageFraction = player.damage * player.modifiers.damageMult / enemy.maxHp
  const afterHitFraction = Math.max(0, hpFraction - damageFraction)
  const startAngle = -Math.PI / 2
  const endAngle = startAngle + hpFraction * Math.PI * 2
  const afterHitEnd = startAngle + afterHitFraction * Math.PI * 2

  // Damaged background — dark enemy color base + inner ring marks
  {
    const dr = Math.floor(hr * 0.15)
    const dg = Math.floor(hg * 0.15)
    const db = Math.floor(hb * 0.15)
    const bgGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
    bgGrad.addColorStop(0, `rgba(${dr}, ${dg}, ${db}, 0.5)`)
    bgGrad.addColorStop(0.6, `rgba(${Math.floor(dr * 0.5)}, ${Math.floor(dg * 0.5)}, ${Math.floor(db * 0.5)}, 0.45)`)
    bgGrad.addColorStop(1, 'rgba(0, 0, 0, 0.6)')
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = bgGrad
    ctx.fill()

    // Inner ring marks — concentric arcs for "internals" feel
    ctx.strokeStyle = `rgba(${hr}, ${hg}, ${hb}, 0.04)`
    ctx.lineWidth = 1
    for (let i = 1; i <= 3; i++) {
      const ringR = r * (i * 0.25)
      ctx.beginPath()
      ctx.arc(sx, sy, ringR, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  // Hit particles — burst from the pie edge, intensity scales with damage fraction
  if (enemy.hitFlash > HIT_FLASH_DURATION - 0.02) {
    const hitFraction = damageFraction  // fraction of maxHp dealt
    const intensity = Math.min(Math.max(hitFraction / 0.20, 1), 4)  // 1x at <=20%, up to 4x at 80%+
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
      const speed = (60 + Math.random() * 120) * (0.8 + intensity * 0.2)
      const outAngle = Math.atan2(py - enemy.y, px - enemy.x)
      const vx = Math.cos(outAngle) * speed
      const vy = Math.sin(outAngle) * speed
      const size = (2 + Math.random() * 2) * (0.8 + intensity * 0.2)
      spawnParticle(px, py, vx, vy, 255, 60 + Math.floor(Math.random() * 40), 60, 0.3 + Math.random() * 0.2, size)
    }
    // Blood spray from center — enemy colored
    const sprayCount = Math.floor(6 * intensity)
    for (let i = 0; i < sprayCount; i++) {
      const angle = Math.random() * Math.PI * 2
      const speed = 40 + Math.random() * 100 * intensity
      const sizeScale = r / 44  // scale relative to default enemy radius
      const size = (1.5 + Math.random() * 2) * (0.8 + intensity * 0.2) * sizeScale
      spawnParticle(enemy.x, enemy.y,
        Math.cos(angle) * speed, Math.sin(angle) * speed,
        200 + Math.floor(Math.random() * 55), 20 + Math.floor(Math.random() * 30), 20, 0.3 + Math.random() * 0.3, size)
    }
  }

  // HP pie wedge — radial gradient fill (bright center, dark edge)
  const actualHpFraction = enemy.hp / enemy.maxHp
  if (hpFraction > 0) {
    // Red draining wedge — the gap between displayHp (visual) and hp (actual)
    if (hpFraction > actualHpFraction) {
      const actualEnd = startAngle + actualHpFraction * Math.PI * 2
      const redGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r)
      redGrad.addColorStop(0, 'rgba(255, 70, 70, 0.55)')
      redGrad.addColorStop(0.7, 'rgba(255, 40, 40, 0.4)')
      redGrad.addColorStop(1, 'rgba(140, 20, 20, 0.3)')
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, r, actualEnd, endAngle)
      ctx.closePath()
      ctx.fillStyle = redGrad
      ctx.fill()
    }

    // Main HP fill
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

  // Outline — crisp thin edge
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  ctx.strokeStyle = ringOverEnemy ? '#FFFFFF' : enemy.color
  ctx.lineWidth = 1.5
  ctx.stroke()
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

  // Labels
  ctx.fillStyle = preview.color
  ctx.font = '11px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('PREVIEW', sx, sy - preview.radius - 8)
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

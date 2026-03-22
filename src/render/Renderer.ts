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

  drawGrid()
  drawArenaBorder()

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

  drawRing(player.x, player.y, player.ring, player.attackTimer, getEffectiveRadius(player))

  drawXPOrbs(player)
  drawParticles()

  ctx.restore()
  drawPlayer(player)
  drawDesignerPreview(player)
  drawSpawnPanel()
  drawHUD(player, enemies, fps)
}

function drawGrid(): void {
  const cellSize = GRID_CELL_PX
  ctx.strokeStyle = `rgba(26, 21, 53, ${GRID_ALPHA * 2.5})`
  ctx.lineWidth = 1
  const startX = Math.floor(camX / cellSize) * cellSize
  const startY = Math.floor(camY / cellSize) * cellSize
  ctx.beginPath()
  for (let x = startX; x < camX + width + cellSize; x += cellSize) {
    ctx.moveTo(x - camX, 0)
    ctx.lineTo(x - camX, height)
  }
  for (let y = startY; y < camY + height + cellSize; y += cellSize) {
    ctx.moveTo(0, y - camY)
    ctx.lineTo(width, y - camY)
  }
  ctx.stroke()
}

function drawArenaBorder(): void {
  const x = -camX
  const y = -camY
  const w = ARENA_W
  const h = ARENA_H
  const buffer = ARENA_BUFFER

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

  // Arena border — layered glow from soft outer to bright inner
  ctx.strokeStyle = 'rgba(79, 195, 247, 0.03)'
  ctx.lineWidth = 30
  ctx.strokeRect(x - 10, y - 10, w + 20, h + 20)

  ctx.strokeStyle = 'rgba(79, 195, 247, 0.06)'
  ctx.lineWidth = 18
  ctx.strokeRect(x - 4, y - 4, w + 8, h + 8)

  ctx.strokeStyle = 'rgba(79, 195, 247, 0.12)'
  ctx.lineWidth = 8
  ctx.strokeRect(x, y, w, h)

  ctx.strokeStyle = 'rgba(79, 195, 247, 0.4)'
  ctx.lineWidth = 2
  ctx.strokeRect(x, y, w, h)
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
  const alpha = getRingAlpha(attackTimer, 0.3 + 0.5 * buildup)
  const lineW = 2 + 4 * buildup
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

  // Main ring — draw with occlusion gaps if blocked
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${alpha})`
  ctx.lineWidth = lineW
  drawArcWithGaps(sx, sy, currentRadius, blockedArcs)

  // Red flash at peak
  if (showRedRing) {
    const redAlpha = 0.8 * (1 - pastPeak / 0.11)
    ctx.strokeStyle = `rgba(255, 80, 80, ${redAlpha})`
    ctx.lineWidth = 4
    drawArcWithGaps(sx, sy, currentRadius, blockedArcs)
    // Outer glow
    ctx.strokeStyle = `rgba(255, 120, 120, ${redAlpha * 0.4})`
    ctx.lineWidth = 10
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

      // Spawn particles on first frame
      if (orb.deathTimer < 0.02) {
        spawnRingParticles(orb.x, orb.y, r * 0.5, 100, 255, 200, 20, 120, 0.4, 4)
        spawnRingParticles(orb.x, orb.y, r * 0.3, 255, 255, 255, 12, 80, 0.3, 3)
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

    // Glow
    ctx.beginPath()
    ctx.arc(sx, sy, r + 4, 0, Math.PI * 2)
    ctx.fillStyle = ringOver ? 'rgba(255, 255, 255, 0.25)' : 'rgba(100, 255, 200, 0.12)'
    ctx.fill()

    // Orb body
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(100, 255, 200, 0.7)'
    ctx.fill()

    // White outline when ring is over
    if (ringOver) {
      ctx.strokeStyle = '#FFFFFF'
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }
}

function drawPlayer(player: Player): void {
  const sx = player.x - camX
  const sy = player.y - camY

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

  // Hit shrink + color fade
  let drawRadius = PLAYER_RADIUS
  let fillColor = 'rgba(79, 195, 247, 0.15)'
  let strokeColor = COLOR_PLAYER
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

  // HP pie chart
  const hpFraction = player.displayHp / player.maxHp
  const hpStart = -Math.PI / 2
  const hpEnd = hpStart + hpFraction * Math.PI * 2

  ctx.beginPath()
  ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.fill()

  if (hpFraction > 0) {
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, drawRadius, hpStart, hpEnd)
    ctx.closePath()
    ctx.fillStyle = fillColor
    ctx.fill()
  }

  ctx.beginPath()
  ctx.arc(sx, sy, drawRadius, 0, Math.PI * 2)
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 2.5
  ctx.stroke()

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

    const hr = parseInt(enemy.color.slice(1, 3), 16)
    const hg = parseInt(enemy.color.slice(3, 5), 16)
    const hb = parseInt(enemy.color.slice(5, 7), 16)

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
      ctx.globalAlpha = (1 - t) * (1 - t)
      ctx.beginPath()
      ctx.arc(sx, sy, r * (1 - t * 0.5), 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.3)`
      ctx.fill()
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

  const hr = parseInt(enemy.color.slice(1, 3), 16)
  const hg = parseInt(enemy.color.slice(3, 5), 16)
  const hb = parseInt(enemy.color.slice(5, 7), 16)

  const fillColor = `rgba(${hr}, ${hg}, ${hb}, 0.4)`
  const strokeColor = enemy.color

  const hpFraction = enemy.displayHp / enemy.maxHp
  const damageFraction = player.damage / enemy.maxHp
  const afterHitFraction = Math.max(0, hpFraction - damageFraction)
  const startAngle = -Math.PI / 2
  const endAngle = startAngle + hpFraction * Math.PI * 2
  const afterHitEnd = startAngle + afterHitFraction * Math.PI * 2

  // Dark background
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.fill()

  // HP pie wedge
  if (hpFraction > 0) {
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, r, startAngle, endAngle)
    ctx.closePath()
    ctx.fillStyle = fillColor
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

  // Outline
  ctx.beginPath()
  ctx.arc(sx, sy, r, 0, Math.PI * 2)
  ctx.strokeStyle = ringOverEnemy ? '#FFFFFF' : strokeColor
  ctx.lineWidth = 2.5
  ctx.stroke()

  // Type label
  ctx.fillStyle = enemy.color
  ctx.globalAlpha = 0.5
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.fillText(enemy.typeName, sx, sy + r + 12)
  ctx.textAlign = 'left'
  ctx.globalAlpha = 1.0
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

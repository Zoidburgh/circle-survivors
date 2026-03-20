import type { Player } from '../entities/Player.ts'
import { getEffectiveRadius } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import type { Ring } from '../entities/Ring.ts'
import { getRingExpansion, getRingAlpha, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import {
  GRID_ALPHA,
  GRID_CELL_PX,
  COLOR_PLAYER,
  PLAYER_RADIUS,
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
  life: number      // 0→1, dies at 1
  lifetime: number  // seconds
  size: number
}

const particles: Particle[] = []
const MAX_PARTICLES = 2000
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

/** Spawn particles along a ring edge */
function spawnRingParticles(
  cx: number, cy: number, radius: number,
  ri: number, gi: number, bi: number,
  count: number, speed: number, lifetime: number, size: number
): void {
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2
    const px = cx + Math.cos(angle) * radius
    const py = cy + Math.sin(angle) * radius
    // Particles fly outward from ring center
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
    // Slow down
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

export function render(player: Player, enemies: Enemy[], _alpha: number, fps = 0, dt = 0.016): void {
  lastDt = dt
  camX = player.x - width / 2
  camY = player.y - height / 2

  updateParticles(dt)

  ctx.fillStyle = '#0D0A1A'
  ctx.fillRect(0, 0, width, height)

  drawGrid()

  for (const enemy of enemies) {
    if (!enemy.alive && !enemy.dying) continue
    if (!enemy.dying) {
      drawRing(enemy.x, enemy.y, enemy.ring, enemy.attackTimer)
    }
    drawEnemy(enemy, player)
  }

  drawRing(player.x, player.y, player.ring, player.attackTimer, getEffectiveRadius(player))

  drawParticles()
  drawPlayer(player)
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

function drawRing(worldX: number, worldY: number, ring: Ring, attackTimer: number, radiusOverride?: number): void {
  if (attackTimer < 0) return // no active attack

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

  // Buildup is 0→1 during expand phase
  const buildup = Math.min(attackTimer / ATTACK_EXPAND_TIME, 1)
  const alpha = getRingAlpha(attackTimer, 0.3 + 0.5 * buildup)
  const lineW = 2 + 4 * buildup
  const atPeak = attackTimer >= ATTACK_EXPAND_TIME * 0.9 && attackTimer <= ATTACK_EXPAND_TIME * 1.1

  // Trail particles
  if (buildup > 0.2) {
    const trailCount = Math.floor(buildup * 3)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, trailCount, 20 + buildup * 40, 0.3, 2)
  }

  // Explosion at peak — tight to the ring edge
  if (atPeak && attackTimer - lastDt < ATTACK_EXPAND_TIME * 0.9) {
    spawnRingParticles(worldX, worldY, currentRadius, 255, 255, 255, 40, 40, 0.5, 4)
    spawnRingParticles(worldX, worldY, currentRadius, ri, gi, bi, 30, 25, 0.6, 3)
  }

  // Main ring
  ctx.beginPath()
  ctx.arc(sx, sy, currentRadius, 0, Math.PI * 2)
  ctx.strokeStyle = `rgba(${ri}, ${gi}, ${bi}, ${alpha})`
  ctx.lineWidth = lineW
  ctx.stroke()

  // White flash at peak
  if (atPeak) {
    ctx.beginPath()
    ctx.arc(sx, sy, currentRadius, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(255, 50, 50, 0.8)`
    ctx.lineWidth = 3
    ctx.stroke()
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

  // Pick fill/stroke based on state
  let fillColor = 'rgba(79, 195, 247, 0.15)'
  let strokeColor = COLOR_PLAYER
  if (player.hitFlash > 0) {
    fillColor = `rgba(255, 50, 50, ${0.5 * (player.hitFlash / 0.15)})`
    strokeColor = '#FF3333'
  }

  // Dash trail — multiple afterimages
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

  // HP pie chart on player body
  const hpFraction = player.displayHp / player.maxHp
  const hpStart = -Math.PI / 2
  const hpEnd = hpStart + hpFraction * Math.PI * 2

  // Dark background (missing HP)
  ctx.beginPath()
  ctx.arc(sx, sy, PLAYER_RADIUS, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
  ctx.fill()

  // HP wedge
  if (hpFraction > 0) {
    ctx.beginPath()
    ctx.moveTo(sx, sy)
    ctx.arc(sx, sy, PLAYER_RADIUS, hpStart, hpEnd)
    ctx.closePath()
    ctx.fillStyle = fillColor
    ctx.fill()
  }

  // Outline
  ctx.beginPath()
  ctx.arc(sx, sy, PLAYER_RADIUS, 0, Math.PI * 2)
  ctx.strokeStyle = strokeColor
  ctx.lineWidth = 2.5
  ctx.stroke()

  // Dash charges — orbiting glowing dots on edge
  const orbitR = PLAYER_RADIUS + 5
  const orbitSpeed = performance.now() / 800
  const totalSlots = player.dashMaxCharges
  const recharging = player.dashCharges < player.dashMaxCharges

  for (let i = 0; i < totalSlots; i++) {
    const baseAngle = orbitSpeed + (Math.PI * 2 * i) / totalSlots
    const dotX = sx + Math.cos(baseAngle) * orbitR
    const dotY = sy + Math.sin(baseAngle) * orbitR

    if (i < player.dashCharges) {
      // Full charge — bright green glowing dot
      ctx.beginPath()
      ctx.arc(dotX, dotY, 5, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(100, 255, 120, 0.95)'
      ctx.fill()
      // Glow
      ctx.beginPath()
      ctx.arc(dotX, dotY, 10, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(100, 255, 120, 0.25)'
      ctx.fill()
    } else if (i === player.dashCharges && recharging) {
      // Recharging dot — partial fill
      const fill = player.dashRechargeTimer / 3.0 // DASH_CHARGE_TIME
      ctx.beginPath()
      ctx.arc(dotX, dotY, 4, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(79, 195, 247, ${0.15 + fill * 0.5})`
      ctx.fill()
      // Partial glow ring
      ctx.beginPath()
      ctx.arc(dotX, dotY, 4, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2)
      ctx.strokeStyle = 'rgba(79, 195, 247, 0.8)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    } else {
      // Empty slot — dim dot
      ctx.beginPath()
      ctx.arc(dotX, dotY, 3, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(79, 195, 247, 0.1)'
      ctx.fill()
    }
  }

  // Dash burst — particles fly off when dashing
  if (player.dashTimer >= 0 && player.dashTimer > 0.48) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2
      const px = player.x + Math.cos(a) * orbitR
      const py = player.y + Math.sin(a) * orbitR
      const speed = 60 + Math.random() * 80
      spawnParticle(px, py,
        Math.cos(a) * speed, Math.sin(a) * speed,
        79, 195, 247, 0.3, 2.5)
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

  // Death animation — dissolve into pixel squares
  if (enemy.dying) {
    const dt = enemy.deathTimer
    const deathDur = 0.3
    const t = Math.min(dt / deathDur, 1)

    const hr = parseInt(enemy.color.slice(1, 3), 16)
    const hg = parseInt(enemy.color.slice(3, 5), 16)
    const hb = parseInt(enemy.color.slice(5, 7), 16)

    // Spawn dissolve particles across the body area over the duration
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

    // Draw remaining body — shrinks and becomes transparent with holes
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

  // Parse hex color
  const hr = parseInt(enemy.color.slice(1, 3), 16)
  const hg = parseInt(enemy.color.slice(3, 5), 16)
  const hb = parseInt(enemy.color.slice(5, 7), 16)

  // Pick fill/stroke: red flash > yellow tint > normal
  const fillColor = `rgba(${hr}, ${hg}, ${hb}, 0.4)`
  const strokeColor = enemy.color

  const hpFraction = enemy.displayHp / enemy.maxHp
  const damageFraction = player.damage / enemy.maxHp
  const afterHitFraction = Math.max(0, hpFraction - damageFraction)
  const startAngle = -Math.PI / 2
  const endAngle = startAngle + hpFraction * Math.PI * 2
  const afterHitEnd = startAngle + afterHitFraction * Math.PI * 2

  // Dark background circle (missing HP)
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

  // Damage preview — section flickers between fill color and transparent
  if (ringOverEnemy && afterHitFraction < hpFraction) {
    if (afterHitFraction <= 0) {
      // Killing blow — entire remaining HP pulses
      const t = (performance.now() % 180) / 180
      const pulse = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)
      // Pulse between full color and dimmed
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.arc(sx, sy, r, startAngle, endAngle)
      ctx.closePath()
      ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * pulse})`
      ctx.fill()
    } else {
      // Partial damage — dim the section that will drain
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

function drawSpawnPanel(): void {
  const panelX = 10
  const panelY = 10
  const boxW = 140
  const boxH = 32
  const gap = 4

  ctx.fillStyle = 'rgba(13, 10, 26, 0.85)'
  ctx.fillRect(panelX - 4, panelY - 4, boxW + 8, (boxH + gap) * ENEMY_TYPES.length + 8)

  ctx.font = '11px monospace'
  for (let i = 0; i < ENEMY_TYPES.length; i++) {
    const t = ENEMY_TYPES[i]!
    const y = panelY + i * (boxH + gap)

    // Box background
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
    ctx.fillRect(panelX, y, boxW, boxH)

    // Color bar on left
    ctx.fillStyle = t.color
    ctx.fillRect(panelX, y, 4, boxH)

    // Key badge
    ctx.fillStyle = t.color
    ctx.globalAlpha = 0.8
    ctx.fillRect(panelX + 8, y + 6, 20, 20)
    ctx.globalAlpha = 1.0
    ctx.fillStyle = '#0D0A1A'
    ctx.font = 'bold 13px monospace'
    ctx.fillText(t.key, panelX + 14, y + 21)

    // Name + tempo
    ctx.fillStyle = t.color
    ctx.font = '11px monospace'
    ctx.fillText(`${t.name}`, panelX + 34, y + 15)
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '10px monospace'
    ctx.fillText(`${t.tempo}s`, panelX + 34, y + 27)
  }
}

function drawHUD(player: Player, enemies: Enemy[], fps: number): void {
  ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
  ctx.font = '12px monospace'
  const x = width - 200
  ctx.fillText(`FPS: ${fps}`, x, 20)
  ctx.fillText(`HP: ${player.hp}/${player.maxHp}`, x, 36)
  ctx.fillText(`Enemies: ${enemies.filter(e => e.alive).length}`, x, 52)
  ctx.fillText(`WASD=move  LMB=dash`, 10, height - 12)
  ctx.fillText(`1-5=spawn  0=spawn 100`, 10, height - 28)
}

export function getScreenWidth(): number { return width }
export function getScreenHeight(): number { return height }

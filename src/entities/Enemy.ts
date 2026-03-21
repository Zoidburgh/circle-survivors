import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { shouldFire, getBeatInterval } from '../audio/PatternClock.ts'
import { playWindup } from '../audio/AudioEngine.ts'
import { clampToArena } from '../game/Arena.ts'
import { emit } from '../core/EventBus.ts'
import { PLAYER_RADIUS } from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import type { Player } from './Player.ts'
import type { EnemyType } from './EnemyTypes.ts'
import { SpatialGrid } from '../core/SpatialGrid.ts'

export interface Enemy {
  x: number
  y: number
  ring: Ring
  hp: number
  maxHp: number
  displayHp: number
  damage: number
  radius: number
  alive: boolean
  vx: number
  vy: number
  moveSpeed: number
  typeName: string
  sound: string
  color: string
  hitFlash: number
  attackTimer: number
  expandTime: number
  deathTimer: number
  dying: boolean
  spawnTimer: number    // 0→1 grow-in animation
  baseRadius: number    // full size — radius scales during spawn
}

export function createEnemy(x: number, y: number, type: EnemyType): Enemy {
  return {
    x,
    y,
    ring: createRing(type.ringRadius, 1, hexToRgba(type.color), 'enemy'),
    hp: type.hp,
    maxHp: type.hp,
    displayHp: type.hp,
    damage: 1,
    radius: 1,  // starts tiny, grows during spawn animation
    alive: true,
    vx: 0,
    vy: 0,
    moveSpeed: type.moveSpeed,
    typeName: type.name,
    sound: type.role,
    color: type.color,
    hitFlash: 0,
    attackTimer: -1,
    expandTime: ATTACK_EXPAND_TIME,
    deathTimer: -1,
    dying: false,
    spawnTimer: 0,
    baseRadius: type.radius,
  }
}

export function updateEnemy(enemy: Enemy, player: Player, dt: number, grid: SpatialGrid): void {
  if (!enemy.alive) return

  if (enemy.hitFlash > 0) enemy.hitFlash -= dt

  // Spawn grow-in animation (0.4s)
  if (enemy.spawnTimer < 1) {
    enemy.spawnTimer += dt / 0.4
    if (enemy.spawnTimer > 1) enemy.spawnTimer = 1
    // Ease-out: grows fast then decelerates
    const t = 1 - (1 - enemy.spawnTimer) * (1 - enemy.spawnTimer)
    enemy.radius = enemy.baseRadius * t
  }

  // Smooth HP display
  if (enemy.displayHp > enemy.hp) {
    enemy.displayHp -= (enemy.displayHp - enemy.hp) * 8 * dt
    if (enemy.displayHp - enemy.hp < 0.01) enemy.displayHp = enemy.hp
  }

  // Movement
  const dx = player.x - enemy.x
  const dy = player.y - enemy.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  const sweetSpot = enemy.ring.radius * 0.85

  let moveX = 0
  let moveY = 0

  if (dist > sweetSpot + 10) {
    moveX = (dx / dist) * enemy.moveSpeed
    moveY = (dy / dist) * enemy.moveSpeed
  } else if (dist < sweetSpot - 20) {
    moveX = -(dx / dist) * enemy.moveSpeed * 0.5
    moveY = -(dy / dist) * enemy.moveSpeed * 0.5
  }

  // Separation from nearby enemies
  const nearby = grid.query(enemy)
  for (const other of nearby) {
    const otherEnemy = other as Enemy
    if (!otherEnemy.alive) continue
    const minDist = enemy.radius + otherEnemy.radius
    const ex = enemy.x - otherEnemy.x
    const ey = enemy.y - otherEnemy.y
    const eDist = Math.sqrt(ex * ex + ey * ey)
    if (eDist < minDist && eDist > 0.1) {
      const overlap = minDist - eDist
      enemy.x += (ex / eDist) * overlap * 0.5
      enemy.y += (ey / eDist) * overlap * 0.5
    }
  }

  // Don't overlap player
  const pMinDist = enemy.radius + PLAYER_RADIUS
  const pDx = enemy.x - player.x
  const pDy = enemy.y - player.y
  const pDist = Math.sqrt(pDx * pDx + pDy * pDy)
  if (pDist < pMinDist && pDist > 0.1) {
    const pOverlap = pMinDist - pDist
    enemy.x += (pDx / pDist) * pOverlap
    enemy.y += (pDy / pDist) * pOverlap
  }

  enemy.vx = moveX
  enemy.vy = moveY
  enemy.x += enemy.vx * dt
  enemy.y += enemy.vy * dt

  // Clamp to arena
  const clamped = clampToArena(enemy.x, enemy.y, enemy.radius)
  enemy.x = clamped.x
  enemy.y = clamped.y

  // Pattern-driven beat: check if this enemy type should fire now (not during spawn)
  if (enemy.attackTimer < 0 && enemy.spawnTimer >= 1 && shouldFire(enemy.typeName)) {
    // Scale expand time to fit 80% of the interval between beats
    const interval = getBeatInterval(enemy.typeName)
    enemy.expandTime = Math.min(ATTACK_EXPAND_TIME, interval * 0.8)
    enemy.attackTimer = 0
    playWindup(enemy.expandTime, false)
  }

  // Advance attack animation
  if (enemy.attackTimer >= 0) {
    enemy.attackTimer += dt
    if (enemy.attackTimer >= enemy.expandTime && enemy.attackTimer - dt < enemy.expandTime) {
      emit('enemy:beat', enemy)
    }
    if (enemy.attackTimer > enemy.expandTime + 0.05) {
      enemy.attackTimer = -1
    }
  }
}

export const DEATH_DURATION = 0.3

export function damageEnemy(enemy: Enemy, amount: number): void {
  if (enemy.dying) return
  enemy.hp -= amount
  enemy.hitFlash = 0.15
  if (enemy.hp <= 0) {
    enemy.dying = true
    enemy.deathTimer = 0
    emit('enemy:killed', enemy)
  }
}

export function updateDeath(enemy: Enemy, dt: number): void {
  if (!enemy.dying) return
  enemy.deathTimer += dt
  if (enemy.deathTimer >= DEATH_DURATION) {
    enemy.alive = false
  }
}

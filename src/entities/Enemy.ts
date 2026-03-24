import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { shouldFire, getBeatInterval, getLoopPosition } from '../audio/PatternClock.ts'
import { playWindup } from '../audio/AudioEngine.ts'
import { clampToArena } from '../game/Arena.ts'
import { emit } from '../core/EventBus.ts'
import { PLAYER_RADIUS, HIT_FLASH_DURATION, SPAWN_ANIM_DURATION, HP_DRAIN_SPEED, CHILL_SLOW_PER_STACK, CHILL_STACK_DECAY_TIME } from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import type { Player } from './Player.ts'
import type { EnemyType, MovePattern } from './EnemyTypes.ts'
import { SpatialGrid } from '../core/SpatialGrid.ts'
import { getChillRank } from '../game/UpgradeManager.ts'

export interface RingState {
  ring: Ring
  attackTimer: number
  expandTime: number
  patternName: string  // key in PatternClock
  sound: string
}

export interface Enemy {
  x: number
  y: number
  rings: RingState[]   // multiple rings
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
  color: string
  hitFlash: number
  deathTimer: number
  dying: boolean
  spawnTimer: number
  baseRadius: number
  blocksRings: boolean
  movePattern: MovePattern
  moveTimer: number
  bounceVx: number
  bounceVy: number
  zigDir: number
  zigFlipTimer: number
  lungeTimer: number
  lungeDuration: number
  lungeDirX: number
  lungeDirY: number
  chillStacks: number
  chillDecayTimer: number
}

export function createEnemy(x: number, y: number, type: EnemyType): Enemy {
  // Build ring states from type config
  const ringConfigs = type.rings ?? [
    { ringRadius: type.ringRadius, sound: type.role, beats: [] }
  ]

  const rings: RingState[] = ringConfigs.map((rc, i) => ({
    ring: createRing(rc.ringRadius, 1, hexToRgba(type.color), 'enemy'),
    attackTimer: -1,
    expandTime: ATTACK_EXPAND_TIME,
    patternName: ringConfigs.length > 1 ? `${type.name}_r${i}` : type.name,
    sound: rc.sound,
  }))

  return {
    x,
    y,
    rings,
    hp: type.hp,
    maxHp: type.hp,
    displayHp: type.hp,
    damage: 1,
    radius: 1,
    alive: true,
    vx: 0,
    vy: 0,
    moveSpeed: type.moveSpeed,
    typeName: type.name,
    color: type.color,
    hitFlash: 0,
    deathTimer: -1,
    dying: false,
    spawnTimer: 0,
    baseRadius: type.radius,
    blocksRings: type.blocksRings ?? false,
    movePattern: type.movePattern ?? 'pursue',
    moveTimer: Math.random() * Math.PI * 2,
    // Bounce: random initial direction
    bounceVx: Math.cos(Math.random() * Math.PI * 2) * type.moveSpeed,
    bounceVy: Math.sin(Math.random() * Math.PI * 2) * type.moveSpeed,
    zigDir: Math.random() > 0.5 ? 1 : -1,
    zigFlipTimer: 0,
    lungeTimer: -1,
    lungeDuration: 0.5,
    lungeDirX: 0,
    lungeDirY: 0,
    chillStacks: 0,
    chillDecayTimer: 0,
  }
}

export function updateEnemy(enemy: Enemy, player: Player, dt: number, grid: SpatialGrid): void {
  if (!enemy.alive) return

  if (enemy.hitFlash > 0) enemy.hitFlash -= dt

  // Chill stack decay
  if (enemy.chillStacks > 0) {
    enemy.chillDecayTimer += dt
    const decayMult = getChillRank() >= 2 ? 2 : 1
    if (enemy.chillDecayTimer >= CHILL_STACK_DECAY_TIME * decayMult) {
      enemy.chillStacks--
      enemy.chillDecayTimer = 0
    }
  }

  // Spawn grow-in
  if (enemy.spawnTimer < 1) {
    enemy.spawnTimer += dt / SPAWN_ANIM_DURATION
    if (enemy.spawnTimer > 1) enemy.spawnTimer = 1
    const t = 1 - (1 - enemy.spawnTimer) * (1 - enemy.spawnTimer)
    enemy.radius = enemy.baseRadius * t
  }

  // Smooth HP display — drain faster when dying so it completes before death anim ends
  if (enemy.displayHp > enemy.hp) {
    const drainRate = enemy.dying ? HP_DRAIN_SPEED * 4 : HP_DRAIN_SPEED * 2
    enemy.displayHp -= (enemy.displayHp - enemy.hp) * drainRate * dt
    if (enemy.displayHp - enemy.hp < 0.01) enemy.displayHp = enemy.hp
  }

  // Movement
  const dx = player.x - enemy.x
  const dy = player.y - enemy.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  const primaryRingRadius = enemy.rings[0]?.ring.radius ?? 100
  const sweetSpot = primaryRingRadius
  const dirX = dist > 1 ? dx / dist : 0
  const dirY = dist > 1 ? dy / dist : 0

  let moveX = 0
  let moveY = 0

  enemy.moveTimer += dt

  switch (enemy.movePattern) {
    case 'pursue':
      // Move toward player, stop at sweet spot
      if (dist > sweetSpot + 10) {
        moveX = dirX * enemy.moveSpeed
        moveY = dirY * enemy.moveSpeed
      } else if (dist < sweetSpot - 20) {
        moveX = -dirX * enemy.moveSpeed * 0.5
        moveY = -dirY * enemy.moveSpeed * 0.5
      }
      break

    case 'orbit':
      // Move to sweet spot distance, then circle around the player
      if (dist > sweetSpot + 30) {
        // Approach
        moveX = dirX * enemy.moveSpeed
        moveY = dirY * enemy.moveSpeed
      } else if (dist < sweetSpot - 30) {
        // Back off
        moveX = -dirX * enemy.moveSpeed * 0.5
        moveY = -dirY * enemy.moveSpeed * 0.5
      } else {
        // Orbit — perpendicular to player direction
        moveX = -dirY * enemy.moveSpeed * 0.7
        moveY = dirX * enemy.moveSpeed * 0.7
      }
      break

    case 'zigzag': {
      // Flip direction on the beat — synced to audio clock
      if (shouldFire('HalfBeat')) enemy.zigDir *= -1
      if (dist > 1) {
        const perpX = -dirY
        const perpY = dirX
        if (dist > sweetSpot + 10) {
          // Approach + heavy weave — more sideways than forward
          moveX = (dirX * 0.7 + perpX * enemy.zigDir * 1.2) * enemy.moveSpeed
          moveY = (dirY * 0.7 + perpY * enemy.zigDir * 1.2) * enemy.moveSpeed
        } else if (dist < sweetSpot - 20) {
          // Too close — zigzag away
          moveX = (-dirX * 0.7 + perpX * enemy.zigDir * 1.2) * enemy.moveSpeed * 0.7
          moveY = (-dirY * 0.7 + perpY * enemy.zigDir * 1.2) * enemy.moveSpeed * 0.7
        } else {
          // At sweet spot — just strafe
          moveX = perpX * enemy.zigDir * enemy.moveSpeed * 0.5
          moveY = perpY * enemy.zigDir * enemy.moveSpeed * 0.5
        }
      }
      break
    }

    case 'lunge': {
      // Lunge on the beat — synced to audio clock
      if (enemy.lungeTimer <= 0 && enemy.spawnTimer >= 1 && shouldFire('Player')) {
        const ldx = player.x - enemy.x
        const ldy = player.y - enemy.y
        const ldist = Math.sqrt(ldx * ldx + ldy * ldy)
        if (ldist > 1) {
          enemy.lungeDirX = ldx / ldist
          enemy.lungeDirY = ldy / ldist
          enemy.lungeDuration = 0.5
          enemy.lungeTimer = 0.5
        }
      }
      if (enemy.lungeTimer > 0) {
        enemy.lungeTimer -= dt
        const lProg = 1 - Math.max(0, enemy.lungeTimer) / enemy.lungeDuration
        // Fast start, holds speed, quick stop at the end
        const t = lProg < 0.15
          ? lProg / 0.15  // quick ramp up
          : lProg > 0.85
            ? (1 - lProg) / 0.15  // quick ramp down
            : 1.0  // full speed in the middle
        const lSpeed = t * enemy.moveSpeed * 2.5
        if (dist > sweetSpot + 10) {
          moveX = enemy.lungeDirX * lSpeed
          moveY = enemy.lungeDirY * lSpeed
        } else if (dist < sweetSpot - 20) {
          moveX = -dirX * lSpeed
          moveY = -dirY * lSpeed
        }
      } else if (dist < sweetSpot - 30 && shouldFire('Player')) {
        enemy.lungeDirX = -dirX
        enemy.lungeDirY = -dirY
        enemy.lungeDuration = 0.5
        enemy.lungeTimer = 0.5
      }
      break
    }

    case 'bounce':
      moveX = enemy.bounceVx
      moveY = enemy.bounceVy
      break

    case 'stationary':
      break
  }

  // Separation — for bounce enemies, reflect velocity on collision
  const isBounce = enemy.movePattern === 'bounce'
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
      const nx = ex / eDist
      const ny = ey / eDist
      enemy.x += nx * overlap * 0.5
      enemy.y += ny * overlap * 0.5
      if (isBounce) {
        // Reflect velocity off the collision normal
        const dot = enemy.bounceVx * nx + enemy.bounceVy * ny
        if (dot < 0) {
          enemy.bounceVx -= 2 * dot * nx
          enemy.bounceVy -= 2 * dot * ny
        }
      }
    }
  }

  // Don't overlap player — bounce off player too
  const pMinDist = enemy.radius + PLAYER_RADIUS
  const pDx = enemy.x - player.x
  const pDy = enemy.y - player.y
  const pDist = Math.sqrt(pDx * pDx + pDy * pDy)
  if (pDist < pMinDist && pDist > 0.1) {
    const pOverlap = pMinDist - pDist
    const pnx = pDx / pDist
    const pny = pDy / pDist
    enemy.x += pnx * pOverlap
    enemy.y += pny * pOverlap
    if (isBounce) {
      const dot = enemy.bounceVx * pnx + enemy.bounceVy * pny
      if (dot < 0) {
        enemy.bounceVx -= 2 * dot * pnx
        enemy.bounceVy -= 2 * dot * pny
      }
    }
  }

  // Apply chill slow
  const chillMult = 1 - enemy.chillStacks * CHILL_SLOW_PER_STACK
  enemy.vx = moveX * chillMult
  enemy.vy = moveY * chillMult
  enemy.x += enemy.vx * dt
  enemy.y += enemy.vy * dt

  // Clamp to arena — bounce off walls
  const prevX = enemy.x
  const prevY = enemy.y
  const clamped = clampToArena(enemy.x, enemy.y, enemy.radius)
  enemy.x = clamped.x
  enemy.y = clamped.y
  if (isBounce) {
    if (clamped.x !== prevX) enemy.bounceVx = -enemy.bounceVx
    if (clamped.y !== prevY) enemy.bounceVy = -enemy.bounceVy
    // Normalize back to constant speed
    const bSpeed = Math.sqrt(enemy.bounceVx * enemy.bounceVx + enemy.bounceVy * enemy.bounceVy)
    if (bSpeed > 0.1) {
      enemy.bounceVx = (enemy.bounceVx / bSpeed) * enemy.moveSpeed
      enemy.bounceVy = (enemy.bounceVy / bSpeed) * enemy.moveSpeed
    }
  }

  // Update each ring independently
  if (enemy.spawnTimer >= 1) {
    for (let i = 0; i < enemy.rings.length; i++) {
      const rs = enemy.rings[i]!
      if (shouldFire(rs.patternName)) {
        const interval = getBeatInterval(rs.patternName)
        rs.expandTime = Math.min(ATTACK_EXPAND_TIME, interval * 0.8)
        rs.attackTimer = 0
        playWindup(rs.expandTime, false)
      }

      if (rs.attackTimer >= 0) {
        rs.attackTimer += dt
        if (rs.attackTimer >= rs.expandTime && rs.attackTimer - dt < rs.expandTime) {
          emit('enemy:beat', enemy, i)
        }
        if (rs.attackTimer > rs.expandTime + 0.05) {
          rs.attackTimer = -1
        }
      }
    }
  }
}

export const DEATH_DURATION = 0.3

export function damageEnemy(enemy: Enemy, amount: number): void {
  if (enemy.dying) return
  enemy.hp -= amount
  enemy.hitFlash = HIT_FLASH_DURATION
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

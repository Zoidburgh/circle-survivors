import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { shouldFire, getBeatInterval, getLoopPosition } from '../audio/PatternClock.ts'
import { playWindup } from '../audio/AudioEngine.ts'
import { clampToArena, getArenaShape, ARENA_CX, ARENA_CY } from '../game/Arena.ts'
import { emit } from '../core/EventBus.ts'
import { PLAYER_RADIUS, HIT_FLASH_DURATION, SPAWN_ANIM_DURATION, HP_DRAIN_SPEED, CHILL_SLOW_PER_STACK, CHILL_STACK_DECAY_TIME, MAGNET_RANGE, BEAT_SEC } from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import type { Player } from './Player.ts'
import type { EnemyType, MovePattern, SummonPhase } from './EnemyTypes.ts'
import { SpatialGrid } from '../core/SpatialGrid.ts'
import { getChillRank } from '../game/UpgradeManager.ts'

export interface RingState {
  ring: Ring
  attackTimer: number
  expandTime: number
  patternName: string  // key in PatternClock
  sound: string
  edgeMode: boolean
  edgePoints: number
  edgeActive: number       // how many fire simultaneously
  edgeSwitchBeats: number
  edgeIndex: number        // target rotation offset
  edgeAngle: number        // smooth current angle (radians)
  edgeBeatCount: number
  peakX: number            // enemy position at ring peak
  peakY: number
  peakCaptured: boolean
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
  cr: number  // parsed color components (avoid per-frame parseInt)
  cg: number
  cb: number
  immovable: boolean   // derived from movePattern === 'immovable'
  totemSpawn: string    // empty = not a totem, otherwise enemy type name to spawn
  dropType: 'xp' | 'hp' | 'none'
  dropXp: number   // 0-100
  dropHp: number   // 0-100
  dropCount: number // how many orbs to drop
  consume: boolean      // ring attack consumes nearby orbs, heals +1
  magnet: boolean       // pulls nearby orbs toward this enemy
  magnetRange: number   // pull radius
  blink: boolean        // teleports periodically
  blinkBeats: number    // beats between blinks
  volatile: boolean     // explodes on death
  volatileRange: number // explosion radius
  revenge: boolean      // fires rings after being hit
  revengeRings: number  // how many
  revengeRadius: number // ring radius
  revengeArmed: boolean // hit received, waiting for beat
  revengeTimer: number  // time since armed
  revengeAngle: number  // slowly rotating base angle for fire points
  blinkTimer: number    // counts beats until next blink
  blinkGhostX: number   // destination / old position after teleport
  blinkGhostY: number
  blinkFromX: number    // position before teleport (for trail)
  blinkFromY: number
  blinkPreview: number  // >0 = showing ghost, counts down
  summon: boolean
  summonNodes: number
  summonPhases: SummonPhase[]
  summonProgress: number          // nodes locked in current sequence
  summonStartOffset: number       // which node player started at
  summonCurrentPhase: number      // which phase we're on
  summonNodeStates: ('idle' | 'locked')[]
  summonLockFlash: number[]       // per-node flash timer
  summonBeatCount: number         // monotonic beat counter
  summonLastBeat: number          // last whole beat seen
  summonActivationTimer: number   // >0 = activation animation playing, counts down
  isShrine: boolean
  shrineSpawnEnemy: string        // enemy type name per hit (empty = none)
  shrineXpCount: number           // XP orbs per hit
  shrineHpCount: number           // HP orbs per hit
  shrineSummonTimer: number       // >0 = summoning animation playing, counts down
}

/** Get the world positions a ring fires from (center or edge offsets) */
export function getRingOrigins(enemy: Enemy, rs: RingState): { x: number; y: number }[] {
  if (!rs.edgeMode) return [{ x: enemy.x, y: enemy.y }]
  const origins: { x: number; y: number }[] = []
  const step = (Math.PI * 2) / rs.edgePoints
  for (let a = 0; a < rs.edgeActive; a++) {
    const angle = -Math.PI / 2 + rs.edgeAngle + a * step
    origins.push({
      x: enemy.x + Math.cos(angle) * enemy.radius,
      y: enemy.y + Math.sin(angle) * enemy.radius,
    })
  }
  return origins
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
    edgeMode: rc.edgeMode ?? false,
    edgePoints: rc.edgePoints ?? 3,
    edgeActive: rc.edgeActive ?? 1,
    edgeSwitchBeats: rc.edgeSwitchBeats ?? 1,
    edgeIndex: 0,
    edgeAngle: 0,
    edgeBeatCount: 0,
    peakX: 0,
    peakY: 0,
    peakCaptured: false,
  }))

  const e: Enemy = {
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
    cr: parseInt(type.color.slice(1, 3), 16),
    cg: parseInt(type.color.slice(3, 5), 16),
    cb: parseInt(type.color.slice(5, 7), 16),
    immovable: (type.movePattern ?? 'pursue') === 'immovable',
    totemSpawn: type.totemSpawn ?? '',
    dropType: type.dropType ?? 'xp',
    dropXp: type.dropXp ?? (type.dropType === 'hp' ? 0 : type.dropType === 'none' ? 0 : 100),
    dropHp: type.dropHp ?? (type.dropType === 'hp' ? 100 : 0),
    dropCount: type.dropCount ?? 1,
    consume: type.consume ?? false,
    magnet: type.magnet ?? false,
    magnetRange: type.magnetRange ?? MAGNET_RANGE,
    blink: type.blink ?? false,
    blinkBeats: type.blinkBeats ?? 4,
    volatile: type.volatile ?? false,
    volatileRange: type.volatileRange ?? 150,
    revenge: type.revenge ?? false,
    revengeRings: type.revengeRings ?? 4,
    revengeRadius: type.revengeRadius ?? 120,
    revengeArmed: false,
    revengeTimer: 0,
    revengeAngle: 0,
    blinkTimer: type.blinkBeats ?? 4,
    blinkGhostX: 0,
    blinkGhostY: 0,
    blinkFromX: 0,
    blinkFromY: 0,
    blinkPreview: 0,
    summon: type.summon ?? false,
    summonNodes: type.summonNodes ?? 3,
    summonPhases: type.summonPhases ?? [],
    summonProgress: 0,
    summonStartOffset: 0,
    summonCurrentPhase: 0,
    summonNodeStates: Array(type.summonNodes ?? 3).fill('idle'),
    summonLockFlash: Array(type.summonNodes ?? 3).fill(0),
    summonBeatCount: 0,
    summonLastBeat: -1,
    summonActivationTimer: 0,
    isShrine: type.isShrine ?? false,
    shrineSpawnEnemy: type.shrineSpawnEnemy ?? '',
    shrineXpCount: type.shrineXpCount ?? 0,
    shrineHpCount: type.shrineHpCount ?? 0,
    shrineSummonTimer: 0,
  }
  // Shrines: skip spawn animation, pushable by enemies, HP from designer
  if (e.isShrine) {
    e.immovable = false
    e.radius = e.baseRadius  // full size immediately, no spawn anim
    e.spawnTimer = 1          // mark spawn complete
  }
  return e
}

export function updateEnemy(enemy: Enemy, player: Player, dt: number, grid: SpatialGrid): void {
  if (!enemy.alive || enemy.dying) return
  // Summon beat counter — must run before any early returns
  if (enemy.summon) {
    const cb = Math.floor(getLoopPosition())
    if (cb !== enemy.summonLastBeat) {
      if (enemy.summonLastBeat >= 0) enemy.summonBeatCount++
      enemy.summonLastBeat = cb
    }
    for (let i = 0; i < enemy.summonLockFlash.length; i++) {
      if (enemy.summonLockFlash[i]! > 0) enemy.summonLockFlash[i]! -= dt
    }
    if (enemy.summonActivationTimer > 0) {
      enemy.summonActivationTimer -= dt
      if (enemy.summonActivationTimer <= 0) {
        emit('summon:phase', enemy)
      }
    }
  }

  if (enemy.hitFlash > 0) enemy.hitFlash -= dt
  if (enemy.isShrine && enemy.shrineSummonTimer > 0) enemy.shrineSummonTimer -= dt

  // Chill stack decay
  if (enemy.chillStacks > 0) {
    enemy.chillDecayTimer += dt
    const decayMult = getChillRank() >= 2 ? 2 : 1
    if (enemy.chillDecayTimer >= CHILL_STACK_DECAY_TIME * decayMult) {
      enemy.chillStacks--
      enemy.chillDecayTimer = 0
    }
  }

  // Blink logic — fast phase out/in
  if (enemy.blink && enemy.spawnTimer >= 1) {
    // Phase transition in progress
    if (enemy.blinkPreview > 0) {
      enemy.blinkPreview -= dt
      // Teleport at half-beat
      if (enemy.blinkPreview <= BEAT_SEC * 0.5 && enemy.blinkGhostX !== enemy.x) {
        enemy.x = enemy.blinkGhostX
        enemy.y = enemy.blinkGhostY
      }
    }
    // Count beats — only when no ring is firing and not phasing
    const allRingsIdle = enemy.rings.every(rs => rs.attackTimer < 0)
    if (allRingsIdle && enemy.blinkPreview <= 0 && shouldFire('Player')) {
      enemy.blinkTimer--
      if (enemy.blinkTimer <= 0) {
        const dx = enemy.x - player.x
        const dy = enemy.y - player.y
        const currentDist = Math.sqrt(dx * dx + dy * dy)
        // Teleport to opposite side at the SAME distance
        const baseAngle = currentDist > 1 ? Math.atan2(-dy, -dx) : Math.random() * Math.PI * 2
        const angle = baseAngle + (Math.random() - 0.5) * 1.0
        const destX = player.x + Math.cos(angle) * currentDist
        const destY = player.y + Math.sin(angle) * currentDist
        const clamped = clampToArena(destX, destY, enemy.radius)
        enemy.blinkFromX = enemy.x
        enemy.blinkFromY = enemy.y
        enemy.blinkGhostX = clamped.x
        enemy.blinkGhostY = clamped.y
        enemy.blinkPreview = BEAT_SEC  // synced to one full beat: telegraph → snap on half-beat → coil back
        enemy.blinkTimer = enemy.blinkBeats
      }
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
  } else if (enemy.displayHp < enemy.hp) {
    enemy.displayHp += (enemy.hp - enemy.displayHp) * 6 * dt
    if (enemy.hp - enemy.displayHp < 0.01) enemy.displayHp = enemy.hp
  }

  // Immovable enemies skip all movement and separation
  if (enemy.immovable) {
    // Still update rings
    if (enemy.spawnTimer >= 1) {
      for (let i = 0; i < enemy.rings.length; i++) {
        const rs = enemy.rings[i]!
        if (shouldFire(rs.patternName)) {
          const interval = getBeatInterval(rs.patternName)
          rs.expandTime = Math.min(ATTACK_EXPAND_TIME, interval * 0.8)
          rs.attackTimer = 0
          playWindup(rs.expandTime, false)
          if (rs.edgeMode) {
            rs.edgeBeatCount++
            if (rs.edgeBeatCount >= rs.edgeSwitchBeats) {
              rs.edgeBeatCount = 0
              rs.edgeIndex = (rs.edgeIndex + 1) % rs.edgePoints
            }
          }
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
    return
  }

  // Movement
  const dx = player.x - enemy.x
  const dy = player.y - enemy.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  // Sweet spot: ring radius if has active rings, otherwise rush into player
  const hasActiveRing = enemy.rings.some(rs => rs.patternName && rs.ring.radius > 0)
  const sweetSpot = hasActiveRing ? (enemy.rings[0]?.ring.radius ?? 100) : 0
  const dirX = dist > 1 ? dx / dist : 0
  const dirY = dist > 1 ? dy / dist : 0

  let moveX = 0
  let moveY = 0

  enemy.moveTimer += dt
  if (enemy.revenge) enemy.revengeAngle += dt * 0.5  // slow rotation ~0.5 rad/s

  // (summon beat counter moved above early-return check)

  // Don't move during spawn-in animation
  if (enemy.spawnTimer < 1) {
    // Skip movement but still apply velocity dampening
    enemy.vx *= 0.9
    enemy.vy *= 0.9
    return
  }

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
      // Take full overlap if other is immovable, otherwise half
      const pushFrac = otherEnemy.immovable ? 1.0 : 0.5
      enemy.x += nx * overlap * pushFrac
      enemy.y += ny * overlap * pushFrac
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

  // Don't overlap player — bounce off player too (shrines let player walk through)
  if (enemy.isShrine) { /* skip player push */ } else {
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
  } // end shrine player-push skip

  // Preserve bounce speed — reflections can degrade magnitude over time
  if (isBounce) {
    const bSpeed = Math.sqrt(enemy.bounceVx * enemy.bounceVx + enemy.bounceVy * enemy.bounceVy)
    if (bSpeed > 0.1) {
      const targetSpeed = enemy.moveSpeed
      const scale = targetSpeed / bSpeed
      enemy.bounceVx *= scale
      enemy.bounceVy *= scale
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
  if (isBounce && (clamped.x !== prevX || clamped.y !== prevY)) {
    const shape = getArenaShape()
    if (shape === 'circle') {
      // Reflect off circle wall normal
      const nx = (enemy.x - ARENA_CX)
      const ny = (enemy.y - ARENA_CY)
      const nLen = Math.sqrt(nx * nx + ny * ny)
      if (nLen > 0.1) {
        const nnx = nx / nLen
        const nny = ny / nLen
        const dot = enemy.bounceVx * nnx + enemy.bounceVy * nny
        if (dot > 0) {
          enemy.bounceVx -= 2 * dot * nnx
          enemy.bounceVy -= 2 * dot * nny
        }
      }
    } else if (shape === 'hex' || shape === 'pill' || shape === 'cross') {
      // Reflect off hex edge — use displacement as wall normal
      const dnx = enemy.x - prevX
      const dny = enemy.y - prevY
      const dLen = Math.sqrt(dnx * dnx + dny * dny)
      if (dLen > 0.01) {
        const nnx = dnx / dLen
        const nny = dny / dLen
        const dot = enemy.bounceVx * nnx + enemy.bounceVy * nny
        if (dot < 0) {
          enemy.bounceVx -= 2 * dot * nnx
          enemy.bounceVy -= 2 * dot * nny
        }
      }
    } else {
      if (clamped.x !== prevX) enemy.bounceVx = -enemy.bounceVx
      if (clamped.y !== prevY) enemy.bounceVy = -enemy.bounceVy
    }
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
      // Smooth edge angle toward target
      if (rs.edgeMode) {
        const targetAngle = (rs.edgeIndex / rs.edgePoints) * Math.PI * 2
        let diff = targetAngle - rs.edgeAngle
        // Shortest path around the circle
        while (diff > Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        rs.edgeAngle += diff * 8 * dt  // smooth lerp
      }
      if (shouldFire(rs.patternName)) {
        const interval = getBeatInterval(rs.patternName)
        rs.expandTime = Math.min(ATTACK_EXPAND_TIME, interval * 0.8)
        rs.attackTimer = 0
        rs.peakCaptured = false
        playWindup(rs.expandTime, false)
        // Edge mode: advance point after N beats
        if (rs.edgeMode) {
          rs.edgeBeatCount++
          if (rs.edgeBeatCount >= rs.edgeSwitchBeats) {
            rs.edgeBeatCount = 0
            rs.edgeIndex = (rs.edgeIndex + 1) % rs.edgePoints
          }
        }
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

/** Spawn all drops for a killed enemy — handles count, proportions, and cluster positioning */
export function spawnDrops(enemy: Enemy, orbValue: number, spawnOrb: (x: number, y: number, value: number, type: 'xp' | 'hp') => void): void {
  const count = enemy.dropCount
  for (let i = 0; i < count; i++) {
    const drop = rollDrop(enemy)
    if (!drop) continue
    // Cluster offset — spiral outward from enemy center
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3
    const dist = count > 1 ? 8 + (i / count) * 12 : 0
    const ox = enemy.x + Math.cos(angle) * dist
    const oy = enemy.y + Math.sin(angle) * dist
    spawnOrb(ox, oy, orbValue, drop)
  }
}

/** Roll drop type based on percentage chances. Returns 'xp', 'hp', or null (no drop) */
export function rollDrop(enemy: Enemy): 'xp' | 'hp' | null {
  const total = enemy.dropXp + enemy.dropHp
  if (total <= 0) return null
  const roll = Math.random() * Math.max(total, 100)
  if (roll < enemy.dropXp) return 'xp'
  if (roll < enemy.dropXp + enemy.dropHp) return 'hp'
  return null
}

export function damageEnemy(enemy: Enemy, amount: number): void {
  if (enemy.dying || enemy.isShrine) return
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

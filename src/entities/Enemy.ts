import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { shouldFire, getBeatInterval, getLoopPosition } from '../audio/PatternClock.ts'
import { playWindup, playEnemyDodge, playEnemyShieldBreak, playEnemyShieldRestore, startEnemyShieldFuseBurn, stopEnemyShieldFuseBurn } from '../audio/AudioEngine.ts'
import { isRunTimerActive, isRunComplete, startRunTimer, getPhase } from '../core/GameState.ts'
import { showToast } from '../render/Renderer.ts'
import { applyDashMotion } from './DashMotion.ts'

let leaveToastGlobalCD = 0
let revengeToastGlobalCD = 0
export function tickLeaveToastCD(dt: number): void {
  if (leaveToastGlobalCD > 0) leaveToastGlobalCD -= dt
  if (revengeToastGlobalCD > 0) revengeToastGlobalCD -= dt
}
export function resetLeaveToastCD(): void { leaveToastGlobalCD = 0; revengeToastGlobalCD = 0 }
import { clampToArena, getArenaShape, ARENA_CX, ARENA_CY } from '../game/Arena.ts'
import { emit } from '../core/EventBus.ts'
import { PLAYER_RADIUS, HIT_FLASH_DURATION, SPAWN_ANIM_DURATION, HP_DRAIN_SPEED, CHILL_SLOW_PER_STACK, CHILL_STACK_DECAY_TIME, MAGNET_RANGE, BEAT_SEC, SHIELD_BREAK_FLASH } from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import type { Player } from './Player.ts'
import type { EnemyType, MovePattern, SummonPhase, ShrinePhase } from './EnemyTypes.ts'
import { getEnemyType } from './EnemyTypes.ts'
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
  recentHitTimes: number[]  // timestamps of recent hits for toast tracking
  leaveToastCooldown: number  // cooldown until next "leave me alone" can fire
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
  summonDisplayPhase: number      // smooth display for drain animation
  summonNodeStates: ('idle' | 'locked')[]
  summonLockFlash: number[]       // per-node flash timer
  summonBeatCount: number         // monotonic beat counter
  summonLastBeat: number          // last whole beat seen
  summonActivationTimer: number   // >0 = activation animation playing, counts down
  isShrine: boolean
  shrineSpawnEnemy: string        // LEGACY — use shrinePhases
  shrineXpCount: number           // LEGACY
  shrineHpCount: number           // LEGACY
  shrinePhases: ShrinePhase[]     // per-hit spawn waves
  shrineCurrentPhase: number      // which phase we're on
  shrineSummonTimer: number       // >0 = summoning animation playing, counts down
  designerEphemeral?: boolean     // true = spawned for feel-testing in designer; cleared on exit
  // Dodge trait — same field names/semantics as Player.dash* so shared helpers work on both
  dodge: boolean
  dodgeSlots: number[]            // per-slot recharge timer (0 = ready, >0 = recharging)
  dodgeJustConsumed: boolean[]    // transient — set when slot consumed, cleared by Renderer after burst
  dodgeJustReady: boolean[]       // transient — set when slot finishes recharging, cleared by Renderer
  dodgeReadyFlash: number[]       // per-slot flash timer (0 = inactive, >0 = spiral/shockwave overlay)
  dashTimer: number               // -1 = idle, >0 = mid-burst (mirrors player.dashTimer)
  dashDirX: number
  dashDirY: number
  dashDuration: number            // total burst duration in seconds
  dashDistance: number            // total burst distance (used by sine-curve speed calc)
  dashSpeedMult: number           // user-tunable burst speed multiplier (default 1.0)
  dashPath: { x: number; y: number }[]   // for afterimage (mirrors player.dashPath)
  // Shield trait — same field names/semantics as Player.shield* so shared helpers work on both
  shield: boolean
  shieldCharges: number
  shieldMaxCharges: number        // hardcoded 1 (matches player)
  shieldRechargeTimer: number     // -1 = charged, >0 = recharging
  shieldBreakFlash: number        // visual break effect timer
  shieldRechargeTime: number      // = type.shieldRechargeTime
  shieldJustRestored: boolean     // transient — set when shield refills, cleared by Renderer after burst
  shieldJustBroken: boolean       // transient — set on break, cleared by Renderer after shard burst (one-shot, immune to dt-tick race)
  shieldActivateTimer: number     // >0 = bright outer ring fades over this duration (activation glow)
  beatDashFlash: number           // >0 = enemy was just hit by the beat-dash AOE; drives a yellow glow that stacks on top of the red hitFlash
  beatDashJustHit: boolean        // transient — set on beat-dash hit, cleared by Renderer after spawning lightning bolts (one-shot, immune to dt-tick race)
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
    recentHitTimes: [],
    leaveToastCooldown: 0,
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
    summonDisplayPhase: 0,
    summonNodeStates: Array(type.summonNodes ?? 3).fill('idle'),
    summonLockFlash: Array(type.summonNodes ?? 3).fill(0),
    summonBeatCount: 0,
    summonLastBeat: -1,
    summonActivationTimer: 0,
    isShrine: type.isShrine ?? false,
    shrineSpawnEnemy: type.shrineSpawnEnemy ?? '',
    shrineXpCount: type.shrineXpCount ?? 0,
    shrineHpCount: type.shrineHpCount ?? 0,
    shrinePhases: type.shrinePhases ?? [],
    shrineCurrentPhase: 0,
    shrineSummonTimer: 0,
    // Dodge trait (no behavior yet — Step 2 wires the trigger)
    dodge: type.dodge ?? false,
    dodgeSlots: type.dodge ? Array(type.dodgeCharges ?? 2).fill(0) : [],
    dodgeJustConsumed: type.dodge ? Array(type.dodgeCharges ?? 2).fill(false) : [],
    dodgeJustReady: type.dodge ? Array(type.dodgeCharges ?? 2).fill(false) : [],
    dodgeReadyFlash: type.dodge ? Array(type.dodgeCharges ?? 2).fill(0) : [],
    dashTimer: -1,
    dashDirX: 0,
    dashDirY: 0,
    dashDuration: 0.2,
    dashDistance: type.dodgeDistance ?? 100,
    dashSpeedMult: type.dodgeSpeed ?? 1,
    dashPath: [],
    // Shield trait (no behavior yet — Step 2 wires absorb logic)
    shield: type.shield ?? false,
    shieldCharges: type.shield ? 1 : 0,
    shieldMaxCharges: 1,
    shieldRechargeTimer: -1,
    shieldBreakFlash: 0,
    shieldRechargeTime: type.shieldRechargeTime ?? 4,
    shieldJustRestored: false,
    shieldJustBroken: false,
    shieldActivateTimer: 0,
    beatDashFlash: 0,
    beatDashJustHit: false,
  }
  // Shrines: skip spawn animation, pushable by enemies
  if (e.isShrine) {
    e.immovable = false
    e.radius = e.baseRadius  // full size immediately, no spawn anim
    e.spawnTimer = 1          // mark spawn complete
    if (e.shrinePhases.length > 0) {
      e.hp = e.shrinePhases.length
      e.maxHp = e.shrinePhases.length
    }
  }
  return e
}

// ── Dodge trait ──────────────────────────────────────────────────────────────
// "Brain" that watches player rings and decides when/where to dodge. Movement
// itself is delegated to the shared applyDashMotion (same code as player dash).

interface DangerRing { peakR: number; dist: number }

function shouldDodge(enemy: Enemy, player: Player): DangerRing | null {
  const baseRingR = (player.ring?.radius ?? 0) * (player.modifiers?.ringRadiusMult ?? 1)
  // Hit band width: enemy.radius (per HitDetection) + small extra so dodge starts before edge contact
  const band = enemy.radius + 12
  const checkRing = (timer: number, r: number): DangerRing | null => {
    if (timer < 0) return null
    const pct = timer / ATTACK_EXPAND_TIME
    if (pct < 0.45 || pct > 0.85) return null   // earlier window so burst peaks before ring peak
    const dist = Math.hypot(enemy.x - player.x, enemy.y - player.y)
    if (Math.abs(dist - r) > band) return null
    return { peakR: r, dist }
  }
  const main = checkRing(player.attackTimer, baseRingR)
  if (main) return main
  for (let i = 0; i < player.extraRingCount; i++) {
    const t = player.extraRingTimers[i] ?? -1
    const found = checkRing(t, baseRingR)
    if (found) return found
  }
  return null
}

function pickDodgeDirection(enemy: Enemy, player: Player, danger: DangerRing, grid: SpatialGrid): { x: number; y: number } | null {
  // Score 8 candidates at 45° around the enemy. Score = distance from ring path at peak (safer = bigger).
  // Heavy bonus for staying on the same side of the ring band as where you started — avoids
  // pointless leapfrog dodges that cross through the danger zone.
  // Hard-skip walls AND nearby immovable enemies (treated like soft walls).
  let baseAngle = Math.atan2(enemy.y - player.y, enemy.x - player.x)
  if (danger.dist < danger.peakR) baseAngle += Math.PI
  const startedInside = danger.dist < danger.peakR
  const nearby = grid.query(enemy)
  const heavies: { x: number; y: number; r: number }[] = []
  for (const o of nearby) {
    if (!('hp' in o)) continue
    const oe = o as Enemy
    if (oe === enemy || !oe.alive || oe.dying || !oe.immovable) continue
    heavies.push({ x: oe.x, y: oe.y, r: oe.radius })
  }
  const candidates: { x: number; y: number; score: number }[] = []
  for (let i = 0; i < 8; i++) {
    const angle = baseAngle + (i * Math.PI / 4)
    const dx = Math.cos(angle)
    const dy = Math.sin(angle)
    const newX = enemy.x + dx * enemy.dashDistance
    const newY = enemy.y + dy * enemy.dashDistance
    const c = clampToArena(newX, newY, enemy.radius)
    if (Math.hypot(newX - c.x, newY - c.y) > 10) continue   // wall — skip
    // Heavy avoidance: skip if landing inside any immovable's hitbox + small buffer.
    let blockedByHeavy = false
    for (const h of heavies) {
      if (Math.hypot(newX - h.x, newY - h.y) < h.r + enemy.radius + 5) { blockedByHeavy = true; break }
    }
    if (blockedByHeavy) continue
    const newDist = Math.hypot(newX - player.x, newY - player.y)
    let score = Math.abs(newDist - danger.peakR)
    const newInside = newDist < danger.peakR
    if (startedInside === newInside) score += 115   // strong same-side bias
    candidates.push({ x: dx, y: dy, score })
  }
  if (candidates.length === 0) return null   // all blocked — no dodge, no charge consumed
  candidates.sort((a, b) => b.score - a.score)
  return { x: candidates[0]!.x, y: candidates[0]!.y }
}

function updateDodge(enemy: Enemy, player: Player, dt: number, grid: SpatialGrid): void {
  const type = getEnemyType(enemy.typeName)
  if (!type) return
  // Tick charge timers — each slot recharges independently, like player dash
  for (let i = 0; i < enemy.dodgeSlots.length; i++) {
    if (enemy.dodgeSlots[i]! > 0) {
      enemy.dodgeSlots[i]! -= dt
      if (enemy.dodgeSlots[i]! <= 0) {
        enemy.dodgeSlots[i] = 0
        enemy.dodgeJustReady[i] = true   // Renderer fires the converge animation, then clears
      }
    }
  }

  // Skip trigger if mid-burst or no charges
  if (enemy.dashTimer >= 0) return
  const readySlot = enemy.dodgeSlots.findIndex(t => t <= 0)
  if (readySlot < 0) return

  const danger = shouldDodge(enemy, player)
  if (!danger) return
  const dir = pickDodgeDirection(enemy, player, danger, grid)
  if (!dir) return   // all directions walled — no dodge, no charge consumed

  enemy.dashDirX = dir.x
  enemy.dashDirY = dir.y
  enemy.dashTimer = enemy.dashDuration
  enemy.dashPath = [{ x: enemy.x, y: enemy.y }]
  enemy.dodgeSlots[readySlot] = type.dodgeChargeTime ?? 1.5
  enemy.dodgeJustConsumed[readySlot] = true   // Renderer fires the consume burst, then clears
  playEnemyDodge()
}

export function updateEnemy(enemy: Enemy, player: Player, dt: number, grid: SpatialGrid): void {
  if (!enemy.alive || enemy.dying) return
  // (leaveToast uses global cooldown now)
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
  if (enemy.beatDashFlash > 0) enemy.beatDashFlash -= dt
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

  // Shield: tick break flash + recharge timer + activate glow (mirrors Player.updatePlayer:228-238)
  if (enemy.shield) {
    if (enemy.shieldBreakFlash > 0) enemy.shieldBreakFlash -= dt
    if (enemy.shieldActivateTimer > 0) enemy.shieldActivateTimer -= dt
    if (enemy.shieldRechargeTimer > 0) {
      enemy.shieldRechargeTimer -= dt
      if (enemy.shieldRechargeTimer <= 0) {
        enemy.shieldRechargeTimer = -1
        enemy.shieldCharges = Math.min(enemy.shieldCharges + 1, enemy.shieldMaxCharges)
        enemy.shieldJustRestored = true
        enemy.shieldActivateTimer = 0.55
        playEnemyShieldRestore()
        stopEnemyShieldFuseBurn()
      }
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
    const drainRate = enemy.dying ? HP_DRAIN_SPEED * 3 : HP_DRAIN_SPEED * 1.0
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

  // Dodge: if mid-burst, skip the move-pattern entirely. Burst movement
  // controls position via shared applyDashMotion (same code as player dash).
  if (enemy.dodge && enemy.dashTimer >= 0) {
    applyDashMotion(enemy, dt, { speedMult: enemy.dashSpeedMult })
    // Fall through to separation + arena clamp at the bottom of updateEnemy
    // Skip the move-pattern switch by zeroing moveX/Y (already 0 by default).
  } else {
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

  // Don't overlap player — bounce off player too (shrines let player walk through).
  // Mid-dash dashers SKIP this — let the main player-vs-enemy pass handle them with the
  // asymmetric "dasher mass" rule, otherwise they get instantly bounced off and never plow.
  const isDashing = enemy.dodge && enemy.dashTimer >= 0
  if (enemy.isShrine || isDashing) { /* skip player push */ } else {
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
  } // end shrine/dasher player-push skip

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

  // Apply chill slow + integrate position. Skip when mid-dodge — applyDashMotion already moved us.
  const chillMult = 1 - enemy.chillStacks * CHILL_SLOW_PER_STACK
  enemy.vx = moveX * chillMult
  enemy.vy = moveY * chillMult
  if (!(enemy.dodge && enemy.dashTimer >= 0)) {
    enemy.x += enemy.vx * dt
    enemy.y += enemy.vy * dt
  }

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

  // Tick dodge state (charges/exhaustion) and check trigger AFTER all movement is settled
  if (enemy.dodge) updateDodge(enemy, player, dt, grid)
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
  if (!isRunTimerActive() && !isRunComplete() && getPhase() === 'playing') startRunTimer()
  // Track hits on stationary or revenge enemies
  if (enemy.immovable || enemy.revenge) {
    const now = performance.now() / 1000
    enemy.recentHitTimes.push(now)
    // Keep only hits in last 6s
    while (enemy.recentHitTimes.length > 0 && enemy.recentHitTimes[0]! < now - 6) {
      enemy.recentHitTimes.shift()
    }
    if (enemy.immovable && enemy.recentHitTimes.length >= 6 && leaveToastGlobalCD <= 0) {
      showToast('Bro. Leave me alone.', { y: 0.14, duration: 1.5, fadeOut: 0.3, id: `leave_${now}` })
      enemy.recentHitTimes.length = 0
      leaveToastGlobalCD = 60  // 1 minute global cooldown
    }
    // Revenge enemy hit 3+ times in last 4s
    if (enemy.revenge && revengeToastGlobalCD <= 0) {
      const recent4s = enemy.recentHitTimes.filter(t => t >= now - 4).length
      if (recent4s >= 3) {
        showToast('We come in PEACE! But we BEATBACK!', { y: 0.14, duration: 2, size: 44, id: `revenge_peace_${now}`, color: [255, 80, 200], style: 'glow', glowWords: ['PEACE!', 'BEATBACK!'], glowColor: [255, 80, 200] })
        revengeToastGlobalCD = 60
      }
    }
  }
  // Shield absorb — same model as Player.hurtPlayer (no HP loss, breaks the shield, kicks recharge)
  if (enemy.shield && enemy.shieldCharges > 0) {
    enemy.shieldCharges--
    enemy.shieldBreakFlash = SHIELD_BREAK_FLASH
    enemy.shieldJustBroken = true
    enemy.hitFlash = HIT_FLASH_DURATION
    enemy.shieldRechargeTimer = enemy.shieldRechargeTime
    playEnemyShieldBreak()
    startEnemyShieldFuseBurn(enemy.shieldRechargeTime)
    return
  }
  enemy.hp -= amount
  enemy.hitFlash = HIT_FLASH_DURATION
  // Reset shield recharge on HP damage (mirrors Player.hurtPlayer:217-220) — restart fuse audio too
  if (enemy.shield && enemy.shieldRechargeTimer > 0) {
    enemy.shieldRechargeTimer = enemy.shieldRechargeTime
    startEnemyShieldFuseBurn(enemy.shieldRechargeTime)
  }
  if (enemy.hp <= 0) {
    enemy.dying = true
    enemy.deathTimer = 0
    if (enemy.shield && enemy.shieldRechargeTimer > 0) stopEnemyShieldFuseBurn()
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

import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_EXPAND_TIME, RING_FIRE_LEAD_SEC } from '../core/PhaseSystem.ts'
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
import { clampToArena, resolveWallCollision, getArenaShape, ARENA_CX, ARENA_CY } from '../game/Arena.ts'
import { emit } from '../core/EventBus.ts'
import { PLAYER_RADIUS, HIT_FLASH_DURATION, SPAWN_ANIM_DURATION, HP_DRAIN_SPEED, CHILL_SLOW_PER_STACK, CHILL_STACK_DECAY_TIME, MAGNET_RANGE, BEAT_SEC, SHIELD_BREAK_FLASH, HEAVY_YIELD } from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import type { Player } from './Player.ts'
import type { EnemyType, MovePattern, SummonPhase, ShrinePhase, RangedPattern, RangedRotationMode, TetherTopology, ClusterLayer } from './EnemyTypes.ts'
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
  // Ranged mode — when on, beat-fire launches bullets that detonate this ring's properties
  // at their landing position instead of firing in place at the enemy.
  rangedMode: boolean
  rangedPattern: RangedPattern
  bulletCount: number
  bulletSpeed: number
  bulletLifetime: number
  surroundRadius: number
  spreadAngle: number
  rotationStep: number
  rotationMode: RangedRotationMode
  rotationAngle: number    // runtime state — accumulated angle for rotating patterns
  tracking: boolean
  trackingStrength: number // radians per second
  volleyMode: boolean
  volleyWindow: number     // seconds — total stagger duration across the salvo
  pushMode: boolean        // detonation = Reverb-style shock push (no damage ring)
  explodeMode: boolean     // detonation = volatile explosion (anim + sound), filled blast disc damage
  healMode: boolean        // explode variant: NOURISH instead of damage — heals player + enemies in range (gold VFX)
  staccato: boolean        // bullets freeze between beats and snap forward on each beat
  staccatoDivision: number // hops per beat: 1 = whole beat, 2 = half beat (eighth notes)
  staccatoPhase: number    // hop-grid phase shift in beats: 0 = on-beat, 0.5 = off-beat (&s)
  tetherMode: TetherTopology  // damage beams between bullets at the detonation beat
  tetherWidth: number      // beam thickness in px
  tetherSound: string      // sound played at tether strike (empty = silent)
  // Per-generation cluster states. Length = number of cluster generations (gen 1, gen 2, ...).
  // Each entry is a FULL RingState derived from the parent (this state's fields) merged with
  // its ClusterLayer overrides. Each has its OWN mutable rotation/edge state. When a bullet
  // detonates with layerIndex < childLayers.length, the next layer's RingState drives the
  // child salvo's pattern, count, push/tether, etc.
  childLayers: RingState[]
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
  healFlash: number     // >0 = recently healed; drives the gold heal halo + sparkle (mirror of player heal pulse)
  healAmount: number    // HP gained on the triggering heal — scales the halo intensity
  healSeenHp: number    // last HP the renderer observed (−1 sentinel); detects increases to fire the pulse
  deathTimer: number
  deathX: number        // position captured at the kill instant — death anim/body are pinned here so a
  deathY: number        // post-death position snap can't desync the dissolve from the volatile blast
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
  // Wall-spring launch impulse (px/s) — added to position each frame during launchTimer.
  // Bypasses immovable / immobile gates so springs shove every enemy uniformly.
  launchVx: number; launchVy: number; launchTimer: number
  // Chill Zone state (player upgrade). zoneSlowFrac is 0 or 0.5, set each frame by a presence
  // check against the player's active chill zone. immobileTimer > 0 means the enemy is frozen
  // in place (zero movement) but their attack/ring timers continue ticking normally — they're
  // still a threat. Triggered by an old chill zone's ice-shard burst when it gets replaced.
  // immobileJustBroke is a transient one-shot flag set the frame the timer crosses 0 — the
  // renderer consumes it to spawn the snowflake-shatter "breaking free" effect.
  zoneSlowFrac: number
  immobileTimer: number
  immobileJustBroke: boolean
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
  volatileHeal: boolean // volatile death blast NOURISHES instead — heals player + enemies in range (gold VFX)
  revenge: boolean      // fires rings after being hit
  revengeRings: number  // how many
  revengeRadius: number // ring radius
  revengeArmed: boolean // hit received, waiting for beat
  revengeTimer: number  // time since armed
  revengeAngle: number  // slowly rotating base angle for fire points
  // Pusher trait — pulses on-beat, kinematically shoves entities (no damage). Runtime
  // fields mirror the wall spring pattern so the firing/audio/grace logic in GameManager
  // can be shared.
  pusher: boolean
  pusherBeats: number          // cycle in beats
  pusherPhase: number          // beat offset
  pusherStrength: number       // launch velocity in px/s
  pusherLastFireBeat: number | null    // absolute beat of most recent fire (drives visuals + grace)
  pusherJustFired: boolean             // transient — consumed by renderer for one-shot effects
  pusherScheduledAudioBeat: number | null   // most recent beat we pre-scheduled audio for
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

// Build a child-layer RingState by cloning the parent's state, resetting mutable runtime
// fields, and applying any per-layer override. Mutable state (rotation, edge cycle, peak
// capture) is INDEPENDENT per layer so each generation's rotation/etc advances on its own.
// The `ring` field is shallow-cloned only when ringRadius is overridden (otherwise siblings
// share the same Ring object harmlessly — RingState doesn't mutate ring.radius).
function buildChildLayerState(parent: RingState, layer: ClusterLayer): RingState {
  const cloned: RingState = { ...parent }
  // Reset runtime state — each layer's rotation/edge cycle/etc is independent.
  cloned.attackTimer = -1
  cloned.rotationAngle = 0
  cloned.edgeIndex = 0
  cloned.edgeAngle = 0
  cloned.edgeBeatCount = 0
  cloned.peakX = 0
  cloned.peakY = 0
  cloned.peakCaptured = false
  cloned.childLayers = []
  // Apply overrides
  if (layer.rangedPattern !== undefined) cloned.rangedPattern = layer.rangedPattern
  if (layer.bulletCount !== undefined) cloned.bulletCount = layer.bulletCount
  if (layer.bulletSpeed !== undefined) cloned.bulletSpeed = layer.bulletSpeed
  if (layer.bulletLifetime !== undefined) cloned.bulletLifetime = layer.bulletLifetime
  if (layer.surroundRadius !== undefined) cloned.surroundRadius = layer.surroundRadius
  if (layer.spreadAngle !== undefined) cloned.spreadAngle = layer.spreadAngle
  if (layer.rotationStep !== undefined) cloned.rotationStep = layer.rotationStep
  if (layer.rotationMode !== undefined) cloned.rotationMode = layer.rotationMode
  if (layer.tracking !== undefined) cloned.tracking = layer.tracking
  if (layer.trackingStrength !== undefined) cloned.trackingStrength = layer.trackingStrength
  if (layer.volleyMode !== undefined) cloned.volleyMode = layer.volleyMode
  if (layer.volleyWindow !== undefined) cloned.volleyWindow = layer.volleyWindow
  if (layer.pushMode !== undefined) cloned.pushMode = layer.pushMode
  if (layer.explodeMode !== undefined) cloned.explodeMode = layer.explodeMode
  if (layer.healMode !== undefined) cloned.healMode = layer.healMode
  if (layer.staccato !== undefined) cloned.staccato = layer.staccato
  if (layer.staccatoHalfBeat !== undefined) cloned.staccatoDivision = layer.staccatoHalfBeat ? 2 : 1
  if (layer.staccatoOffbeat !== undefined) cloned.staccatoPhase = layer.staccatoOffbeat ? 0.5 : 0
  if (layer.tetherMode !== undefined) cloned.tetherMode = layer.tetherMode
  if (layer.tetherWidth !== undefined) cloned.tetherWidth = layer.tetherWidth
  if (layer.expandTime !== undefined) cloned.expandTime = layer.expandTime
  if (layer.sound !== undefined && layer.sound !== '') cloned.sound = layer.sound
  if (layer.tetherSound !== undefined && layer.tetherSound !== '') cloned.tetherSound = layer.tetherSound
  if (layer.ringRadius !== undefined) {
    // Need a new Ring object since ring.radius differs from parent's
    cloned.ring = { ...parent.ring, radius: layer.ringRadius }
  }
  return cloned
}

export function createEnemy(x: number, y: number, type: EnemyType): Enemy {
  // Build ring states from type config
  const ringConfigs = type.rings ?? [
    { ringRadius: type.ringRadius, sound: type.role, beats: [] }
  ]

  const rings: RingState[] = ringConfigs.map((rc, i) => {
    const baseState: RingState = {
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
      // Ranged mode — all optional in config, normalized to required RingState fields with
      // sensible defaults. `rangedMode: false` keeps existing per-ring behavior unchanged.
      rangedMode: rc.rangedMode ?? false,
      rangedPattern: (rc.rangedPattern ?? 'aimed') as RangedPattern,
      bulletCount: rc.bulletCount ?? 1,
      bulletSpeed: rc.bulletSpeed ?? 280,
      bulletLifetime: rc.bulletLifetime ?? 1.0,
      surroundRadius: rc.surroundRadius ?? 70,
      spreadAngle: rc.spreadAngle ?? Math.PI / 3,
      rotationStep: rc.rotationStep ?? 0,
      rotationMode: (rc.rotationMode ?? 'player_anchored') as RangedRotationMode,
      rotationAngle: 0,
      tracking: rc.tracking ?? false,
      trackingStrength: rc.trackingStrength ?? (Math.PI / 2),  // default 90°/s
      volleyMode: rc.volleyMode ?? false,
      volleyWindow: rc.volleyWindow ?? 0.25,
      pushMode: rc.pushMode ?? false,
      explodeMode: rc.explodeMode ?? false,
      healMode: rc.healMode ?? false,
      staccato: rc.staccato ?? false,
      staccatoDivision: rc.staccatoHalfBeat ? 2 : 1,
      staccatoPhase: rc.staccatoOffbeat ? 0.5 : 0,
      tetherMode: (rc.tetherMode ?? 'off') as TetherTopology,
      tetherWidth: rc.tetherWidth ?? 8,
      tetherSound: rc.tetherSound ?? '',
      childLayers: [],
    }
    // Migrate legacy `clusterSplits: N` to N empty-override layers (each gen inherits parent
    // fully — same fractal behavior the old field produced). New configs use clusterLayers
    // directly. Cap at 3.
    const layerConfigs: ClusterLayer[] = rc.clusterLayers
      ?? (rc.clusterSplits && rc.clusterSplits > 0
        ? Array.from({ length: Math.min(3, rc.clusterSplits) }, () => ({}))
        : [])
    // Each layer = a CLONED parent state with mutable runtime fields reset + overrides applied.
    // Layers chain inheritance: layer N starts from layer (N-1)'s resolved state, so unset
    // fields in later layers cascade from earlier ones.
    // ringRadius 0 means "no ring — relay/split only" for THAT layer. But a blank (inherit) child
    // shouldn't silently adopt a 0 ancestor and lose its own explosion — so for non-overridden
    // children we fall back to the nearest POSITIVE ancestor radius (or 120). An EXPLICIT 0 on a
    // child is still respected (it stays a relay).
    let prev = baseState
    let lastPositiveRadius = baseState.ring.radius > 0 ? baseState.ring.radius : 120
    for (const layer of layerConfigs.slice(0, 3)) {
      const next = buildChildLayerState(prev, layer)
      if (layer.ringRadius === undefined && next.ring.radius <= 0) {
        next.ring = { ...next.ring, radius: lastPositiveRadius }   // new obj — don't mutate the shared parent ring
      }
      if (next.ring.radius > 0) lastPositiveRadius = next.ring.radius
      baseState.childLayers.push(next)
      prev = next
    }
    return baseState
  })

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
    healFlash: 0,
    healAmount: 0,
    healSeenHp: -1,   // sentinel: first draw just records HP, never fires a spurious pulse
    deathTimer: -1,
    deathX: 0,
    deathY: 0,
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
    launchVx: 0, launchVy: 0, launchTimer: 0,
    zoneSlowFrac: 0,
    immobileTimer: 0,
    immobileJustBroke: false,
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
    volatileHeal: type.volatileHeal ?? false,
    revenge: type.revenge ?? false,
    revengeRings: type.revengeRings ?? 4,
    revengeRadius: type.revengeRadius ?? 120,
    revengeArmed: false,
    revengeTimer: 0,
    revengeAngle: 0,
    pusher: type.pusher ?? false,
    pusherBeats: type.pusherBeats ?? 2,
    pusherPhase: type.pusherPhase ?? 0,
    pusherStrength: type.pusherStrength ?? 600,
    pusherLastFireBeat: null,
    pusherJustFired: false,
    pusherScheduledAudioBeat: null,
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

// When a launched enemy (Reverb push, wall spring, pusher) is shoved back out of a wall/arena
// edge, don't just let the clamp eat the whole launch — strip only the INTO-wall component and
// keep the tangential part, so the enemy rides along the edge with whatever momentum its
// approach angle preserves (glancing hit = keeps most, head-on = keeps none). Mirrors how the
// player dash slides. (pushX, pushY) is the position correction the wall applied = outward
// normal, so it works for curved (circle) and straight/angled edges alike.
function slideLaunchAlongWall(enemy: Enemy, pushX: number, pushY: number): void {
  if (enemy.launchTimer <= 0) return
  const len2 = pushX * pushX + pushY * pushY
  if (len2 < 0.0001) return
  const inv = 1 / Math.sqrt(len2)
  const nx = pushX * inv
  const ny = pushY * inv
  const into = enemy.launchVx * nx + enemy.launchVy * ny   // <0 = launch driving into the wall
  if (into < 0) {
    enemy.launchVx -= into * nx
    enemy.launchVy -= into * ny
  }
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
  if (enemy.immobileTimer > 0) {
    enemy.immobileTimer -= dt
    if (enemy.immobileTimer <= 0) enemy.immobileJustBroke = true
  }
  // Wall-spring launch — additive position change, bypasses every movement gate including
  // immovable. Runs at the top of updateEnemy so heavy/spawning/immobile enemies still get
  // shoved when a wall springs. Wall resolution at the bottom of updateEnemy handles any
  // wall overlap the launch causes.
  if (enemy.launchTimer > 0) {
    enemy.launchTimer -= dt
    const decay = Math.pow(0.03, dt)   // snappier — matches Player
    enemy.launchVx *= decay
    enemy.launchVy *= decay
    const LAUNCH_FADE_TAIL = 0.10   // smooth fade — no abrupt snap (matches Player)
    const fadeMult = enemy.launchTimer < LAUNCH_FADE_TAIL
      ? Math.max(0, enemy.launchTimer / LAUNCH_FADE_TAIL)
      : 1
    enemy.x += enemy.launchVx * fadeMult * dt
    enemy.y += enemy.launchVy * fadeMult * dt
    if (enemy.launchTimer <= 0) {
      enemy.launchVx = 0; enemy.launchVy = 0; enemy.launchTimer = 0
    }
  }

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
      // Teleport at half-beat. Resolve walls AT TELEPORT TIME — walls may have moved since
      // the dest was computed at blink-start, and even if they hadn't, dest is only arena-
      // clamped (not wall-clamped). Without this, a moving wall over the dest swallows the
      // teleport: enemy lands inside the wall, wall collision pushes it out near its
      // original position, looking like the blink never happened.
      if (enemy.blinkPreview <= BEAT_SEC * 0.5 && enemy.blinkGhostX !== enemy.x) {
        const wr = resolveWallCollision(enemy.blinkGhostX, enemy.blinkGhostY, enemy.radius)
        enemy.x = wr.x
        enemy.y = wr.y
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

  // Immovable enemies skip all movement and separation — EXCEPT walls. A rotating/moving
  // wall must be able to shove a heavy out of its path; otherwise the wall passes through
  // the heavy (or the player gets crushed against an unmovable obstacle). Walls override
  // the immovable trait specifically for kinematic push-out.
  if (enemy.immovable) {
    const wpx = enemy.x, wpy = enemy.y
    const ewr = resolveWallCollision(enemy.x, enemy.y, enemy.radius)
    enemy.x = ewr.x
    enemy.y = ewr.y
    slideLaunchAlongWall(enemy, enemy.x - wpx, enemy.y - wpy)   // launched heavy rides the edge instead of stalling on it
    // Still update rings
    if (enemy.spawnTimer >= 1) {
      for (let i = 0; i < enemy.rings.length; i++) {
        const rs = enemy.rings[i]!
        // Per-ring lead: big rings (radius >= 200) fire EARLIER (lead 0.35) and expand for
        // longer (0.80), so peak still lands on the beat ((beat - 0.35) + 0.80 = beat + 0.45).
        const isBig = rs.ring.radius >= 200
        const ringLead = isBig ? 0.30 : RING_FIRE_LEAD_SEC
        if (shouldFire(rs.patternName, ringLead)) {
          const interval = getBeatInterval(rs.patternName)
          const baseExpand = isBig ? 0.75 : ATTACK_EXPAND_TIME
          rs.expandTime = Math.min(baseExpand, interval * 0.8)
          if (rs.rangedMode) {
            // Ranged mode — fire bullets instead of firing the ring in place. The ring's
            // attackTimer stays at -1 (idle). Detonation is handled by GameManager when the
            // bullet's lifetime expires.
            const origins = getRingOrigins(enemy, rs)
            for (const o of origins) emit('enemy:rangedFire', enemy, i, o.x, o.y)
          } else {
            rs.attackTimer = 0
            playWindup(rs.expandTime, false)
          }
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
    // Walls still push us — handle in case a moving wall sweeps across the spawn point
    const ewr = resolveWallCollision(enemy.x, enemy.y, enemy.radius)
    enemy.x = ewr.x
    enemy.y = ewr.y
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
      // Battering-ram separation: launched enemies plow through non-launched ones without
      // losing momentum. Symmetric, since each side runs its own pass:
      //   - immovable other → full self-push (unchanged, walls always stop you)
      //   - self launched, other not → 0 self-push (carry through, other's pass shoves it)
      //   - other launched, self not → full self-push (get out of the way)
      //   - both launched → half (mild mutual nudge, both phase, no permanent stack)
      //   - neither launched → half (current default)
      const launchedSelf = enemy.launchTimer > 0
      const launchedOther = otherEnemy.launchTimer > 0
      if (otherEnemy.immovable) {
        // Heavy yields HEAVY_YIELD so a normal trapped against / between heavies can carve its
        // own space. Without this, the normal's full self-push from each side oscillates
        // forever. Self takes the rest of the overlap.
        enemy.x += nx * overlap * (1 - HEAVY_YIELD)
        enemy.y += ny * overlap * (1 - HEAVY_YIELD)
        otherEnemy.x -= nx * overlap * HEAVY_YIELD
        otherEnemy.y -= ny * overlap * HEAVY_YIELD
      } else {
        let pushFrac: number
        if (launchedSelf && !launchedOther) pushFrac = 0
        else if (!launchedSelf && launchedOther) pushFrac = 1.0
        else if (launchedSelf && launchedOther) pushFrac = 0   // both flying (e.g. a Reverb-launched
          // ring) — phase through each other. Half-separating here makes the simultaneously-launched
          // ring shove inward on itself and cancel its own outward launch (worst for big enemies that
          // overlap many neighbors). They re-separate normally once both launches expire.
        else pushFrac = 0.5
        enemy.x += nx * overlap * pushFrac
        enemy.y += ny * overlap * pushFrac
      }
      if (isBounce) {
        const otherBounces = otherEnemy.movePattern === 'bounce'
        if (otherBounces) {
          // Bouncer-vs-bouncer: real elastic collision (equal mass). Exchange the normal-
          // component of velocity between the two. Tangential components stay unchanged.
          // The check `relVel < 0` (approaching along normal) means we only fire when they
          // are actually closing distance — fixes the old bug where same-direction overtakes
          // triggered weird reflections. Idempotent: after exchange they're moving apart so
          // B's own pass next iteration sees relVel >= 0 and skips.
          const dvx = enemy.bounceVx - otherEnemy.bounceVx
          const dvy = enemy.bounceVy - otherEnemy.bounceVy
          const relVel = dvx * nx + dvy * ny
          if (relVel < 0) {
            enemy.bounceVx -= relVel * nx
            enemy.bounceVy -= relVel * ny
            otherEnemy.bounceVx += relVel * nx
            otherEnemy.bounceVy += relVel * ny
          }
        } else {
          // Bouncer vs non-bouncer: treat other as a wall (current per-self reflection).
          const dot = enemy.bounceVx * nx + enemy.bounceVy * ny
          if (dot < 0) {
            enemy.bounceVx -= 2 * dot * nx
            enemy.bounceVy -= 2 * dot * ny
          }
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
      // Asymmetric elastic collision — player is treated as infinite mass (their velocity
      // is preserved, the bouncer takes all the momentum exchange). Uses this-frame's
      // player motion (player.x - player.prevX) / dt as the player velocity, so all motion
      // sources count (WASD input, dash, launch impulses, recall). When player charges INTO
      // the bouncer the bouncer gets punted away harder; when player moves AWAY or parallel
      // it barely affects the bouncer (just normal wall-bounce off a stationary surface).
      const playerVx = dt > 0 ? (player.x - player.prevX) / dt : 0
      const playerVy = dt > 0 ? (player.y - player.prevY) / dt : 0
      const relVel = (enemy.bounceVx - playerVx) * pnx + (enemy.bounceVy - playerVy) * pny
      if (relVel < 0) {
        enemy.bounceVx -= 2 * relVel * pnx
        enemy.bounceVy -= 2 * relVel * pny
      }
    }
  }
  } // end shrine/dasher player-push skip

  // Preserve bounce speed — reflections / elastic exchanges can drop the magnitude. Rescale
  // back to moveSpeed each frame. If the bouncer stopped dead (e.g. an unlucky perfect-
  // collinear head-on momentum exchange), kick it with a small random nudge so it doesn't
  // freeze permanently (the normalization-skip below 0.1 used to leave it stranded).
  if (isBounce) {
    let bSpeed = Math.sqrt(enemy.bounceVx * enemy.bounceVx + enemy.bounceVy * enemy.bounceVy)
    if (bSpeed < 0.1) {
      const a = Math.random() * Math.PI * 2
      enemy.bounceVx = Math.cos(a)
      enemy.bounceVy = Math.sin(a)
      bSpeed = 1
    }
    const targetSpeed = enemy.moveSpeed
    const scale = targetSpeed / bSpeed
    enemy.bounceVx *= scale
    enemy.bounceVy *= scale
  }

  // Apply chill slow + integrate position. Skip when mid-dodge — applyDashMotion already moved us.
  // Chill Zone interaction: zoneSlowFrac (0 or 0.5) and frostbite stacks combine via max() so
  // the two slow sources don't sum to 100% (which would overlap with the immobility mechanic).
  // immobileTimer > 0 hard-zeros movement regardless of other slow values — total takeover.
  const stackedSlow = enemy.chillStacks * CHILL_SLOW_PER_STACK
  const effectiveSlow = Math.max(stackedSlow, enemy.zoneSlowFrac)
  const chillMult = enemy.immobileTimer > 0 ? 0 : (1 - effectiveSlow)
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
  if (clamped.x !== prevX || clamped.y !== prevY) {
    slideLaunchAlongWall(enemy, clamped.x - prevX, clamped.y - prevY)   // ride the arena edge instead of stalling on it
  }
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
  // Wall collision — push out of any internal walls in the arena. Runs once per frame
  // (enemy speeds are well below per-frame wall thickness, so substepping isn't needed).
  // For bouncer enemies, also reflect bounceVx/bounceVy about the push direction (which is
  // the wall normal at the contact point) so they bounce off internal walls just like they
  // bounce off arena edges.
  const wallPreX = enemy.x
  const wallPreY = enemy.y
  const ewr = resolveWallCollision(enemy.x, enemy.y, enemy.radius)
  enemy.x = ewr.x
  enemy.y = ewr.y
  slideLaunchAlongWall(enemy, enemy.x - wallPreX, enemy.y - wallPreY)   // ride internal walls instead of stalling on them
  if (isBounce) {
    const pushX = enemy.x - wallPreX
    const pushY = enemy.y - wallPreY
    const pushLen2 = pushX * pushX + pushY * pushY
    if (pushLen2 > 0.0001) {
      const pushLen = Math.sqrt(pushLen2)
      const nx = pushX / pushLen
      const ny = pushY / pushLen
      // Only flip when moving INTO the wall — guards against double-flip on consecutive frames
      const dot = enemy.bounceVx * nx + enemy.bounceVy * ny
      if (dot < 0) {
        enemy.bounceVx -= 2 * dot * nx
        enemy.bounceVy -= 2 * dot * ny
        // Re-normalize to constant speed
        const bs = Math.sqrt(enemy.bounceVx * enemy.bounceVx + enemy.bounceVy * enemy.bounceVy)
        if (bs > 0.1) {
          enemy.bounceVx = (enemy.bounceVx / bs) * enemy.moveSpeed
          enemy.bounceVy = (enemy.bounceVy / bs) * enemy.moveSpeed
        }
      }
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
      const isBig2 = rs.ring.radius >= 200
      const ringLead2 = isBig2 ? 0.30 : RING_FIRE_LEAD_SEC
      if (shouldFire(rs.patternName, ringLead2)) {
        const interval = getBeatInterval(rs.patternName)
        const baseExpand = isBig2 ? 0.75 : ATTACK_EXPAND_TIME
        rs.expandTime = Math.min(baseExpand, interval * 0.8)
        if (rs.rangedMode) {
          // Ranged mode — emit fire event; GameManager spawns bullets. Ring's attackTimer
          // stays idle. Edge mode still advances below so the bullet origin rotates.
          const origins = getRingOrigins(enemy, rs)
          for (const o of origins) emit('enemy:rangedFire', enemy, i, o.x, o.y)
        } else {
          rs.attackTimer = 0
          rs.peakCaptured = false
          playWindup(rs.expandTime, false)
        }
        // Edge mode: advance point after N beats (applies regardless of ranged mode)
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
    enemy.deathX = enemy.x   // pin the death spot NOW (before any post-death position snap)
    enemy.deathY = enemy.y
    if (enemy.shield && enemy.shieldRechargeTimer > 0) stopEnemyShieldFuseBurn()
    emit('enemy:killed', enemy)
  }
}

export function updateDeath(enemy: Enemy, dt: number): void {
  if (!enemy.dying) return
  // Pin the dying enemy to its captured death spot — some pass shoves it ~one radius right after
  // death (worse for big/fast bouncers), which would slide the death dissolve away from the volatile
  // blast. Holding the position keeps body, particles, and explosion all on the true death point.
  enemy.x = enemy.deathX
  enemy.y = enemy.deathY
  enemy.deathTimer += dt
  if (enemy.deathTimer >= DEATH_DURATION) {
    enemy.alive = false
  }
}

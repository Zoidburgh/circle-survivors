export type MovePattern = 'pursue' | 'orbit' | 'zigzag' | 'stationary' | 'bounce' | 'lunge' | 'immovable'
// Weak-node movement patterns (see boss_nodes_plan.md). All evaluated by Enemy.nodeWorldPos().
export type WeakNodePattern = 'orbit' | 'breathe' | 'multiRadius' | 'figure8' | 'beatHop'

export type RangedPattern = 'aimed' | 'surround_player' | 'radial' | 'spread_cone' | 'rotating'
export type RangedRotationMode = 'turret' | 'player_anchored' | 'oscillate'
export type TetherTopology = 'off' | 'closed' | 'open' | 'pairs' | 'star' | 'all'

// Partial RingConfig — one cluster generation's overrides. Any field omitted falls through to
// the previous layer (or to the base ring for Layer 0). Lets each generation have its own
// pattern, count, push mode, tether topology, etc., while sharing whatever isn't overridden.
export interface ClusterLayer {
  rangedPattern?: RangedPattern
  bulletCount?: number
  bulletSpeed?: number
  bulletLifetime?: number
  surroundRadius?: number
  spreadAngle?: number
  rotationStep?: number
  rotationMode?: RangedRotationMode
  tracking?: boolean
  trackingStrength?: number
  volleyMode?: boolean
  volleyWindow?: number
  pushMode?: boolean
  explodeMode?: boolean        // detonate with the volatile explosion (anim + sound), filled blast disc damage
  healMode?: boolean           // explode variant: NOURISH instead of damage — heals player + enemies in range by 1 (gold VFX)
  staccato?: boolean
  staccatoHalfBeat?: boolean   // hop on every HALF beat (eighth notes) instead of every whole beat
  staccatoOffbeat?: boolean    // shift the hop grid half a beat — bullets stop on the OFF-beats (the &s), not the downbeats
  tetherMode?: TetherTopology
  tetherWidth?: number
  ringRadius?: number
  expandTime?: number
  sound?: string                     // per-layer ring-peak damage sound. Unset = inherit from previous layer / base ring.
  tetherSound?: string               // per-layer tether-strike damage sound. Unset = inherit.
}

export interface RingConfig {
  ringRadius: number
  sound: string
  beats: number[]
  edgeMode?: boolean          // fire from edge of enemy body
  edgePoints?: number         // equidistant points on edge (default: 3)
  edgeActive?: number         // how many fire at once (default: 1, max = edgePoints = all at once)
  edgeSwitchBeats?: number    // beats between switching point (default: 1)
  // ── Ranged mode ──
  // When true, the ring's beat-fire launches a BULLET (or bullet salvo) instead of firing in
  // place. After bulletLifetime seconds, the bullet detonates a one-shot AOE using THIS ring's
  // ringRadius / expandTime / color at the bullet's landing position. Plays well with edgeMode
  // (edge cycle still applies; salvo launches from current edge point).
  rangedMode?: boolean
  rangedPattern?: RangedPattern        // default 'aimed'
  bulletCount?: number                 // default 1 (1 for aimed/rotating, 3-8 for others)
  bulletSpeed?: number                 // default 280 px/s
  bulletLifetime?: number              // default 1.0 sec — travel time before detonation
  surroundRadius?: number              // for 'surround_player' — distance from player (default 70)
  spreadAngle?: number                 // for 'spread_cone' — total cone width in radians (default π/3)
  rotationStep?: number                // angle added per fire — applies to ANY pattern (default 0)
  rotationMode?: RangedRotationMode    // default 'player_anchored'
  // Mid-flight tracking — bullets steer their velocity vector toward the player's CURRENT
  // position each frame, limited by trackingStrength (radians/sec). Off by default. Most
  // natural for aimed/spread/rotating; overrides the pattern's spatial intent on radial and
  // surround_player (works but breaks their formation).
  tracking?: boolean
  trackingStrength?: number            // radians per second (designer UI exposes degrees/sec; default ~90°/s)
  // Volley — stagger the launch of the salvo over a short window, but adjust each bullet's
  // lifetime so ALL detonations land on the SAME beat. With bulletCount = 1 it's a no-op.
  // For fixed-speed patterns (aimed, radial, spread_cone, rotating) staggered bullets travel
  // DIFFERENT distances and detonate in a line/fan all at once. For surround_player the
  // velocity is recomputed per bullet so they all still land at the target ring around the
  // player. Composes with tracking, edgeMode, rotation.
  volleyMode?: boolean
  volleyWindow?: number                // total stagger duration in seconds (default 0.25)
  // Cluster — when a bullet detonates, spawn another salvo using THIS ring's config from
  // the detonation point. Each child bullet inherits the same pattern, count, speed,
  // lifetime, tracking, volley, ringRadius, damage. `clusterSplits` counts the number of
  // generations of children (0 = no cluster, 1 = parent → children, 2 = + grandchildren,
  // 3 = + great-grandchildren). Capped at 3 to avoid factorial blow-up (e.g. radial 5
  // with 3 splits = 5 + 25 + 125 + 625 = 780 bullets in flight). Stacks with everything.
  clusterSplits?: number              // LEGACY — auto-migrated to clusterLayers at createEnemy time. Kept so old saved configs still load.
  // Cluster layer overrides — one entry per child generation (length 0..3). Each entry is a
  // PARTIAL ring config: unset fields inherit from the previous layer (Layer 0 is the
  // parent ring itself). With `clusterLayers: [{}, {}]` you get the classic 2-gen fractal
  // (children fire same pattern as parent). With `[{ pattern: 'aimed', bulletCount: 3 }, {}]`
  // gen 1 children fire aimed × 3 from each parent's landing, gen 2 inherits gen 1.
  clusterLayers?: ClusterLayer[]
  // Push mode — the detonation REPLACES the normal expanding ring with a Reverb-style
  // shock-push wave in the ring's color. No damage at peak (push only); shoves the player
  // + nearby enemies + orbs outward in lockstep with the visual front. Push radius = the
  // ring's ringRadius. Push strength scales with ringRadius so bigger rings hit harder.
  // Stacks with everything (volley, cluster, tracking, etc).
  pushMode?: boolean
  // Explode mode — the detonation REPLACES the expanding ring with the volatile-enemy explosion
  // (same animation + sound as when something blows up on death). Still damages the player, but as
  // a FILLED blast disc (hit if within ringRadius) rather than a ring edge. ringRadius = blast
  // radius, exactly like push uses it for its shove radius.
  explodeMode?: boolean
  // Heal mode — explode variant that NOURISHES instead of harming. Same telegraph + blast disc
  // geometry + on-beat timing as explode, but it HEALS the player AND any enemies in range by 1 HP
  // (capped at maxHp) and is recolored gold with a soft chime. Only meaningful when explodeMode is on.
  healMode?: boolean
  // Staccato — the bullet doesn't glide; it FREEZES between beats and snaps forward on each
  // global beat, dividing its flight into beat-aligned hops that still land on the detonation
  // beat. Movement-only (detonation/push/tether unchanged). Hops lock to the global grid so
  // volley/cluster siblings stay in unison. Pure rhythm-game read: dodge in the frozen gaps.
  staccato?: boolean
  staccatoHalfBeat?: boolean   // hop on every HALF beat (eighth notes) instead of every whole beat
  staccatoOffbeat?: boolean    // shift the hop grid half a beat — bullets stop on the OFF-beats (the &s), not the downbeats
  // Tether — at the salvo's detonation beat, bright damaging BEAMS snap between connected
  // bullets in a topology of your choice. Pattern's geometric SHAPE becomes the threat
  // (radial 5 closed-chain = damage pentagon; spread_cone 5 closed = arc segment; surround
  // closed = a cage around the player). Beams flash for ~0.15s + damage anyone the segment
  // touches once. Needs ≥2 bullets (no-op with 1). Each child salvo from cluster forms its
  // own tether at its own detonation beat — geometric recursion.
  tetherMode?: TetherTopology
  tetherWidth?: number           // beam thickness in px (default 8 — fatter than a normal ring stroke so the tether reads as a beam, not just a line)
  tetherSound?: string           // sound played when the tether strikes (deals damage). Defaults to silent if unset.
}

export interface EnemyType {
  name: string
  color: string
  hp: number
  moveSpeed: number
  radius: number
  ringRadius: number    // kept for backwards compat / default ring
  key: string
  role: string
  rings?: RingConfig[]
  blocksRings?: boolean
  movePattern?: MovePattern
  totemSpawn?: string          // if set, this is a totem — name of enemy type it spawns on player hit
  dropType?: 'xp' | 'hp' | 'none'  // legacy — use dropXp/dropHp instead
  dropXp?: number                   // 0-100 chance to drop XP orb (default: 100)
  dropHp?: number                   // 0-100 chance to drop HP orb (default: 0)
  dropCount?: number                // how many orbs to drop (default: 1, max 10)
  consume?: boolean                 // ring attack consumes nearby orbs, heals +1 per orb
  magnet?: boolean                  // pulls nearby orbs toward this enemy
  magnetRange?: number              // custom pull range (default: MAGNET_RANGE from constants)
  blink?: boolean                   // teleports to opposite side of player periodically
  blinkBeats?: number               // beats between blinks (default: 4)
  volatile?: boolean                // explodes on death, damages nearby enemies + player
  volatileRange?: number            // explosion radius (default: 150)
  volatileHeal?: boolean            // volatile variant: death blast NOURISHES instead — heals player + enemies in range by 1 (gold VFX)
  revenge?: boolean                 // fires rings on next beat after being hit
  revengeRings?: number             // how many rings fire (default: 4)
  revengeRadius?: number            // ring attack radius (default: 120)
  pusher?: boolean                  // pulses on-beat, kinematically shoves nearby entities (no damage)
  pusherBeats?: number              // cycle length in beats between fires (default: 2)
  pusherPhase?: number              // beat offset for the fire moment (default: 0)
  pusherStrength?: number           // launch velocity in px/s (default: 600) — same units as wall springs
  dodge?: boolean                   // intelligently dodges player rings via charged sidesteps
  dodgeCharges?: number             // number of dodge orbs (default: 2)
  dodgeChargeTime?: number          // seconds to recharge one slot (default: 1.5)
  dodgeDistance?: number            // how far each dodge moves (default: 100)
  dodgeSpeed?: number               // burst speed multiplier (default: 1.0)
  shield?: boolean                  // absorbs one hit per charge, recharges over time
  shieldRechargeTime?: number       // seconds to recharge shield after break (default: 4)
  // Weak-node trait — body invulnerable; break all moving nodes to kill (see boss_nodes_plan.md)
  weakNodes?: boolean
  weakNodeCount?: number            // how many nodes (default 3)
  weakNodeHp?: number               // hits to break each node (default 3)
  weakNodeOrbitFrac?: number        // orbit radius ÷ enemy.radius (default 0.55 — inside the body)
  weakNodeSizeFrac?: number         // node radius ÷ enemy.radius (default 0.30)
  weakNodePattern?: WeakNodePattern // movement pattern (default 'orbit')
  weakNodeSpeed?: number            // pattern speed multiplier (default 1)
  weakNodeAmp?: number              // breathe / figure8 amplitude (default 0.3)
  summon?: boolean                  // has orbiting ritual nodes, phased spawning
  summonNodes?: number              // how many nodes (3 = triangle, 5 = pentagon, default 3)
  summonPhases?: SummonPhase[]      // each phase = one completed sequence, spawns enemies
  isShrine?: boolean                // ritual station — beat-dash while fully inside to activate
  shrineSpawnEnemy?: string         // LEGACY — use shrinePhases instead
  shrineXpCount?: number            // LEGACY
  shrineHpCount?: number            // LEGACY
  shrinePhases?: ShrinePhase[]      // per-hit spawn waves
}

export interface SummonPhase {
  spawns: { enemyName: string; count: number }[]
}

export interface ShrinePhase {
  spawnEnemy?: string    // enemy type to spawn (empty = none)
  spawnCount?: number    // how many (default 1)
  xpOrbs?: number        // XP orbs this phase
  hpOrbs?: number        // HP orbs this phase
  isShop?: boolean       // opens shop instead of spawning
}

/** Look up an enemy type by name */
export function getEnemyType(name: string): EnemyType | undefined {
  return ENEMY_TYPES.find(t => t.name === name)
}

export const ENEMY_TYPES: EnemyType[] = []

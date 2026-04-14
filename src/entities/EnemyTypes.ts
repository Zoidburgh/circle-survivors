export type MovePattern = 'pursue' | 'orbit' | 'zigzag' | 'stationary' | 'bounce' | 'lunge' | 'immovable'

export interface RingConfig {
  ringRadius: number
  sound: string
  beats: number[]
  edgeMode?: boolean          // fire from edge of enemy body
  edgePoints?: number         // equidistant points on edge (default: 3)
  edgeActive?: number         // how many fire at once (default: 1, max = edgePoints = all at once)
  edgeSwitchBeats?: number    // beats between switching point (default: 1)
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
  revenge?: boolean                 // fires rings on next beat after being hit
  revengeRings?: number             // how many rings fire (default: 4)
  revengeRadius?: number            // ring attack radius (default: 120)
  summon?: boolean                  // has orbiting ritual nodes, phased spawning
  summonNodes?: number              // how many nodes (3 = triangle, 5 = pentagon, default 3)
  summonPhases?: SummonPhase[]      // each phase = one completed sequence, spawns enemies
}

export interface SummonPhase {
  spawns: { enemyName: string; count: number }[]
}

/** Look up an enemy type by name */
export function getEnemyType(name: string): EnemyType | undefined {
  return ENEMY_TYPES.find(t => t.name === name)
}

export const ENEMY_TYPES: EnemyType[] = []

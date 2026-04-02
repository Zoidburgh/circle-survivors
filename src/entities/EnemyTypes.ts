export type MovePattern = 'pursue' | 'orbit' | 'zigzag' | 'stationary' | 'bounce' | 'lunge' | 'immovable'

export interface RingConfig {
  ringRadius: number
  sound: string
  beats: number[]
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
  dropType?: 'xp' | 'hp' | 'none'  // what orb to drop on kill (default: 'xp')
  consume?: boolean                 // ring attack consumes nearby orbs, heals +1 per orb
  magnet?: boolean                  // pulls nearby orbs toward this enemy
  magnetRange?: number              // custom pull range (default: MAGNET_RANGE from constants)
  blink?: boolean                   // teleports to opposite side of player periodically
  blinkBeats?: number               // beats between blinks (default: 4)
}

/** Look up an enemy type by name */
export function getEnemyType(name: string): EnemyType | undefined {
  return ENEMY_TYPES.find(t => t.name === name)
}

export const ENEMY_TYPES: EnemyType[] = [
  {
    name: 'Offbeat',
    color: '#FF9800',
    hp: 3,
    moveSpeed: 40,
    radius: 44,
    ringRadius: 140,
    key: '1',
    role: 'rim',
    rings: [
      { ringRadius: 140, sound: 'rim', beats: [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5] },
    ],
    movePattern: 'pursue',
  },
]

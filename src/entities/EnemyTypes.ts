export type MovePattern = 'pursue' | 'orbit' | 'zigzag' | 'stationary' | 'bounce' | 'lunge'

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

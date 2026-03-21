export interface EnemyType {
  name: string        // matches pattern key in SongPatterns
  color: string
  hp: number
  moveSpeed: number
  radius: number
  ringRadius: number
  key: string
  role: string        // instrument description
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
  },
]

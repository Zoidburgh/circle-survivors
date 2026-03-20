import { BEAT_SEC } from '../utils/constants.ts'

export interface EnemyType {
  name: string
  tempo: number
  color: string
  audioFreq: number
  hp: number
  moveSpeed: number
  radius: number
  ringRadius: number
  key: string
}

export const ENEMY_TYPES: EnemyType[] = [
  {
    name: 'Whole',
    tempo: BEAT_SEC * 4,
    color: '#EF5350',
    audioFreq: 80,
    hp: 5,
    moveSpeed: 20,
    radius: 64,
    ringRadius: 220,
    key: '1',
  },
  {
    name: 'Half',
    tempo: BEAT_SEC * 2,
    color: '#FF9800',
    audioFreq: 130,
    hp: 3,
    moveSpeed: 40,
    radius: 52,
    ringRadius: 160,
    key: '2',
  },
  {
    name: 'Quarter',
    tempo: BEAT_SEC * 1,
    color: '#FFEB3B',
    audioFreq: 220,
    hp: 2,
    moveSpeed: 70,
    radius: 44,
    ringRadius: 110,
    key: '3',
  },
  {
    name: 'Eighth',
    tempo: BEAT_SEC * 0.5,
    color: '#66BB6A',
    audioFreq: 370,
    hp: 1,
    moveSpeed: 120,
    radius: 36,
    ringRadius: 70,
    key: '4',
  },
  {
    name: 'Sixteenth',
    tempo: BEAT_SEC * 0.25,
    color: '#AB47BC',
    audioFreq: 520,
    hp: 1,
    moveSpeed: 180,
    radius: 28,
    ringRadius: 45,
    key: '5',
  },
]

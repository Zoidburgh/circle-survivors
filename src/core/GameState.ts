import { createPlayer } from '../entities/Player.ts'
import type { Player } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { SpatialGrid } from './SpatialGrid.ts'

// ── Central game state ──
const player: Player = createPlayer(640, 360)
const enemies: Enemy[] = []
const grid = new SpatialGrid(150) // cell size ~= largest enemy diameter

export function getPlayer(): Player {
  return player
}

export function getEnemies(): Enemy[] {
  return enemies
}

export function getGrid(): SpatialGrid {
  return grid
}

import { createPlayer, resetPlayer } from '../entities/Player.ts'
import { resetRitualNodes } from '../game/RitualNodes.ts'
import type { Player } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { SpatialGrid } from './SpatialGrid.ts'
import { createCamera, ARENA_W, ARENA_H } from '../game/Arena.ts'
import type { Camera } from '../game/Arena.ts'
import { GRID_CELL_SIZE } from '../utils/constants.ts'

export type GamePhase = 'playing' | 'upgrading' | 'shopping'

const player: Player = createPlayer(ARENA_W / 2, ARENA_H / 2)
const enemies: Enemy[] = []
const grid = new SpatialGrid(GRID_CELL_SIZE)
const camera: Camera = createCamera()
let phase: GamePhase = 'playing'
let xpForNextLevel = 15
let level = 1

export function getPlayer(): Player { return player }
export function getEnemies(): Enemy[] { return enemies }
export function getGrid(): SpatialGrid { return grid }
export function getCamera(): Camera { return camera }
export function getPhase(): GamePhase { return phase }
export function setPhase(p: GamePhase): void { phase = p }
export function getLevel(): number { return level }
export function getXpForNextLevel(): number { return xpForNextLevel }

export function checkLevelUp(): boolean {
  if (player.xp >= xpForNextLevel) {
    player.xp -= xpForNextLevel
    level++
    xpForNextLevel = 15 // flat for testing, curve later
    return true
  }
  return false
}

/** Reset all game state for a new run */
export function resetGameState(): void {
  resetPlayer(player)
  enemies.length = 0
  grid.clear()
  const cam = camera
  cam.x = ARENA_W / 2
  cam.y = ARENA_H / 2
  cam.targetX = ARENA_W / 2
  cam.targetY = ARENA_H / 2
  phase = 'playing'
  xpForNextLevel = 15
  level = 1
  resetRitualNodes()
}

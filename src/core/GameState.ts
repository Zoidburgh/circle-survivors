import { createPlayer, resetPlayer } from '../entities/Player.ts'
import { resetRitualNodes } from '../game/RitualNodes.ts'
import { resetOrbs } from '../entities/XPOrb.ts'
import type { Player } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { SpatialGrid } from './SpatialGrid.ts'
import { createCamera, ARENA_W, ARENA_H } from '../game/Arena.ts'
import type { Camera } from '../game/Arena.ts'
import { GRID_CELL_SIZE } from '../utils/constants.ts'

export type GamePhase = 'title' | 'playing' | 'upgrading' | 'shopping' | 'dead'

const player: Player = createPlayer(ARENA_W / 2, ARENA_H / 2)
const enemies: Enemy[] = []
const grid = new SpatialGrid(GRID_CELL_SIZE)
const camera: Camera = createCamera()
let phase: GamePhase = 'title'
let xpForNextLevel = 15
let level = 1
let runTimer = 0         // seconds elapsed
let runTimerActive = false
let runComplete = false
let runFinalTime = 0

export function getPlayer(): Player { return player }
export function getEnemies(): Enemy[] { return enemies }
export function getGrid(): SpatialGrid { return grid }
export function getCamera(): Camera { return camera }
export function getPhase(): GamePhase { return phase }
export function setPhase(p: GamePhase): void { phase = p }
export function getLevel(): number { return level }
export function getXpForNextLevel(): number { return xpForNextLevel }
export function getRunTimer(): number { return runTimer }
export function isRunTimerActive(): boolean { return runTimerActive }
export function isRunComplete(): boolean { return runComplete }
export function getRunFinalTime(): number { return runFinalTime }
export function startRunTimer(): void { runTimerActive = true; runTimer = 0 }
export function advanceRunTimer(dt: number): void { if (runTimerActive) runTimer += dt }
export function completeRun(): void { runTimerActive = false; runComplete = true; runFinalTime = runTimer }

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
  runTimer = 0
  runTimerActive = false
  runComplete = false
  runFinalTime = 0
  resetRitualNodes()
  resetOrbs()
}

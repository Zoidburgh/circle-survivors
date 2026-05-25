import { createPlayer, resetPlayer } from '../entities/Player.ts'
import { resetRitualNodes } from '../game/RitualNodes.ts'
import { resetOrbs } from '../entities/XPOrb.ts'
import { stopShieldFuseBurn } from '../audio/AudioEngine.ts'
import { resetRenderer } from '../render/Renderer.ts'
import { resetPendingEffects } from './GameManager.ts'
import type { Player } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { SpatialGrid } from './SpatialGrid.ts'
import { createCamera, ARENA_W, ARENA_H } from '../game/Arena.ts'
import type { Camera } from '../game/Arena.ts'
import { GRID_CELL_SIZE } from '../utils/constants.ts'

export type GamePhase = 'title' | 'challenge_select' | 'playing' | 'upgrading' | 'shopping' | 'paused' | 'dead' | 'entering_name' | 'designer'

const player: Player = createPlayer(ARENA_W / 2, ARENA_H / 2)
const enemies: Enemy[] = []
const grid = new SpatialGrid(GRID_CELL_SIZE)
const camera: Camera = createCamera()
let phase: GamePhase = 'title'
let designerReturnPhase: GamePhase = 'title'
let designerPrevArenaShape: string | null = null
let inDesignerTestPlay = false
let xpForNextLevel = 15
let level = 1
let runTimer = 0         // seconds elapsed
let runTimerActive = false
let runComplete = false
let runFinalTime = 0
let runBeatCount = 0     // counts player beats since timer started

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
export function startRunTimer(): void {
  // Never start the run timer outside actual play. Designer authoring should not start the
  // clock just because the user spawned a test enemy that fires a summon or takes a beat-dash hit.
  if (phase !== 'playing') return
  runTimerActive = true; runTimer = 0; runBeatCount = 0
}
export function incrementRunBeat(): void { if (runTimerActive) runBeatCount++ }
export function getRunBeatCount(): number { return runBeatCount }
export function advanceRunTimer(dt: number): void { if (runTimerActive) runTimer += dt }
export function completeRun(): void { runTimerActive = false; runComplete = true; runFinalTime = runTimer }

export function enterDesigner(from: GamePhase): void {
  designerReturnPhase = from
  phase = 'designer'
}
export function exitDesigner(): void {
  phase = designerReturnPhase
}
export function getDesignerReturnPhase(): GamePhase { return designerReturnPhase }
export function setDesignerPrevArenaShape(s: string | null): void { designerPrevArenaShape = s }
export function getDesignerPrevArenaShape(): string | null { return designerPrevArenaShape }
export function setInDesignerTestPlay(b: boolean): void { inDesignerTestPlay = b }
export function isInDesignerTestPlay(): boolean { return inDesignerTestPlay }

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
export function resetGameState(targetPhase: GamePhase = 'playing'): void {
  resetPlayer(player)
  enemies.length = 0
  grid.clear()
  const cam = camera
  cam.x = ARENA_W / 2
  cam.y = ARENA_H / 2
  cam.targetX = ARENA_W / 2
  cam.targetY = ARENA_H / 2
  phase = targetPhase
  xpForNextLevel = 15
  level = 1
  runTimer = 0
  runTimerActive = false
  runComplete = false
  runFinalTime = 0
  runBeatCount = 0
  resetRitualNodes()
  resetOrbs()
  stopShieldFuseBurn()
  resetRenderer()
  resetPendingEffects()
}

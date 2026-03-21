import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer } from '../entities/Player.ts'
import { updateEnemy, updateDeath } from '../entities/Enemy.ts'
import { advanceGlobalTime } from './RhythmClock.ts'
import { updatePreviewEnemy } from '../game/EnemyDesigner.ts'
import { advancePatternClock } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies, getGrid, getCamera } from './GameState.ts'
import { updateOrbs, cleanupOrbs } from '../entities/XPOrb.ts'
import { updateCamera } from '../game/Arena.ts'

let fps = 0
let frameCount = 0
let lastFpsTime = performance.now()

export function update(dt: number): void {
  const player = getPlayer()
  const enemies = getEnemies()
  const grid = getGrid()
  const cam = getCamera()

  Input.flush()
  advanceGlobalTime(dt)
  advancePatternClock(dt)
  updatePreviewEnemy(dt)
  updatePlayer(player, dt)

  // Update camera — lead toward movement direction
  const dir = Input.getMovementDir()
  updateCamera(cam, player.x, player.y, dir.x, dir.y, window.innerWidth, window.innerHeight, dt)

  // Rebuild spatial grid
  grid.clear()
  for (const enemy of enemies) {
    if (enemy.alive) grid.insert(enemy)
  }

  for (const enemy of enemies) {
    updateDeath(enemy, dt)
    updateEnemy(enemy, player, dt, grid)
  }

  // XP orbs — physics push by player and enemies
  updateOrbs(dt, player.x, player.y, enemies)
  cleanupOrbs()
}

export function render(alpha: number): void {
  const player = getPlayer()
  const enemies = getEnemies()
  const cam = getCamera()

  frameCount++
  const now = performance.now()
  if (now - lastFpsTime >= 1000) {
    fps = frameCount
    frameCount = 0
    lastFpsTime = now
  }
  Renderer.render(player, enemies, alpha, fps, 1 / 60, cam)
}

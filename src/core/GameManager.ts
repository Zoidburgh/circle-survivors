import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer } from '../entities/Player.ts'
import { updateEnemy, updateDeath } from '../entities/Enemy.ts'
import { advanceGlobalTime } from './RhythmClock.ts'
import { getPlayer, getEnemies, getGrid } from './GameState.ts'

// ── FPS counter ──
let fps = 0
let frameCount = 0
let lastFpsTime = performance.now()

export function update(dt: number): void {
  const player = getPlayer()
  const enemies = getEnemies()
  const grid = getGrid()

  Input.flush()
  advanceGlobalTime(dt)
  updatePlayer(player, dt)

  // Rebuild spatial grid each frame
  grid.clear()
  for (const enemy of enemies) {
    if (enemy.alive) grid.insert(enemy)
  }

  for (const enemy of enemies) {
    updateDeath(enemy, dt)
    updateEnemy(enemy, player, dt, grid)
  }
}

export function render(alpha: number): void {
  const player = getPlayer()
  const enemies = getEnemies()

  frameCount++
  const now = performance.now()
  if (now - lastFpsTime >= 1000) {
    fps = frameCount
    frameCount = 0
    lastFpsTime = now
  }
  Renderer.render(player, enemies, alpha, fps, 1 / 60)
}

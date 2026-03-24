import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer } from '../entities/Player.ts'
import { updateEnemy, updateDeath } from '../entities/Enemy.ts'
import { advanceGlobalTime } from './RhythmClock.ts'
import { updatePreviewEnemy } from '../game/EnemyDesigner.ts'
import { advancePatternClock } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies, getGrid, getCamera, getPhase, getXpForNextLevel } from './GameState.ts'
import { updateOrbs, cleanupOrbs, getOrbs } from '../entities/XPOrb.ts'
import { updateCamera, clampToArena } from '../game/Arena.ts'
import { PLAYER_RADIUS } from '../utils/constants.ts'
import { tryTriggerUpgrade, updateUpgradeScreen, drawUpgradeScreen, drawXPBar } from '../game/UpgradeScreen.ts'

let fps = 0
let frameCount = 0
let lastFpsTime = performance.now()

export function update(dt: number): void {
  const phase = getPhase()

  if (phase === 'upgrading') {
    updateUpgradeScreen(dt)
    return
  }

  const player = getPlayer()
  const enemies = getEnemies()
  const grid = getGrid()
  const cam = getCamera()

  Input.flush()
  advanceGlobalTime(dt)
  advancePatternClock(dt)
  updatePreviewEnemy(dt)
  updatePlayer(player, dt)

  const dir = Input.getMovementDir()
  updateCamera(cam, player.x, player.y, dir.x, dir.y, window.innerWidth, window.innerHeight, dt)

  grid.clear()
  for (const enemy of enemies) {
    if (enemy.alive) grid.insert(enemy)
  }

  for (const enemy of enemies) {
    updateDeath(enemy, dt)
    updateEnemy(enemy, player, dt, grid)
  }

  updateOrbs(dt, player.x, player.y, enemies)

  // Multi-pass separation — resolve congestion (3 iterations)
  const orbs = getOrbs()
  for (let pass = 0; pass < 3; pass++) {
    // Enemy-enemy (use grid for O(n))
    grid.clear()
    for (const enemy of enemies) {
      if (enemy.alive && !enemy.dying) grid.insert(enemy)
    }
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying) continue
      const nearby = grid.query(enemy)
      for (const other of nearby) {
        const oe = other as typeof enemy
        if (oe === enemy || !oe.alive || oe.dying) continue
        const minDist = enemy.radius + oe.radius
        const dx = enemy.x - oe.x
        const dy = enemy.y - oe.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist && dist > 0.1) {
          const overlap = (minDist - dist) * 0.5
          const nx = dx / dist
          const ny = dy / dist
          enemy.x += nx * overlap
          enemy.y += ny * overlap
          oe.x -= nx * overlap
          oe.y -= ny * overlap
        }
      }
      // Clamp enemy
      const ec = clampToArena(enemy.x, enemy.y, enemy.radius)
      enemy.x = ec.x
      enemy.y = ec.y
    }

    // Orb-orb + orb-enemy
    for (const orb of orbs) {
      if (!orb.alive || orb.dying) continue
      for (const other of orbs) {
        if (other === orb || !other.alive || other.dying) continue
        const minDist = orb.radius + other.radius
        const dx = orb.x - other.x
        const dy = orb.y - other.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist && dist > 0.1) {
          const overlap = (minDist - dist) * 0.5
          const nx = dx / dist
          const ny = dy / dist
          orb.x += nx * overlap
          orb.y += ny * overlap
          other.x -= nx * overlap
          other.y -= ny * overlap
        }
      }
      for (const enemy of enemies) {
        if (!enemy.alive || enemy.dying) continue
        const minDist = orb.radius + enemy.radius
        const dx = orb.x - enemy.x
        const dy = orb.y - enemy.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist && dist > 0.1) {
          const overlap = minDist - dist
          orb.x += (dx / dist) * overlap
          orb.y += (dy / dist) * overlap
        }
      }
      // Clamp orb
      const oc = clampToArena(orb.x, orb.y, orb.radius)
      orb.x = oc.x
      orb.y = oc.y
    }

    // Player vs enemies + orbs
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying) continue
      const minDist = enemy.radius + PLAYER_RADIUS
      const dx = player.x - enemy.x
      const dy = player.y - enemy.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < minDist && dist > 0.1) {
        const overlap = minDist - dist
        player.x += (dx / dist) * overlap
        player.y += (dy / dist) * overlap
      }
    }
    for (const orb of orbs) {
      if (!orb.alive || orb.dying) continue
      const minDist = orb.radius + PLAYER_RADIUS
      const dx = player.x - orb.x
      const dy = player.y - orb.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < minDist && dist > 0.1) {
        const overlap = minDist - dist
        player.x += (dx / dist) * overlap
        player.y += (dy / dist) * overlap
      }
    }
    const pc = clampToArena(player.x, player.y, PLAYER_RADIUS)
    player.x = pc.x
    player.y = pc.y
  }

  cleanupOrbs()

  // Check for level up
  tryTriggerUpgrade()
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

  // Draw XP bar and upgrade screen on top (outside arena clip)
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  drawXPBar(ctx, canvas.width, canvas.height, player.xp, getXpForNextLevel())

  if (getPhase() === 'upgrading') {
    drawUpgradeScreen(ctx, canvas.width, canvas.height)
  }
}

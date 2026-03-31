import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer } from '../entities/Player.ts'
import { createEnemy, updateEnemy, updateDeath } from '../entities/Enemy.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { advanceGlobalTime } from './RhythmClock.ts'
import { updatePreviewEnemy } from '../game/EnemyDesigner.ts'
import { advancePatternClock } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies, getGrid, getCamera, getPhase, getXpForNextLevel } from './GameState.ts'
import { updateOrbs, cleanupOrbs, getOrbs } from '../entities/XPOrb.ts'
import { updateCamera, clampToArena, getArenaShape, setArenaShape } from '../game/Arena.ts'
import { PLAYER_RADIUS } from '../utils/constants.ts'
import { tryTriggerUpgrade, updateUpgradeScreen, drawUpgradeScreen, drawXPBar } from '../game/UpgradeScreen.ts'
import { on } from './EventBus.ts'
import { perfStart, perfEnd, exportPerfLog } from '../render/Renderer.ts'
import { getEnemyType } from '../entities/EnemyTypes.ts'

let fps = 0
let frameCount = 0
let arenaToggleLock = false
let perfExportLock = false
let lastFpsTime = performance.now()

// Totem spawn handler
on('totem:spawn', (totemEnemy: Enemy) => {
  const typeName = totemEnemy.totemSpawn
  if (!typeName) return
  const type = getEnemyType(typeName)
  if (!type) return
  // Spawn at a random offset from the totem
  const angle = Math.random() * Math.PI * 2
  const dist = totemEnemy.radius + (type.radius ?? 40) + 10
  const sx = totemEnemy.x + Math.cos(angle) * dist
  const sy = totemEnemy.y + Math.sin(angle) * dist
  const enemies = getEnemies()
  enemies.push(createEnemy(sx, sy, type))
})

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

  // Toggle arena shape with G key
  if (Input.isKeyDown('g') && !arenaToggleLock) {
    arenaToggleLock = true
    const shapes = ['rect', 'circle', 'hex', 'pill', 'cross'] as const
    const cur = shapes.indexOf(getArenaShape())
    setArenaShape(shapes[(cur + 1) % shapes.length]!)
  }
  if (!Input.isKeyDown('g')) arenaToggleLock = false

  // P = export perf log
  if (Input.isKeyDown('p') && !perfExportLock) {
    perfExportLock = true
    exportPerfLog()
  }
  if (!Input.isKeyDown('p')) perfExportLock = false

  perfStart('U_TOTAL')

  advanceGlobalTime(dt)
  advancePatternClock(dt)
  updatePreviewEnemy(dt)

  // Build grid before player update so beat hit-detection can query enemies + orbs
  perfStart('u_grid')
  grid.clear()
  for (const enemy of enemies) {
    if (enemy.alive) grid.insert(enemy)
  }
  const allOrbs = getOrbs()
  for (const orb of allOrbs) {
    if (orb.alive && !orb.dying) grid.insert(orb)
  }
  perfEnd('u_grid')

  perfStart('u_player')
  updatePlayer(player, dt)
  perfEnd('u_player')

  const dir = Input.getMovementDir()
  updateCamera(cam, player.x, player.y, dir.x, dir.y, window.innerWidth, window.innerHeight, dt)

  perfStart('u_enemies')
  for (const enemy of enemies) {
    updateDeath(enemy, dt)
    updateEnemy(enemy, player, dt, grid)
  }
  perfEnd('u_enemies')

  perfStart('u_orbs')
  updateOrbs(dt)
  perfEnd('u_orbs')

  // Multi-pass separation
  perfStart('separation')
  const orbs = getOrbs()
  for (let pass = 0; pass < 2; pass++) {
    // Build grid with enemies + orbs
    grid.clear()
    for (const enemy of enemies) {
      if (enemy.alive && !enemy.dying) grid.insert(enemy)
    }
    for (const orb of orbs) {
      if (orb.alive && !orb.dying) grid.insert(orb)
    }

    // Enemy-enemy separation (grid-accelerated) — immovable enemies act as walls
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying || enemy.immovable) continue
      const nearby = grid.query(enemy)
      for (const other of nearby) {
        if (!('hp' in other)) continue  // skip orbs
        const oe = other as typeof enemy
        if (!oe.alive || oe.dying) continue
        const minDist = enemy.radius + oe.radius
        const dx = enemy.x - oe.x
        const dy = enemy.y - oe.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist && dist > 0.1) {
          const nx = dx / dist
          const ny = dy / dist
          if (oe.immovable) {
            // This enemy yields fully to immovable other
            const overlap = minDist - dist
            enemy.x += nx * overlap
            enemy.y += ny * overlap
          } else {
            const overlap = (minDist - dist) * 0.5
            enemy.x += nx * overlap
            enemy.y += ny * overlap
            oe.x -= nx * overlap
            oe.y -= ny * overlap
          }
        }
      }
      const ec = clampToArena(enemy.x, enemy.y, enemy.radius)
      enemy.x = ec.x
      enemy.y = ec.y
    }

    // Player pushes orbs
    for (const orb of orbs) {
      if (!orb.alive || orb.dying) continue
      const pdx = orb.x - player.x
      const pdy = orb.y - player.y
      const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
      const pMin = orb.radius + PLAYER_RADIUS
      if (pDist < pMin && pDist > 0.1) {
        const overlap = pMin - pDist
        orb.x += (pdx / pDist) * overlap
        orb.y += (pdy / pDist) * overlap
      }
    }

    // Orb separation (grid-accelerated, uses same grid build from top of pass)
    for (const orb of orbs) {
      if (!orb.alive || orb.dying) continue
      const nearby = grid.query(orb)
      for (const other of nearby) {
        if (other === orb) continue
        const isEnemy = 'hp' in other
        const minDist = orb.radius + other.radius
        const dx = orb.x - other.x
        const dy = orb.y - other.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist && dist > 0.1) {
          const nx = dx / dist
          const ny = dy / dist
          if (isEnemy) {
            const overlap = minDist - dist
            orb.x += nx * overlap
            orb.y += ny * overlap
          } else {
            const overlap = (minDist - dist) * 0.5
            orb.x += nx * overlap
            orb.y += ny * overlap
          }
        }
      }
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

  perfEnd('separation')

  cleanupOrbs()

  // Prune dead enemies (swap-and-pop)
  for (let i = enemies.length - 1; i >= 0; i--) {
    if (!enemies[i]!.alive) {
      enemies[i] = enemies[enemies.length - 1]!
      enemies.pop()
    }
  }

  // Check for level up
  tryTriggerUpgrade()
  perfEnd('U_TOTAL')
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

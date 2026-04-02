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
import { PLAYER_RADIUS, MAGNET_RANGE, MAGNET_STRENGTH } from '../utils/constants.ts'
import { tryTriggerUpgrade, updateUpgradeScreen, drawUpgradeScreen, drawXPBar } from '../game/UpgradeScreen.ts'
import { on } from './EventBus.ts'
import { perfStart, perfEnd, exportPerfLog, addSpawnEffect } from '../render/Renderer.ts'
import { getEnemyType } from '../entities/EnemyTypes.ts'

let fps = 0
let frameCount = 0
let arenaToggleLock = false
let perfExportLock = false
let lastFpsTime = performance.now()

// Totem spawn handler
/** Find a spawn position that doesn't overlap immovable enemies or the player */
function findClearSpawnPos(x: number, y: number, radius: number, enemies: Enemy[], player: { x: number; y: number }): { x: number; y: number } {
  let sx = x, sy = y
  for (let pass = 0; pass < 3; pass++) {
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying) continue
      if (!enemy.immovable) continue
      const dx = sx - enemy.x
      const dy = sy - enemy.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const minDist = radius + enemy.radius + 2
      if (dist < minDist && dist > 0.1) {
        const overlap = minDist - dist
        sx += (dx / dist) * overlap
        sy += (dy / dist) * overlap
      }
    }
    // Also avoid player
    const pdx = sx - player.x
    const pdy = sy - player.y
    const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
    const pMin = radius + PLAYER_RADIUS + 2
    if (pDist < pMin && pDist > 0.1) {
      const overlap = pMin - pDist
      sx += (pdx / pDist) * overlap
      sy += (pdy / pDist) * overlap
    }
  }
  const clamped = clampToArena(sx, sy, radius)
  return clamped
}

on('totem:spawn', (totemEnemy: Enemy) => {
  const typeName = totemEnemy.totemSpawn
  if (!typeName) return
  const type = getEnemyType(typeName)
  if (!type) return
  // Spawn on the far side of the totem from the player — try multiple angles if blocked
  const player = getPlayer()
  const dx = totemEnemy.x - player.x
  const dy = totemEnemy.y - player.y
  const len = Math.sqrt(dx * dx + dy * dy)
  const baseAngle = len > 1 ? Math.atan2(dy, dx) : Math.random() * Math.PI * 2
  const spawnRadius = type.radius ?? 40
  const dist = totemEnemy.radius + spawnRadius + 60
  const enemies = getEnemies()

  // Try 8 angles, starting from away-from-player, pick the one with least overlap
  let bestX = totemEnemy.x, bestY = totemEnemy.y, bestOverlap = Infinity
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = baseAngle + (attempt * Math.PI / 4) + (Math.random() - 0.5) * 0.3
    const rawX = totemEnemy.x + Math.cos(angle) * dist
    const rawY = totemEnemy.y + Math.sin(angle) * dist
    const clamped = clampToArena(rawX, rawY, spawnRadius)
    const pos = findClearSpawnPos(clamped.x, clamped.y, spawnRadius, enemies, player)

    // Measure total overlap at this position
    let overlap = 0
    for (const e of enemies) {
      if (!e.alive || e.dying) continue
      const edx = pos.x - e.x, edy = pos.y - e.y
      const eDist = Math.sqrt(edx * edx + edy * edy)
      const minDist = spawnRadius + e.radius
      if (eDist < minDist) overlap += minDist - eDist
    }
    // Check wall proximity (how much the clamp moved us)
    const wallDist = Math.sqrt((rawX - pos.x) ** 2 + (rawY - pos.y) ** 2)
    overlap += wallDist * 0.5

    if (overlap < bestOverlap) {
      bestOverlap = overlap
      bestX = pos.x
      bestY = pos.y
    }
    if (overlap < 1) break  // good enough
  }

  enemies.push(createEnemy(bestX, bestY, type))
  addSpawnEffect(totemEnemy.x, totemEnemy.y, totemEnemy.radius, bestX, bestY, type.color)
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

  // Magnet pull — each orb attracted to closest magnet enemy
  const magnetOrbs = getOrbs()
  for (const orb of magnetOrbs) {
    if (!orb.alive || orb.dying) continue
    let closestDist = Infinity
    let closestEnemy: Enemy | null = null
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying || !enemy.magnet) continue
      const dx = orb.x - enemy.x
      const dy = orb.y - enemy.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < enemy.magnetRange && dist < closestDist) {
        closestDist = dist
        closestEnemy = enemy
      }
    }
    if (closestEnemy && closestDist > closestEnemy.radius + orb.radius) {
      const dx = closestEnemy.x - orb.x
      const dy = closestEnemy.y - orb.y
      const len = Math.sqrt(dx * dx + dy * dy)
      const stopDist = closestEnemy.radius + orb.radius
      if (len > stopDist) {
        const pull = Math.min(MAGNET_STRENGTH * dt, len - stopDist)  // don't overshoot into body
        orb.x += (dx / len) * pull
        orb.y += (dy / len) * pull
      }
    }
  }
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

    // Immovable separation — very heavy, barely pushed by anything
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying || !enemy.immovable) continue
      const nearby = grid.query(enemy)
      for (const other of nearby) {
        if (!('hp' in other)) continue
        const oe = other as typeof enemy
        if (!oe.alive || oe.dying || oe === enemy) continue
        const minDist = enemy.radius + oe.radius + 2
        const dx = enemy.x - oe.x
        const dy = enemy.y - oe.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < minDist && dist > 0.1) {
          const overlap = minDist - dist
          const nx = dx / dist
          const ny = dy / dist
          if (oe.immovable) {
            // Both immovable — split evenly
            enemy.x += nx * overlap * 0.5
            enemy.y += ny * overlap * 0.5
            oe.x -= nx * overlap * 0.5
            oe.y -= ny * overlap * 0.5
          } else {
            // Immovable barely moves (10%), other takes the rest (90%)
            enemy.x += nx * overlap * 0.1
            enemy.y += ny * overlap * 0.1
            oe.x -= nx * overlap * 0.9
            oe.y -= ny * overlap * 0.9
          }
        }
      }
      const ec = clampToArena(enemy.x, enemy.y, enemy.radius)
      enemy.x = ec.x
      enemy.y = ec.y
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
          const overlap = (minDist - dist) * 0.5
          orb.x += nx * overlap
          orb.y += ny * overlap
          if (!isEnemy) {
            // Orb-orb: push the other orb too
            const otherOrb = other as typeof orb
            otherOrb.x -= nx * overlap
            otherOrb.y -= ny * overlap
          } else {
            // Orb-enemy: push enemy too (same as enemy-enemy)
            const oe = other as Enemy
            if (!oe.immovable) {
              oe.x -= nx * overlap
              oe.y -= ny * overlap
            }
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
        const nx = dx / dist
        const ny = dy / dist
        if (enemy.immovable) {
          // Player pushes heavy enemy a little (15%), player takes the rest
          enemy.x -= nx * overlap * 0.15
          enemy.y -= ny * overlap * 0.15
          player.x += nx * overlap * 0.85
          player.y += ny * overlap * 0.85
          const ec = clampToArena(enemy.x, enemy.y, enemy.radius)
          enemy.x = ec.x
          enemy.y = ec.y
        } else {
          // Player is heavier than normal enemies
          player.x += nx * overlap * 0.2
          player.y += ny * overlap * 0.2
          enemy.x -= nx * overlap * 0.8
          enemy.y -= ny * overlap * 0.8
        }
      }
    }
    // Orbs never push player — already handled by player-pushes-orbs pass above
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

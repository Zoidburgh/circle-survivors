import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer, hurtPlayer, getEffectiveRadius } from '../entities/Player.ts'
import type { Player } from '../entities/Player.ts'
import { createEnemy, updateEnemy, updateDeath, damageEnemy, spawnDrops } from '../entities/Enemy.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { advanceGlobalTime } from './RhythmClock.ts'
import { updatePreviewEnemy } from '../game/EnemyDesigner.ts'
import { advancePatternClock } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies, getGrid, getCamera, getPhase, setPhase, getXpForNextLevel, startRunTimer, advanceRunTimer, isRunTimerActive, isRunComplete, completeRun, getRunTimer } from './GameState.ts'
import { updateOrbs, cleanupOrbs, getOrbs, spawnOrb, collectOrb } from '../entities/XPOrb.ts'
import type { XPOrb } from '../entities/XPOrb.ts'
import { updateCamera, clampToArena, getArenaShape, setArenaShape } from '../game/Arena.ts'
import { PLAYER_RADIUS, MAGNET_RANGE, MAGNET_STRENGTH, BEAT_SEC } from '../utils/constants.ts'
import { tryTriggerUpgrade, updateUpgradeScreen, drawUpgradeScreen, drawXPBar } from '../game/UpgradeScreen.ts'
import { on, emit } from './EventBus.ts'
import { shouldFire, timeUntilNextBeat } from '../audio/PatternClock.ts'
import { playHit, playPlayerHit, playShieldBreak, playShieldRestore, playVolatileExplosion, playBeatDash, playSummonerSpawn, playTotemSpawn, playNodeLock, playNodeComplete, startShieldFuseBurn, stopShieldFuseBurn, playShrineActivate } from '../audio/AudioEngine.ts'
import { updateRitualNodes, getRitualGroups, removeGroup } from '../game/RitualNodes.ts'
import { getScoresForChallenge, fetchOnlineScores } from '../game/HighScores.ts'
import { getActiveChallenge } from '../game/ChallengeBuilder.ts'
import { openShop, updateShopScreen, drawShopScreen } from '../game/ShopScreen.ts'
import { HIT_FLASH_DURATION } from '../utils/constants.ts'
import { perfStart, perfEnd, exportPerfLog, addSpawnEffect, addVolatileExplosion, setPendingExplosions } from '../render/Renderer.ts'
import { getEnemyType } from '../entities/EnemyTypes.ts'
import { hasBonus } from '../game/UpgradeManager.ts'

let fps = 0
let frameCount = 0
let arenaToggleLock = false
let perfExportLock = false
let lastRenderTime = performance.now()
let lastFpsTime = performance.now()

// Totem spawn handler
// ── Pending volatile explosions ──
interface PendingExplosion {
  x: number; y: number
  range: number
  r: number; g: number; b: number
  timer: number  // time since queued (for buildup visual)
  soundPlayed: boolean
}
const pendingExplosions: PendingExplosion[] = []

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
  const dist = (totemEnemy.radius + spawnRadius + 60) * 1.38
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
  playTotemSpawn()
  playHit()
})

// Pending revenge damage checks
interface PendingRevenge {
  origins: { x: number; y: number }[]
  radius: number
  damage: number
  timer: number
  expandTime: number  // synced to next beat
  consume: boolean
  enemy: Enemy  // source enemy for consume healing
}
const pendingRevenges: PendingRevenge[] = []

// Revenge ring visual + queue damage for peak
on('enemy:revenge', (enemy: Enemy) => {
  const expandTime = BEAT_SEC  // always exactly 1 full beat to expand
  const origins: { x: number; y: number }[] = []
  for (let i = 0; i < enemy.revengeRings; i++) {
    const angle = enemy.revengeAngle + (i / enemy.revengeRings) * Math.PI * 2
    const ox = enemy.x + Math.cos(angle) * enemy.radius
    const oy = enemy.y + Math.sin(angle) * enemy.radius
    origins.push({ x: ox, y: oy })
    Renderer.spawnRevengeRingParticles(ox, oy, enemy.revengeRadius, enemy.cr, enemy.cg, enemy.cb, expandTime)
    // Immediate muzzle burst from spike tip on hit
    for (let p = 0; p < 12; p++) {
      const spread = (Math.random() - 0.5) * 1.0
      const pa = angle + spread
      const speed = 350 + Math.random() * 400
      Renderer.spawnParticleExport(ox, oy,
        Math.cos(pa) * speed, Math.sin(pa) * speed,
        255, 160 + Math.floor(Math.random() * 60), 50 + Math.floor(Math.random() * 80),
        0.35 + Math.random() * 0.2, 6 + Math.random() * 5)
    }
    for (let p = 0; p < 6; p++) {
      const spread = (Math.random() - 0.5) * 0.6
      const pa = angle + spread
      const speed = 450 + Math.random() * 400
      Renderer.spawnParticleExport(ox, oy,
        Math.cos(pa) * speed, Math.sin(pa) * speed,
        255, 100 + Math.floor(Math.random() * 80), 200 + Math.floor(Math.random() * 55),
        0.3 + Math.random() * 0.15, 4 + Math.random() * 3)
    }
    // Charging particles — converge from outside to the fire point
    for (let p = 0; p < 12; p++) {
      const pa = angle + (Math.random() - 0.5) * 2
      const dist = enemy.revengeRadius * 0.3 + Math.random() * enemy.revengeRadius * 0.5
      const px = ox + Math.cos(pa) * dist
      const py = oy + Math.sin(pa) * dist
      const speed = 120 + Math.random() * 100
      const toAngle = Math.atan2(oy - py, ox - px)
      Renderer.spawnParticleExport(px, py,
        Math.cos(toAngle) * speed, Math.sin(toAngle) * speed,
        enemy.cr, enemy.cg, enemy.cb, 0.5 + Math.random() * 0.3, 4 + Math.random() * 3)
    }
  }
  pendingRevenges.push({ origins, radius: enemy.revengeRadius, damage: enemy.damage, timer: 0, expandTime, consume: enemy.consume, enemy })
})

// Queue volatile explosion on death
on('enemy:killed', (enemy: Enemy) => {
  if (!enemy.volatile) return
  pendingExplosions.push({
    x: enemy.x, y: enemy.y,
    range: enemy.volatileRange,
    r: enemy.cr, g: enemy.cg, b: enemy.cb,
    timer: 0,
    soundPlayed: false,
  })
})

// On-beat dash shockwave — area damage at dash start position
on('player:beatDash', (player: Player) => {
  const shockRadius = getEffectiveRadius(player) * 0.7 * player.modifiers.beatBlastMult
  const damage = player.damage * player.modifiers.damageMult
  const enemies = getEnemies()
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.dying) continue
    if (enemy.isShrine) continue  // shrines handled separately below
    if (enemy.summon) {
      // Check if shockwave hits active summon node
      const N = enemy.summonNodes
      const activeIdx = enemy.summonBeatCount % N
      const baseRot = Renderer.getGameTimeMs() / 2000
      const nodeAngle = baseRot + (activeIdx / N) * Math.PI * 2
      const orbitR = enemy.radius * 0.55
      const nodeR = Math.max(8, enemy.radius * 0.34)
      const nodeX = enemy.x + Math.cos(nodeAngle) * orbitR
      const nodeY = enemy.y + Math.sin(nodeAngle) * orbitR
      const ndx = nodeX - player.x
      const ndy = nodeY - player.y
      if (ndx * ndx + ndy * ndy <= (shockRadius + nodeR) * (shockRadius + nodeR)) {
        // Hit the active node — same logic as ring hit
        if (enemy.summonProgress === 0) {
          enemy.summonNodeStates[activeIdx] = 'locked'
          enemy.summonLockFlash[activeIdx] = 0.3
          enemy.summonStartOffset = activeIdx
          enemy.summonProgress = 1
          if (enemy.summonProgress >= N) { playNodeComplete() } else { playNodeLock(0, N) }
        } else {
          const expected = (enemy.summonStartOffset + enemy.summonProgress) % N
          if (activeIdx === expected) {
            enemy.summonNodeStates[activeIdx] = 'locked'
            enemy.summonLockFlash[activeIdx] = 0.3
            enemy.summonProgress++
            if (enemy.summonProgress >= N) { playNodeComplete() } else { playNodeLock(enemy.summonProgress - 1, N) }
          }
        }
        if (enemy.summonProgress >= N && enemy.summonActivationTimer <= 0) {
          enemy.summonActivationTimer = BEAT_SEC * 0.5
        }
      }
      continue
    }
    const dx = enemy.x - player.x
    const dy = enemy.y - player.y
    const hitRange = shockRadius + enemy.radius
    if (dx * dx + dy * dy <= hitRange * hitRange) {
      const wasDying = enemy.dying
      damageEnemy(enemy, damage)
      // Totem spawn on hit
      if (enemy.totemSpawn) {
        emit('totem:spawn', enemy)
      }
      // Revenge on hit
      if (enemy.revenge) {
        emit('enemy:revenge', enemy)
      }
      if (enemy.dying && !wasDying) {
        spawnDrops(enemy, 1, spawnOrb)
      }
    }
  }
  // Collect orbs in blast area
  const allOrbs = getOrbs()
  for (const orb of allOrbs) {
    if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
    const odx = orb.x - player.x
    const ody = orb.y - player.y
    if (odx * odx + ody * ody <= (shockRadius + orb.radius) * (shockRadius + orb.radius)) {
      collectOrb(orb)
      if (orb.orbType === 'hp') {
        player.hp = Math.min(player.hp + 1, player.maxHp)
      } else {
        player.xp += orb.value * player.modifiers.xpMult
      }
    }
  }
  // Check shrines — player must be FULLY inside + beat-dash
  const playerRadius = getEffectiveRadius(player) * player.modifiers.sizeMult
  for (const enemy of enemies) {
    if (!enemy.isShrine || !enemy.alive || enemy.shrineTimer > 0) continue
    const sdx = enemy.x - player.x
    const sdy = enemy.y - player.y
    const dist = Math.sqrt(sdx * sdx + sdy * sdy)
    const effectiveRadius = enemy.radius * player.modifiers.shrineSizeMult
    if (dist + playerRadius <= effectiveRadius) {
      const count = Math.round(enemy.shrineSpawnCount * player.modifiers.shrineSpawnMult)
      if (enemy.shrineType === 'xp') {
        for (let i = 0; i < count; i++) {
          const angle = (i / count) * Math.PI * 2
          const orbDist = enemy.radius * 0.4
          spawnOrb(enemy.x + Math.cos(angle) * orbDist, enemy.y + Math.sin(angle) * orbDist, 1, 'xp')
        }
      } else {
        player.hp = Math.min(player.hp + count, player.maxHp)
      }
      enemy.shrineTimer = enemy.shrineCooldown * player.modifiers.shrineCooldownMult
      enemy.shrineActivationFlash = 0.5
      emit('shrine:activate', enemy)
      playShrineActivate(enemy.shrineType === 'xp')
    }
  }

  // SFX + Visual — shockwave flash on top of everything + particles
  playBeatDash()
  Renderer.triggerBeatDashFlash(player.x, player.y, shockRadius)
  Renderer.spawnVolatileParticles(player.x, player.y, shockRadius, 0, 230, 255)
})

// Shield audio events
on('player:shieldBreak', () => {
  playShieldBreak()
  const player = getPlayer()
  startShieldFuseBurn(player.shieldRechargeTime)
})
on('player:shieldRestore', () => {
  stopShieldFuseBurn()
  playShieldRestore()
})
on('player:shieldRechargeReset', (player: Player) => {
  startShieldFuseBurn(player.shieldRechargeTime)
})

// Summon phase completion — spawn enemies, advance or kill summoner
on('summon:phase', (enemy: Enemy) => {
  // Start run timer on first summon spawn
  if (!isRunTimerActive() && !isRunComplete()) {
    startRunTimer()
  }
  const phase = enemy.summonPhases[enemy.summonCurrentPhase]
  if (phase) {
    // Check if this is a SHOP phase
    const isShop = phase.spawns.length === 1 && phase.spawns[0]!.enemyName.toUpperCase() === 'SHOP'
    if (isShop) {
      openShop()
    } else {
      // Normal spawn phase
      const er = parseInt(enemy.color.slice(1, 3), 16)
      const eg = parseInt(enemy.color.slice(3, 5), 16)
      const eb = parseInt(enemy.color.slice(5, 7), 16)
      let totalSpawns = 0
      for (const s of phase.spawns) totalSpawns += s.count
      // Start spawning from the far side of the summoner from the player
      const player = getPlayer()
      const pdx = enemy.x - player.x
      const pdy = enemy.y - player.y
      const baseAngle = Math.atan2(pdy, pdx)
      let spawnIdx = 0
      for (const spawn of phase.spawns) {
        const type = getEnemyType(spawn.enemyName)
        if (!type) continue
        for (let i = 0; i < spawn.count; i++) {
          const angle = baseAngle + (spawnIdx / totalSpawns) * Math.PI * 2
          spawnIdx++
          const dist = (enemy.radius + (type.radius ?? 40) + 30) * 1.38
          const sx = enemy.x + Math.cos(angle) * dist
          const sy = enemy.y + Math.sin(angle) * dist
          const clamped = clampToArena(sx, sy, type.radius ?? 40)
          const newEnemy = createEnemy(clamped.x, clamped.y, type)
          getEnemies().push(newEnemy)
          Renderer.addAbsorbEffect(enemy.x, enemy.y, er, eg, eb, clamped.x, clamped.y)
          Renderer.addSpawnEffect(enemy.x, enemy.y, type.radius ?? 40, clamped.x, clamped.y, type.color)
        }
      }
    }
  }
  playSummonerSpawn()
  // Blood burst from the pie edge as the phase drains away
  {
    const totalPhases = enemy.summonPhases.length
    const oldPhaseFrac = (totalPhases - enemy.summonCurrentPhase) / totalPhases
    const newPhaseFrac = (totalPhases - enemy.summonCurrentPhase - 1) / totalPhases
    const startAngle = -Math.PI / 2
    const arcFrom = startAngle + newPhaseFrac * Math.PI * 2
    const arcTo = startAngle + oldPhaseFrac * Math.PI * 2
    const arcSpan = arcTo - arcFrom
    const er = parseInt(enemy.color.slice(1, 3), 16)
    const eg = parseInt(enemy.color.slice(3, 5), 16)
    const eb = parseInt(enemy.color.slice(5, 7), 16)
    const r = enemy.radius
    const count = Math.floor(18 + r * 0.3)
    for (let i = 0; i < count; i++) {
      const angle = arcFrom + Math.random() * arcSpan
      const dist = (0.4 + Math.random() * 0.6) * r
      const px = enemy.x + Math.cos(angle) * dist
      const py = enemy.y + Math.sin(angle) * dist
      const outAngle = Math.atan2(py - enemy.y, px - enemy.x)
      const speed = 100 + Math.random() * 200
      const vx = Math.cos(outAngle) * speed + (Math.random() - 0.5) * speed * 0.3
      const vy = Math.sin(outAngle) * speed + (Math.random() - 0.5) * speed * 0.3
      const size = 3 + Math.random() * 4
      Renderer.spawnParticleExport(px, py, vx, vy,
        Math.min(255, er + 40), Math.max(0, eg - 20), Math.max(0, eb - 20),
        0.4 + Math.random() * 0.4, size)
    }
  }

  // Advance to next phase or kill summoner
  enemy.summonCurrentPhase++
  if (enemy.summonCurrentPhase >= enemy.summonPhases.length) {
    // All phases done — kill summoner
    enemy.dying = true
    enemy.deathTimer = 0
    emit('enemy:killed', enemy)
  } else {
    // Reset nodes for next phase
    enemy.summonProgress = 0
    enemy.summonStartOffset = 0
    for (let i = 0; i < enemy.summonNodes; i++) {
      enemy.summonNodeStates[i] = 'idle'
    }
  }
})

export function resetPendingEffects(): void {
  pendingExplosions.length = 0
  pendingRevenges.length = 0
}

export function update(dt: number): void {
  const phase = getPhase()

  if (phase === 'title' || phase === 'dead' || phase === 'challenge_select' || phase === 'paused' || phase === 'entering_name') {
    advancePatternClock(dt)
    return
  }
  if (phase === 'upgrading') {
    updateUpgradeScreen(dt)
    return
  }
  if (phase === 'shopping') {
    updateShopScreen(dt)
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
  updateRitualNodes(dt)

  // Handle completed ritual node groups
  for (const group of getRitualGroups()) {
    if (group.completed && group.completionTimer <= 0) {
      if (group.type === 'shop') {
        openShop()
      }
      removeGroup(group.id)
      break  // array mutated, exit loop
    }
  }

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

  // Death check
  if (player.hp <= 0 && getPhase() === 'playing') {
    setPhase('dead')
    const ch = getActiveChallenge()
    if (ch) fetchOnlineScores(ch.name)
  }

  const dir = Input.getMovementDir()
  updateCamera(cam, player.x, player.y, dir.x, dir.y, Renderer.getLogicalSize().w, Renderer.getLogicalSize().h, dt)

  // Process revenge ring damage at peak (BEAT_SEC after spawn)
  for (let i = pendingRevenges.length - 1; i >= 0; i--) {
    const pr = pendingRevenges[i]!
    pr.timer += dt
    if (pr.timer >= pr.expandTime) {
      // Check if player is hit by any ring at peak
      for (const origin of pr.origins) {
        const pdx = player.x - origin.x
        const pdy = player.y - origin.y
        const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
        if (Math.abs(pDist - pr.radius) < player.hitRadius) {
          if (!(player.dashTimer >= 0 && hasBonus('ghostDash'))) {
            if (hurtPlayer(player, pr.damage)) playPlayerHit()
          }
          break  // only hit once per revenge burst
        }
      }
      // Consume: eat orbs at ring peak, heal source enemy
      if (pr.consume) {
        const allOrbs = getOrbs()
        for (const orb of allOrbs) {
          if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
          for (const origin of pr.origins) {
            const odx = orb.x - origin.x
            const ody = orb.y - origin.y
            const oDist = Math.sqrt(odx * odx + ody * ody)
            if (Math.abs(oDist - pr.radius) < orb.radius + 2) {
              collectOrb(orb, 'enemy')
              if (pr.enemy.alive && !pr.enemy.dying && pr.enemy.hp < pr.enemy.maxHp) {
                pr.enemy.hp = Math.min(pr.enemy.hp + 1, pr.enemy.maxHp)
              }
              const isHP = orb.orbType === 'hp'
              Renderer.addAbsorbEffect(orb.x, orb.y, isHP ? 255 : 150, isHP ? 140 : 255, isHP ? 140 : 200, pr.enemy.x, pr.enemy.y)
              break  // one origin per orb
            }
          }
        }
      }
      pendingRevenges[i] = pendingRevenges[pendingRevenges.length - 1]!
      pendingRevenges.pop()
    }
  }

  // Process volatile explosions BEFORE enemy updates (so positions match player ring hits)
  perfStart('u_enemies')
  for (let i = pendingExplosions.length - 1; i >= 0; i--) {
    const exp = pendingExplosions[i]!
    exp.timer += dt
    // Start hiss sound at beginning of buildup (enemy death)
    if (!exp.soundPlayed) {
      exp.soundPlayed = true
      playVolatileExplosion()
    }
    // Detonate after exactly 1 second
    if (exp.timer >= BEAT_SEC) {
      // Damage all enemies in range (check current pos + blink destination)
      for (const enemy of enemies) {
        if (!enemy.alive || enemy.dying || enemy.summon) continue
        const dx = enemy.x - exp.x
        const dy = enemy.y - exp.y
        const hitRange = exp.range + enemy.radius  // include enemy body
        const inRange = dx * dx + dy * dy <= hitRange * hitRange
        // Also check blink destination if mid-phase
        let destInRange = false
        if (enemy.blink && enemy.blinkPreview > 0) {
          const gdx = enemy.blinkGhostX - exp.x
          const gdy = enemy.blinkGhostY - exp.y
          destInRange = gdx * gdx + gdy * gdy <= hitRange * hitRange
        }
        if (inRange || destInRange) {
          const wasDying = enemy.dying
          damageEnemy(enemy, 1)
          // Trigger revenge ring if hit enemy has revenge tag (including killing blow)
          if (enemy.revenge) {
            emit('enemy:revenge', enemy)
          }
          // Totem: spawn enemy on hit
          if (enemy.totemSpawn) {
            emit('totem:spawn', enemy)
          }
          // Spawn orbs if killed by explosion
          if (enemy.dying && !wasDying) {
            spawnDrops(enemy, 1, spawnOrb)
          }
        }
      }
      // Damage player if in range
      const pdx = player.x - exp.x
      const pdy = player.y - exp.y
      const playerHitRange = exp.range + player.hitRadius
      if (pdx * pdx + pdy * pdy <= playerHitRange * playerHitRange) {
        if (hurtPlayer(player, 1)) playPlayerHit()
      }
      // Visual explosion + particles spread across blast circle
      addVolatileExplosion(exp.x, exp.y, exp.range, exp.r, exp.g, exp.b)
      Renderer.spawnVolatileParticles(exp.x, exp.y, exp.range, exp.r, exp.g, exp.b)
      // Remove
      pendingExplosions[i] = pendingExplosions[pendingExplosions.length - 1]!
      pendingExplosions.pop()
    }
  }
  // Pass pending to renderer for buildup visuals
  setPendingExplosions(pendingExplosions)

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
            // Reflect bounce velocity off immovable
            if (oe.movePattern === 'bounce') {
              const bnx = -nx  // normal points from oe toward immovable
              const bny = -ny
              const dot = oe.bounceVx * bnx + oe.bounceVy * bny
              if (dot < 0) {
                oe.bounceVx -= 2 * dot * bnx
                oe.bounceVy -= 2 * dot * bny
              }
            }
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
            // Reflect bounce velocity off immovable
            if (enemy.movePattern === 'bounce') {
              const dot = enemy.bounceVx * nx + enemy.bounceVy * ny
              if (dot < 0) {
                enemy.bounceVx -= 2 * dot * nx
                enemy.bounceVy -= 2 * dot * ny
              }
            }
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
      const pMin = orb.radius + player.hitRadius
      if (pDist < pMin && pDist > 0.1) {
        const overlap = pMin - pDist
        const nx = pdx / pDist
        const ny = pdy / pDist
        // Push both — orb gets most, player nudges slightly
        orb.x += nx * overlap * 0.85
        orb.y += ny * overlap * 0.85
        player.x -= nx * overlap * 0.15
        player.y -= ny * overlap * 0.15
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
      const minDist = enemy.radius + player.hitRadius
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
    const pc = clampToArena(player.x, player.y, player.hitRadius)
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

  // Run timer
  advanceRunTimer(dt)

  // Win condition — all enemies dead while timer is running
  if (isRunTimerActive()) {
    const anyAlive = enemies.some(e => e.alive)
    if (!anyAlive) {
      completeRun()
      const ch = getActiveChallenge()
      if (ch) {
        fetchOnlineScores(ch.name)  // preload global scores immediately
        const scores = getScoresForChallenge(ch.name, 100)
        const qualifies = scores.length < 100 || getRunTimer() < scores[scores.length - 1]!.time
        if (qualifies) {
          setPhase('entering_name')
        }
      }
    }
  }

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

  const renderDt = Math.min((now - lastRenderTime) / 1000, 0.1)  // real delta, capped
  lastRenderTime = now

  if (getPhase() === 'title') {
    Renderer.drawTitleScreen(renderDt)
    return
  }
  if (getPhase() === 'challenge_select') {
    Renderer.drawChallengeSelect(renderDt)
    return
  }

  Renderer.render(player, enemies, alpha, fps, renderDt, cam)

  // Draw XP bar and upgrade screen on top (outside arena clip)
  const canvas = document.getElementById('game') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  drawXPBar(ctx, canvas.width, canvas.height, player.xp, getXpForNextLevel())

  if (getPhase() === 'upgrading') {
    drawUpgradeScreen(ctx, canvas.width, canvas.height)
  }
  if (getPhase() === 'shopping') {
    drawShopScreen(ctx, canvas.width, canvas.height)
  }
}

import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer, hurtPlayer, resetDashCDToast, RECALL_DURATION } from '../entities/Player.ts'
import type { Player } from '../entities/Player.ts'
import { createEnemy, updateEnemy, updateDeath, damageEnemy, spawnDrops, tickLeaveToastCD, resetLeaveToastCD } from '../entities/Enemy.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { advanceGlobalTime } from './RhythmClock.ts'
import { updatePreviewEnemy } from '../game/EnemyDesigner.ts'
import { advancePatternClock } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies, getGrid, getCamera, getPhase, setPhase, getXpForNextLevel, startRunTimer, advanceRunTimer, isRunTimerActive, isRunComplete, completeRun, getRunTimer, isInDesignerTestPlay } from './GameState.ts'
import { updateOrbs, cleanupOrbs, getOrbs, spawnOrb, collectOrb, resetOrbs } from '../entities/XPOrb.ts'
import type { XPOrb } from '../entities/XPOrb.ts'
import { updateCamera, clampToArena, getArenaShape, setArenaShape, findClearSpawnPos, resolveWallCollision, updateWalls, consumeSpringFires, computeWallArc, getWalls } from '../game/Arena.ts'
import type { Wall } from '../game/Arena.ts'
import { PLAYER_RADIUS, MAGNET_RANGE, MAGNET_STRENGTH, BEAT_SEC } from '../utils/constants.ts'
import { tryTriggerUpgrade, updateUpgradeScreen, drawUpgradeScreen, drawXPBar } from '../game/UpgradeScreen.ts'
import { on, emit } from './EventBus.ts'
import { shouldFire, timeUntilNextBeat, getLoopPosition, getAbsoluteBeats } from '../audio/PatternClock.ts'
import { getBeatZeroTime } from '../audio/BeatLoop.ts'
import { playHit, playPlayerHit, playShieldBreak, playShieldRestore, playVolatileExplosion, playBeatDash, playFuseStart, playRecallStart, playChillZonePlace, playIceShardBurst, playWallSpringFire, playSummonerSpawn, playTotemSpawn, playNodeLock, playNodeComplete, startShieldFuseBurn, stopShieldFuseBurn, playShrineHit, playShrineSummon, updateDangerMusic, playDeathRoll, playVictoryFanfare, tickAudioHealth } from '../audio/AudioEngine.ts'
import { resetProTip, showToast } from '../render/Renderer.ts'
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
on('totem:spawn', (totemEnemy: Enemy) => {
  // Grim Patron tracking — 10+ totem spawns in 10s
  if (!grimPatronFired) {
    if (challengeElapsed - totemSpawnWindowStart > 11) {
      totemSpawnCount = 0
      totemSpawnWindowStart = challengeElapsed
    }
    totemSpawnCount++
    if (totemSpawnCount >= 10) {
      grimPatronFired = true
      showToast('Everyone! Get in here!', { y: 0.14, duration: 1.5, size: 42, id: 'grim_patron', color: [255, 160, 30], style: 'combo' })
    }
  }
  const raw = totemEnemy.totemSpawn
  if (!raw) return
  const [typeName, countStr] = raw.split(':')
  const type = getEnemyType(typeName!.trim())
  if (!type) return
  const count = parseInt(countStr ?? '1') || 1
  const player = getPlayer()
  const dx = totemEnemy.x - player.x
  const dy = totemEnemy.y - player.y
  const len = Math.sqrt(dx * dx + dy * dy)
  const baseAngle = len > 1 ? Math.atan2(dy, dx) : Math.random() * Math.PI * 2
  const spawnRadius = type.radius ?? 40
  const dist = (totemEnemy.radius + spawnRadius + 60) * 1.38
  const enemies = getEnemies()

  for (let s = 0; s < count; s++) {
    const spawnBaseAngle = baseAngle + (s / count) * Math.PI * 2
    let bestX = totemEnemy.x, bestY = totemEnemy.y, bestOverlap = Infinity
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = spawnBaseAngle + (attempt * Math.PI / 4) + (Math.random() - 0.5) * 0.3
      const rawX = totemEnemy.x + Math.cos(angle) * dist
      const rawY = totemEnemy.y + Math.sin(angle) * dist
      const clamped = clampToArena(rawX, rawY, spawnRadius)
      const pos = findClearSpawnPos(clamped.x, clamped.y, spawnRadius, enemies, player)
      let overlap = 0
      for (const e of enemies) {
        if (!e.alive || e.dying) continue
        const edx = pos.x - e.x, edy = pos.y - e.y
        const eDist = Math.sqrt(edx * edx + edy * edy)
        const minDist = spawnRadius + e.radius
        if (eDist < minDist) overlap += minDist - eDist
      }
      const wallDist = Math.sqrt((rawX - pos.x) ** 2 + (rawY - pos.y) ** 2)
      overlap += wallDist * 0.5
      if (overlap < bestOverlap) {
        bestOverlap = overlap
        bestX = pos.x
        bestY = pos.y
      }
      if (overlap < 1) break
    }
    enemies.push(createEnemy(bestX, bestY, type))
    addSpawnEffect(totemEnemy.x, totemEnemy.y, totemEnemy.radius, bestX, bestY, type.color)
  }
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

function processVolatileExplosions(player: ReturnType<typeof getPlayer>, enemies: Enemy[], dt: number): void {
  for (let i = pendingExplosions.length - 1; i >= 0; i--) {
    const exp = pendingExplosions[i]!
    exp.timer += dt
    if (!exp.soundPlayed) {
      exp.soundPlayed = true
      playVolatileExplosion()
    }
    if (exp.timer >= BEAT_SEC && getActiveChallenge()?.name === 'Beginner Challenge') {
      showToast('BOOM!', { y: 0.14, duration: 1.0, size: 56, id: 'boom', color: [255, 120, 30], style: 'combo' })
    }
    if (exp.timer >= BEAT_SEC) {
      if (!boomBoomPowFired) {
        const now = challengeElapsed
        explosionTimes.push(now)
        while (explosionTimes.length > 0 && explosionTimes[0]! < now - 3) explosionTimes.shift()
        if (explosionTimes.length >= 5) {
          boomBoomPowFired = true
          showToast('BOOM BOOM POW!', { y: 0.14, duration: 1.5, size: 46, id: 'boom_pow', color: [255, 120, 30], style: 'combo' })
        }
      }
      for (const enemy of enemies) {
        if (!enemy.alive || enemy.dying || enemy.summon) continue
        const dx = enemy.x - exp.x
        const dy = enemy.y - exp.y
        const hitRange = exp.range + enemy.radius
        const inRange = dx * dx + dy * dy <= hitRange * hitRange
        let destInRange = false
        if (enemy.blink && enemy.blinkPreview > 0) {
          const gdx = enemy.blinkGhostX - exp.x
          const gdy = enemy.blinkGhostY - exp.y
          destInRange = gdx * gdx + gdy * gdy <= hitRange * hitRange
        }
        if (inRange || destInRange) {
          const wasDying = enemy.dying
          damageEnemy(enemy, 1)
          if (!isRunTimerActive() && !isRunComplete()) {
            startRunTimer()
          }
          if (enemy.revenge) {
            emit('enemy:revenge', enemy)
          }
          if (enemy.totemSpawn) {
            emit('totem:spawn', enemy)
          }
          if (enemy.dying && !wasDying) {
            spawnDrops(enemy, 1, spawnOrb)
            explosionKillTimes.push(challengeElapsed)
          }
        }
      }
      const pdx = player.x - exp.x
      const pdy = player.y - exp.y
      const playerHitRange = exp.range + player.hitRadius
      if (pdx * pdx + pdy * pdy <= playerHitRange * playerHitRange) {
        if (hurtPlayer(player, 1)) playPlayerHit()
      }
      addVolatileExplosion(exp.x, exp.y, exp.range, exp.r, exp.g, exp.b)
      Renderer.spawnVolatileParticles(exp.x, exp.y, exp.range, exp.r, exp.g, exp.b)
      pendingExplosions[i] = pendingExplosions[pendingExplosions.length - 1]!
      pendingExplosions.pop()
    }
  }
  setPendingExplosions(pendingExplosions)
}

// Queue volatile explosion on death
on('enemy:killed', () => {
  recentKills++
  recentKillTimer = 0.3  // 0.3s window to count as "same time"
})

on('enemy:killed', (enemy: Enemy) => {
  if (!enemy.volatile) return
  pendingExplosions.push({
    x: enemy.x, y: enemy.y,
    range: enemy.volatileRange,
    r: enemy.cr, g: enemy.cg, b: enemy.cb,
    timer: 0,
    soundPlayed: false,
  })
  // DASH YOU FOOL — player within 200px when explosion starts, 1 min CD
  const player = getPlayer()
  const dx = player.x - enemy.x
  const dy = player.y - enemy.y
  if (dx * dx + dy * dy <= 200 * 200 && dashYouFoolCooldown <= 0) {
    dashYouFoolCooldown = 60
    showToast('DASH YOU FOOL!', { y: 0.14, duration: 1.5, size: 50, id: `dash_fool_${challengeElapsed}`, color: [255, 215, 64], style: 'heavy' })
  }
})

// Pending shrine spawns — delayed by one beat
interface PendingShrineSpawn {
  shrine: Enemy  // reference to the shrine entity
  shrineX: number; shrineY: number; shrineRadius: number; shrineColor: string
  playerX: number; playerY: number
  spawnEnemy: string; xpCount: number; hpCount: number
  timer: number  // counts down in seconds
  isLastHit: boolean  // shrine should die when this fires
}
const pendingShrineSpawns: PendingShrineSpawn[] = []

// Aftershock — delayed beat-dash detonations. Each entry is a pinned AOE that fires after
// `timer` seconds at the world position where the player dashed FROM. The extensible shape
// (damage, radius, etc. are captured at placement) lets future upgrades modify the queued
// detonation — e.g., bump radius, attach a chill effect, change damage — without rewriting
// the firing logic. Renderer reads these via getPendingDetonations() to draw the ticking pie.
export interface PendingDetonation {
  x: number
  y: number
  radius: number
  damage: number
  timer: number     // counts down to 0
  lifetime: number  // original delay — used for pie-fill progress
}
const pendingDetonations: PendingDetonation[] = []
export function getPendingDetonations(): readonly PendingDetonation[] { return pendingDetonations }

// Chill Zone (player upgrade) — single persistent slow-field. Each beat-dash replaces the
// active zone with a new one at the detonate position. When replaced, the OLD zone's
// position is flash-frozen: any enemy inside has their immobileTimer set to BEAT_SEC.
// Exported getter so the renderer can draw the zone marker on the arena floor.
export interface ChillZone { x: number; y: number; radius: number }
let activeChillZone: ChillZone | null = null
export function getActiveChillZone(): ChillZone | null { return activeChillZone }

// Placement-time work for any beat-dash — fires immediately whether or not Aftershock is
// active. Includes tutorial toasts, shrine activation, and summon-node tagging — these all
// depend on the PLAYER being where the dash starts (e.g., shrine requires "fully inside"),
// so delaying them wouldn't make sense and would actually break those mechanics.
function placeBeatDash(player: Player, shockRadius: number): void {
  if (getActiveChallenge()?.name === 'Beginner Challenge') {
    if (!firstBeatDashFired) {
      firstBeatDashFired = true
      showToast('You did the thing!', { y: 0.14, duration: 1.5, size: 42, id: 'first_beat_dash', color: [100, 255, 120] })
    }
    // Track consecutive beat dashes
    const currentBeat = Math.floor(getLoopPosition())
    if (lastBeatDashBeat >= 0 && currentBeat === lastBeatDashBeat + 1) {
      consecutiveBeatDashes++
    } else {
      consecutiveBeatDashes = 1
    }
    lastBeatDashBeat = currentBeat
    if (consecutiveBeatDashes === 2 && !doubleBeatDashFired) {
      doubleBeatDashFired = true
      showToast('2 in a row?! My hero <3', { y: 0.14, duration: 2, id: 'double_beat_dash', color: [100, 255, 120], style: 'glow', glowWords: ['hero', '<3'], glowColor: [255, 50, 200] })
    }
  }
  const enemies = getEnemies()
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.dying) continue
    // Shrine activation — player must be fully inside, 1 HP per beat-dash
    if (enemy.isShrine) {
      const dx = enemy.x - player.x
      const dy = enemy.y - player.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const playerBodyR = PLAYER_RADIUS * player.modifiers.sizeMult
      if (dist + playerBodyR <= enemy.radius) {
        // Player fully inside — deal 1 HP
        enemy.hp -= 1
        enemy.hitFlash = 0.75
        enemy.displayHp = enemy.hp
        playShrineHit()
        const shrineColor = enemy.color

        // Edge burst particles — localized to the segment that just died
        const er = parseInt(shrineColor.slice(1, 3), 16)
        const eg = parseInt(shrineColor.slice(3, 5), 16)
        const eb = parseInt(shrineColor.slice(5, 7), 16)
        const segments = enemy.maxHp
        const gapAngle = segments > 1 ? 0.08 : 0
        const segAngle = (Math.PI * 2 - gapAngle * segments) / segments
        const deadSegIdx = enemy.hp  // this segment just died (0-indexed after decrement)
        const segMid = -Math.PI / 2 + (deadSegIdx + 0.5) * (segAngle + gapAngle)
        const segSpread = segAngle * 0.5
        for (let p = 0; p < 18; p++) {
          const a = segMid + (Math.random() - 0.5) * segSpread * 2
          const edgeDist = enemy.radius * (0.85 + Math.random() * 0.15)
          const px = enemy.x + Math.cos(a) * edgeDist
          const py = enemy.y + Math.sin(a) * edgeDist
          const outA = Math.atan2(py - enemy.y, px - enemy.x)
          const speed = 150 + Math.random() * 200
          Renderer.spawnParticleExport(px, py,
            Math.cos(outA) * speed + (Math.random() - 0.5) * 60,
            Math.sin(outA) * speed + (Math.random() - 0.5) * 60,
            Math.min(255, er + 40), Math.min(255, eg + 20), Math.min(255, eb + 20),
            0.3 + Math.random() * 0.2, 4 + Math.random() * 3)
        }
        // White-hot sparks from the segment
        for (let p = 0; p < 6; p++) {
          const a = segMid + (Math.random() - 0.5) * segSpread
          const px = enemy.x + Math.cos(a) * enemy.radius
          const py = enemy.y + Math.sin(a) * enemy.radius
          const outA = Math.atan2(py - enemy.y, px - enemy.x)
          const speed = 200 + Math.random() * 250
          Renderer.spawnParticleExport(px, py,
            Math.cos(outA) * speed, Math.sin(outA) * speed,
            255, 255, 255, 0.2 + Math.random() * 0.1, 2.5 + Math.random() * 2)
        }

        // Blood splash inside shrine — spread across shrine area
        for (let p = 0; p < 30; p++) {
          const a = Math.random() * Math.PI * 2
          const dist = Math.random() * enemy.radius * 0.85
          const px = enemy.x + Math.cos(a) * dist
          const py = enemy.y + Math.sin(a) * dist
          const speed = 40 + Math.random() * 80
          const outA = Math.atan2(py - enemy.y, px - enemy.x) + (Math.random() - 0.5) * 1.5
          Renderer.spawnParticleExport(px, py,
            Math.cos(outA) * speed, Math.sin(outA) * speed,
            255, 40 + Math.floor(Math.random() * 50), 30 + Math.floor(Math.random() * 40),
            0.35 + Math.random() * 0.25, 4 + Math.random() * 4)
        }

        // Get current phase spawns
        const phase = enemy.shrinePhases.length > 0
          ? enemy.shrinePhases[enemy.shrineCurrentPhase]
          : null

        if (phase) {
          // Phase-based shrine
          if (phase.isShop) {
            openShop()
          } else {
            const spawnEnemy = phase.spawnEnemy ?? ''
            const xpCount = phase.xpOrbs ?? 0
            const hpCount = phase.hpOrbs ?? 0
            const spawnCount = phase.spawnCount ?? 1
            if (xpCount > 0 || hpCount > 0 || spawnEnemy) {
              enemy.shrineSummonTimer = BEAT_SEC * 0.5
              playShrineSummon()
              // Spawn multiple enemies if spawnCount > 1
              const effectiveSpawnEnemy = spawnCount > 1 ? `${spawnEnemy}:${spawnCount}` : spawnEnemy
              pendingShrineSpawns.push({
                shrine: enemy,
                shrineX: enemy.x, shrineY: enemy.y,
                shrineRadius: enemy.radius, shrineColor,
                playerX: player.x, playerY: player.y,
                spawnEnemy: effectiveSpawnEnemy,
                xpCount,
                hpCount,
                timer: BEAT_SEC * 0.5,
                isLastHit: enemy.hp <= 0,
              })
            }
          }
          enemy.shrineCurrentPhase++
          // Die after last phase
          if (enemy.hp <= 0) {
            enemy.dying = true
            enemy.deathTimer = 0
            spawnDrops(enemy, 1, spawnOrb)
            emit('enemy:killed', enemy)
          }
        } else {
          // Legacy flat shrine (no phases)
          if (enemy.shrineXpCount > 0 || enemy.shrineHpCount > 0 || enemy.shrineSpawnEnemy) {
            enemy.shrineSummonTimer = BEAT_SEC * 0.5
            playShrineSummon()
            pendingShrineSpawns.push({
              shrine: enemy,
              shrineX: enemy.x, shrineY: enemy.y,
              shrineRadius: enemy.radius, shrineColor,
              playerX: player.x, playerY: player.y,
              spawnEnemy: enemy.shrineSpawnEnemy,
              xpCount: enemy.shrineXpCount,
              hpCount: enemy.shrineHpCount,
              timer: BEAT_SEC * 0.5,
              isLastHit: enemy.hp <= 0,
            })
          }
          // Check death
          if (enemy.hp <= 0 && !enemy.shrineSpawnEnemy && enemy.shrineXpCount <= 0 && enemy.shrineHpCount <= 0) {
            enemy.dying = true
            enemy.deathTimer = 0
            spawnDrops(enemy, 1, spawnOrb)
            emit('enemy:killed', enemy)
          }
        }
      }
      continue
    }
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
        // Start run timer on first node hit
        if (!isRunTimerActive() && !isRunComplete()) {
          startRunTimer()
        }
      }
      continue
    }
  }
}

// Detonation-time work — the actual AOE damage, orb collect, audio, and visual shockwave.
// Runs immediately for instant beat-dashes and on a delay (next beat) when Aftershock is active.
// Position/radius/damage are passed in so a delayed detonation fires at the PINNED location
// (where the player dashed FROM), not wherever the player is at detonate time.
function detonateBeatDash(x: number, y: number, radius: number, damage: number): void {
  const player = getPlayer()
  const enemies = getEnemies()
  let beatDashHitCount = 0
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.dying) continue
    if (enemy.isShrine || enemy.summon) continue  // handled at placement; skip here so a delayed
                                                  // detonation can't double-tag a shrine/node
    const dx = enemy.x - x
    const dy = enemy.y - y
    const hitRange = radius + enemy.radius
    if (dx * dx + dy * dy <= hitRange * hitRange) {
      beatDashHitCount++
      const wasDying = enemy.dying
      damageEnemy(enemy, damage)
      enemy.beatDashFlash = HIT_FLASH_DURATION
      enemy.beatDashJustHit = true
      // Start run timer on first damage dealt
      if (!isRunTimerActive() && !isRunComplete()) {
        startRunTimer()
      }
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
  // Beat-dash beatdown — 5+ enemies hit with AOE
  if (beatDashHitCount >= 5 && beatDashBeatdownCD <= 0) {
    beatDashBeatdownCD = 30
    showToast('BEAT-DASH BEATDOWN!', { y: 0.14, duration: 1.5, size: 42, id: `beatdown_${challengeElapsed}`, color: [100, 255, 120], style: 'combo' })
  }

  // Collect orbs in blast area
  const allOrbs = getOrbs()
  for (const orb of allOrbs) {
    if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
    const odx = orb.x - x
    const ody = orb.y - y
    if (odx * odx + ody * ody <= (radius + orb.radius) * (radius + orb.radius)) {
      collectOrb(orb)
      if (orb.orbType === 'hp') {
        player.hp = Math.min(player.hp + 1, player.maxHp)
      } else {
        player.xp += orb.value * player.modifiers.xpMult
      }
    }
  }
  // SFX + Visual — shockwave flash on top of everything + particles
  playBeatDash()
  Renderer.triggerBeatDashFlash(x, y, radius)
  Renderer.spawnVolatileParticles(x, y, radius, 0, 230, 255)

  // Chill Zone — replace the active slow-field. If a previous zone existed, ice-shard burst
  // it: every enemy currently inside gets immobileTimer = BEAT_SEC (frozen feet for one beat,
  // attacks still tick). Then plant the new zone at the detonate position with 2× radius.
  // Overlap test uses (zone.radius + enemy.radius)² so any part of the enemy touching the
  // zone counts as inside — center-only would let big enemies have their body half-buried
  // in the zone without being affected.
  if (hasBonus('chillZone')) {
    const zoneR = radius * 2
    if (activeChillZone) {
      const oz = activeChillZone
      for (const enemy of enemies) {
        if (!enemy.alive || enemy.dying) continue
        const ddx = enemy.x - oz.x
        const ddy = enemy.y - oz.y
        const overlapR = oz.radius + enemy.radius
        if (ddx * ddx + ddy * ddy <= overlapR * overlapR) {
          enemy.immobileTimer = BEAT_SEC
        }
      }
      Renderer.spawnIceShardBurst(oz.x, oz.y, oz.radius)
      playIceShardBurst()
    } else {
      // First placement — small frost-crack puff so the upgrade has a tangible "I activated" beat
      Renderer.spawnFrostCrack(x, y, zoneR)
    }
    activeChillZone = { x, y, radius: zoneR }
    Renderer.setChillZoneViz(x, y, zoneR)
    playChillZonePlace()
  }
}

// On-beat dash shockwave — area damage at dash start position.
// With Aftershock: detonation is delayed by one beat and shown as a ticking-pie telegraph.
on('player:beatDash', (player: Player) => {
  // Beat-dash radius scales with beatBlastMult only — NOT ringRadiusMult. Ring-range
  // upgrades already grow the main ring; coupling them to the beat-dash too would let one
  // upgrade pull double duty.
  const shockRadius = player.ring.radius * 0.7 * player.modifiers.beatBlastMult
  const damage = player.damage * player.modifiers.damageMult
  placeBeatDash(player, shockRadius)
  if (hasBonus('aftershock')) {
    pendingDetonations.push({
      x: player.x, y: player.y,
      radius: shockRadius, damage,
      timer: BEAT_SEC, lifetime: BEAT_SEC,
    })
    Renderer.addPendingDetonation(player.x, player.y, shockRadius, BEAT_SEC)
    playFuseStart()
  } else {
    detonateBeatDash(player.x, player.y, shockRadius, damage)
  }

  // Echo Step — leapfrog anchor system. Capture the dash position as the NEW anchor; if a
  // previous anchor existed, kick off the ghost-traversal back to it. The new anchor stays
  // pinned at the spot the player pressed dash from (even after they warp away to the old
  // anchor), so the rhythm reads as a back-and-forth between two ever-shifting positions.
  if (hasBonus('anchorRecall')) {
    const newAnchorX = player.x
    const newAnchorY = player.y
    if (player.anchorActive) {
      player.recallFromX = player.x
      player.recallFromY = player.y
      player.recallToX = player.anchorX
      player.recallToY = player.anchorY
      player.recallTimer = RECALL_DURATION
      // Cancel the in-flight dash motion — the recall is taking over for the next 0.5s.
      // Without this, dashTimer keeps its remaining duration (it was paused while recall
      // had priority in updatePlayer), and once recall ends the dash motion branch resumes
      // and drifts the player away from the anchor for the leftover time.
      player.dashTimer = -1
      playRecallStart()
    }
    player.anchorX = newAnchorX
    player.anchorY = newAnchorY
    player.anchorActive = true
  }
})

// Shield audio events
on('player:shieldBreak', () => {
  playShieldBreak()
  const player = getPlayer()
  startShieldFuseBurn(player.shieldRechargeTime)
  shieldBreakCount++
  if (shieldBreakCount <= 1 && getActiveChallenge()?.name === 'Beginner Challenge') {
    showToast('Shield Down :(', { y: 0.14, duration: 1.5, fadeOut: 0.3, id: 'shield_down', color: [255, 50, 200], style: 'sad' })
  }
})
on('player:shieldRestore', (player: Player) => {
  stopShieldFuseBurn()
  playShieldRestore()
  shieldRechargeCount++
  if (shieldRechargeCount <= 1 && getActiveChallenge()?.name === 'Beginner Challenge') {
    showToast('Shield UP!', { y: 0.14, duration: 1.5, size: 42, id: 'shield_up', color: [255, 50, 200], style: 'glow', glowWords: ['UP!'], glowColor: [255, 50, 200] })
  }
  // Clutch shield — toast when shield activates while at 1 or 2 HP
  if (player.hp <= 2 && clutchShieldCooldown <= 0) {
    clutchShieldCooldown = 30
    const msg = CLUTCH_SHIELD_TOASTS[Math.floor(Math.random() * CLUTCH_SHIELD_TOASTS.length)]!
    showToast(msg, { y: 0.14, duration: 1.8, size: 42, id: `clutch_shield_${challengeElapsed}`, color: [255, 50, 200], style: 'wave' })
  }
  // Dumb and Dumber — once per challenge, shield activation at 3 HP
  if (player.hp === 3 && !dumbAndDumberFired) {
    dumbAndDumberFired = true
    showToast("32.33 repeating of course, % chance of survival", { y: 0.14, duration: 4, size: 42, id: 'dumb_and_dumber', color: [255, 50, 200], style: 'normal' })
  }
  // Leeroy — once per challenge, shield activation at 4 HP
  if (player.hp === 4 && !leeroyShieldFired) {
    leeroyShieldFired = true
    showToast("TIME'S UP. LET'S DO THIS.", { y: 0.14, duration: 2.5, size: 46, id: 'leeroy_shield', color: [255, 50, 200], style: 'heavy' })
  }
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
  // Summon toasts — per challenge
  const chName = getActiveChallenge()?.name
  if (chName === 'Challenge 2') {
    summonToastCount++
    if (summonToastCount === 1) {
      showToast('MY BABIES WILL EAT YOUR HEALTH!', { y: 0.14, duration: 2, size: 46, id: 'babies', color: [255, 50, 50], style: 'combo' })
    } else if (summonToastCount === 2) {
      showToast('A lovely surprise inside!', { y: 0.14, duration: 2, size: 42, id: 'lovely_surprise' })
    } else if (summonToastCount === 3) {
      showToast("You can run, but you can't hide.", { y: 0.14, duration: 2, size: 42, id: 'cant_hide', color: [255, 200, 220], style: 'glow', glowWords: ['run,', 'hide.'], glowColor: [255, 150, 255] })
    }
  }
  if (chName === 'Challenge 1') {
    summonToastCount++
    if (summonToastCount === 1) {
      showToast("Let's GOOOO!", { y: 0.14, duration: 1.5, size: 62, id: 'lets_go', color: [255, 215, 64], style: 'combo' })
    } else if (summonToastCount === 2) {
      showToast('ZIG-ZAG-ZOOM!', { y: 0.14, duration: 1.5, size: 53, id: 'zigzag', color: [255, 80, 80], style: 'zigzag' })
    } else if (summonToastCount === 3) {
      showToast('BOUNCY BOY TIME!', { y: 0.14, duration: 1.5, size: 53, id: 'bouncy_boy', color: [255, 160, 80], style: 'combo' })
    } else if (summonToastCount === 4) {
      showToast('BEEFY BOY TIME!', { y: 0.14, duration: 2, size: 62, id: 'beefy_boy', color: [0, 200, 220], style: 'heavy' })
    } else if (summonToastCount === 5) {
      showToast('FIRE IN THE HOLE!', { y: 0.14, duration: 1.5, size: 53, id: 'fire_hole', color: [255, 120, 30], style: 'explosive' })
    } else if (summonToastCount === 6) {
      showToast('HIDE YOUR HEARTS!', { y: 0.14, duration: 1.5, size: 53, id: 'hide_hearts', color: [200, 60, 180], style: 'glow', glowWords: ['HEARTS!'], glowColor: [200, 60, 180] })
    } else if (summonToastCount === 7) {
      showToast('RELEASE THE KRA- CIRCLE!', { y: 0.14, duration: 2, size: 58, id: 'kraken', color: [255, 215, 64], style: 'heavy' })
    }
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

let lowHpToastFired = false
let criticalHpCooldown = 0
const CRITICAL_HP_TOASTS = [
  'HP IS A SUGGESTION',
  'THIS IS FINE.',
  'BUTTHOLE TIGHTENED',
  'JUST DODGE BRO',
  'MAYDAY MAYDAY',
  'MEDIC!',
  'MOMMY?',
  "HE'S DYING JIM!",
]
let clutchShieldCooldown = 0
let dumbAndDumberFired = false
let leeroyShieldFired = false
let swimmingFired = false
let shieldUpTime = 0
let pushHarderFired = false
let pushingEnemy: Enemy | null = null
let pushDuration = 0
let pushedThisFrame: Enemy | null = null
let heartsDeliciousCooldown = 0
let dangerousStartFired = false
let backFromDeadFired = false
let lastHit1HpTime = -1
let massExtinctionFired = false
const explosionKillTimes: number[] = []
let lastBouncerOnlyStart = -1
let runRunFired = false
let bouncyBallManFired = false
const CLUTCH_SHIELD_TOASTS = [
  'HE PROTEC',
  'PHEW',
  'BUBBLE WRAPPED',
  'PROTECTED FRFR',
  'SHIELD ON. APPLY DIRECTLY TO CIRCUMFERENCE.',
  'BUBBLE HEARTH!',
]
let lastHitTime = 0
let doSomethingFired = false
let doSomethingCooldown = 0
let noobToastFired = false
let vibeCodedToastFired = false
let dashYouFoolCooldown = 0
let boomToastFired = false
let shieldRechargeCount = 0
let shieldBreakCount = 0
let challengeElapsed = 0
let aliveToastFired = false
let finishHimFired = false
let lastMoveTime = 0
let afkFired = false
let minuteToastCount = 0
const MINUTE_TOASTS = [
  'Are you still here?',
  'I can do this all day.',
  'Plot armor detected.',
  'Main character energy.',
  'Somebody stop this circle.',
  "He's beginning to believe.",
  'This one sparks joy.',
  "We're in the endgame now.",
  "They don't know I'm built different.",
  'Do a barrel roll!',
]
let recentKills = 0
let recentKillTimer = 0
let comboFired = false
let consecutiveAttackKills = 0
let killSpreeFired = false
let attacksSinceLastKill = 0
let prevAttackTimer = -1
let recentHpCollected = 0
let recentHpTimer = 0
let prevPlayerHp = 0
let lastDashTime = 0
let doubleDashFired = false
let prevDashSlotSum = 0
let wallDashCheckTimer = 0
let wallDashStartX = 0
let wallDashStartY = 0
let wallDashFired = false
let beatDashBeatdownCD = 0
let explosionTimes: number[] = []
let boomBoomPowFired = false
let firstBeatDashFired = false
let missedStep2Count = 0
let missedStep3Count = 0
let hitLightFired = false
let summonToastCount = 0
let waitingSummonTimer = 0
let waitingSummonFired = 0
let prevSummonProgress: Map<Enemy, number> = new Map()
let consecutiveBeatDashes = 0
let lastBeatDashBeat = -1
let doubleBeatDashFired = false
let leroyFired = false
let leroyDashStartNearby = 0
let leroyCheckTimer = 0
let totemSpawnCount = 0
let totemSpawnWindowStart = 0
let grimPatronFired = false

// Closest point on a wall (straight capsule or arc) to a query point. Used by spring
// processing to compute the wall normal at each entity contact.
function closestPointOnWall(w: Wall, x: number, y: number): { x: number; y: number } {
  const arc = computeWallArc(w)
  if (arc) {
    const dx = x - arc.cx
    const dy = y - arc.cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < 0.01) return { x: arc.cx + arc.r, y: arc.cy }
    // Approximate by projecting to arc circle; for spring purposes this is close enough
    // even for points just past the arc endpoints — overlap test will reject far-off cases.
    return { x: arc.cx + (dx / dist) * arc.r, y: arc.cy + (dy / dist) * arc.r }
  }
  const abx = w.bx - w.ax
  const aby = w.by - w.ay
  const apx = x - w.ax
  const apy = y - w.ay
  const ab2 = abx * abx + aby * aby
  let t = 0
  if (ab2 > 0.01) {
    t = (apx * abx + apy * aby) / ab2
    if (t < 0) t = 0
    else if (t > 1) t = 1
  }
  return { x: w.ax + abx * t, y: w.ay + aby * t }
}

interface LaunchTarget { x: number; y: number; launchVx: number; launchVy: number; launchTimer: number }
function applyLaunch(entity: LaunchTarget, dx: number, dy: number, dist2: number, strength: number): void {
  let nx: number, ny: number
  if (dist2 < 0.01) { nx = 1; ny = 0 }
  else { const d = Math.sqrt(dist2); nx = dx / d; ny = dy / d }
  // Anti-cancel: if existing launch is OPPOSING the spring direction, remove 70% of that
  // opposition before adding the new impulse. Without this, two opposite-direction springs
  // cancel exactly (Sum of forces = 0), and you ricochet between two walls feels broken.
  // Cumulative behavior is preserved when launches are SAME-direction (projection > 0).
  const projOnNormal = entity.launchVx * nx + entity.launchVy * ny
  if (projOnNormal < 0) {
    const removeFrac = 0.7
    entity.launchVx -= projOnNormal * nx * removeFrac
    entity.launchVy -= projOnNormal * ny * removeFrac
  }
  entity.launchVx += nx * strength
  entity.launchVy += ny * strength
  // 0.28s total = snappier punch (peak → ~30% via 0.04 decay) + smooth fade-tail. Player
  // integration applies a fade multiplier in the last 0.10s so the launch eases to zero
  // instead of snapping. Input runs in parallel → DI steers the trajectory mid-bounce.
  entity.launchTimer = Math.max(entity.launchTimer, 0.28)
}

/** Resolve a single orb↔other collision using the battering-ram rules. The orb pass in
 * GameManager runs in two places (real-game update + designer update), and both call this.
 *
 * Rules (consistent with Enemy↔Enemy separation in Enemy.ts):
 *   - other is immovable enemy → orb takes full overlap, other unmoved
 *   - orb launched, other not  → orb plows through (no self-push), other shoved fully aside
 *   - other launched, orb not  → orb gets out of the way (full self-push), other unmoved
 *   - both launched (or neither) → split 0.5/0.5 (mild mutual nudge to avoid permanent stack) */
function resolveOrbCollision(
  orb: XPOrb,
  other: XPOrb | Enemy,
  isEnemy: boolean,
  nx: number,
  ny: number,
  total: number,
): void {
  const isImmovableEnemy = isEnemy && (other as Enemy).immovable
  const launchedOrb = orb.launchTimer > 0
  const launchedOther = other.launchTimer > 0
  let orbPush: number, otherPush: number
  if (isImmovableEnemy) {
    orbPush = total; otherPush = 0
  } else if (launchedOrb && !launchedOther) {
    orbPush = 0; otherPush = total
  } else if (!launchedOrb && launchedOther) {
    orbPush = total; otherPush = 0
  } else {
    orbPush = total * 0.5; otherPush = total * 0.5
  }
  orb.x += nx * orbPush
  orb.y += ny * orbPush
  if (otherPush > 0) {
    other.x -= nx * otherPush
    other.y -= ny * otherPush
  }
}

/** Drain queued spring fires from Arena and apply launch impulses to overlapping entities.
 * Affects player, alive enemies (including immovable and immobilized), and orbs.
 *
 * `SPRING_TRIGGER_BUFFER` adds a small gap so the spring catches entities that are pressed
 * against the wall. Wall collision pushes overlapping entities out to EXACTLY `wallR + entR`
 * distance, so strict overlap (`d² < reach²`) misses anything resting on the wall surface —
 * which is precisely the case the spring should fire on. 12px buffer = "very close, not
 * strictly inside" — also catches fast-moving entities that briefly graze a wall mid-frame. */
const SPRING_TRIGGER_BUFFER = 11
// Grace window — after a spring fires, it stays "active" for this many beats. Any entity
// that enters trigger range during the window gets pushed (once per fire). Catches the
// case where a dash arrives at the wall right after the fire moment — without this, you'd
// miss by a single frame and the spring would feel unreliable.
const SPRING_GRACE_BEATS = 0.22
// Per-fire entity tracker — keyed by wall, holds the set of entities already pushed by
// the wall's current fire. WeakMap means walls can be garbage-collected without leaking.
const springPushedThisFire = new WeakMap<Wall, Set<unknown>>()
const HEAVY_RESIST = 0.5

function tryPushSpring(
  w: Wall,
  player: ReturnType<typeof getPlayer>,
  enemies: ReturnType<typeof getEnemies>,
  orbs: ReturnType<typeof getOrbs>,
  playerR: number,
): void {
  if (!w.spring) return
  const pushed = springPushedThisFire.get(w)
  if (!pushed) return
  const strength = w.spring.strength
  // The pushed-set tracks who is CURRENTLY in range and has already been launched by this
  // fire. Important: when an entity leaves the trigger range, we REMOVE them from the set
  // so that if they come back into range during the grace window (e.g. another spring
  // bounces them back, or a pusher enemy chases them in), they get pushed again. Without
  // this removal the set was permanently "sticky" per-fire and missed those re-entries.
  if (player.recallTimer < 0) {
    const cp = closestPointOnWall(w, player.x, player.y)
    const dx = player.x - cp.x
    const dy = player.y - cp.y
    const d2 = dx * dx + dy * dy
    const reach = w.radius + playerR + SPRING_TRIGGER_BUFFER
    if (d2 < reach * reach) {
      if (!pushed.has(player)) {
        if (player.dashTimer >= 0) player.dashTimer = -1
        applyLaunch(player, dx, dy, d2, strength)
        pushed.add(player)
      }
    } else {
      pushed.delete(player)
    }
  }
  for (const e of enemies) {
    if (!e.alive || e.dying) continue
    const cp = closestPointOnWall(w, e.x, e.y)
    const dx = e.x - cp.x
    const dy = e.y - cp.y
    const d2 = dx * dx + dy * dy
    const reach = w.radius + e.radius + SPRING_TRIGGER_BUFFER
    if (d2 < reach * reach) {
      if (!pushed.has(e)) {
        applyLaunch(e, dx, dy, d2, e.immovable ? strength * HEAVY_RESIST : strength)
        pushed.add(e)
      }
    } else {
      pushed.delete(e)
    }
  }
  for (const o of orbs) {
    if (!o.alive || o.dying) continue
    const cp = closestPointOnWall(w, o.x, o.y)
    const dx = o.x - cp.x
    const dy = o.y - cp.y
    const d2 = dx * dx + dy * dy
    const reach = w.radius + o.radius + SPRING_TRIGGER_BUFFER
    if (d2 < reach * reach) {
      if (!pushed.has(o)) {
        applyLaunch(o, dx, dy, d2, strength)
        pushed.add(o)
      }
    } else {
      pushed.delete(o)
    }
  }
}

function processSpringFires(): void {
  const fires = consumeSpringFires()
  const player0 = getPlayer()
  const enemies0 = getEnemies()
  const orbs0 = getOrbs()
  const playerR0 = PLAYER_RADIUS * player0.modifiers.sizeMult
  // Pass 1 — fresh fires: reset the wall's "pushed this fire" set, then push everything
  // currently overlapping the trigger range.
  if (fires.length > 0) {
    for (const fire of fires) {
      const w = fire.wall
      if (!w.spring) continue
      springPushedThisFire.set(w, new Set())
      tryPushSpring(w, player0, enemies0, orbs0, playerR0)
    }
  }
  // Pass 2 — grace window: re-check overlap for any spring whose last fire was within
  // SPRING_GRACE_BEATS. Each entity is pushed at most once per fire (see tryPushSpring's
  // `pushed.has(...)` checks). When the grace expires, drop the tracker so the next fire
  // starts fresh.
  const beatPosForGrace = getAbsoluteBeats()
  const wallsLiveGrace = getWalls()
  for (const w of wallsLiveGrace) {
    if (!w.spring || w.springLastFireBeat == null) continue
    if (!springPushedThisFire.has(w)) continue
    const beatsSinceFire = beatPosForGrace - w.springLastFireBeat
    if (beatsSinceFire <= 0) continue
    if (beatsSinceFire > SPRING_GRACE_BEATS) {
      springPushedThisFire.delete(w)
      continue
    }
    tryPushSpring(w, player0, enemies0, orbs0, playerR0)
  }

  // Audio PRE-SCHEDULING — every frame, look at each spring wall's NEXT upcoming fire and
  // schedule its audio in advance at the exact target time. Web Audio API plays scheduled-
  // future audio sample-accurately (no output-latency hit). This is how the music itself
  // stays tight to the beat. Lookahead of 0.5 beats = up to 500ms early at 60bpm — plenty
  // of headroom for the audio system. Tracked per-wall via springScheduledAudioBeat so we
  // don't re-schedule the same fire.
  const beatPos = getAbsoluteBeats()
  const AUDIO_LOOKAHEAD_BEATS = 0.5
  const bz = getBeatZeroTime()
  const wallsLive = getWalls()
  for (const w of wallsLive) {
    if (!w.spring || w.springLastFireBeat == null) continue
    const nextFire = w.springLastFireBeat + w.spring.beatsPerCycle
    if (nextFire - beatPos > AUDIO_LOOKAHEAD_BEATS) continue
    if (nextFire <= beatPos) continue   // already past — handled by "play now" path below
    if (w.springScheduledAudioBeat != null && w.springScheduledAudioBeat >= nextFire) continue
    playWallSpringFire(bz + nextFire * BEAT_SEC)
    w.springScheduledAudioBeat = nextFire
  }
  // Fallback for the FIRST fire of a fresh wall — no advance schedule was possible because
  // we didn't know the lastFireBeat yet. Play asap on detection (slight latency for fire #1
  // only; subsequent fires are pre-scheduled and locked to the music clock).
  for (const fire of fires) {
    if (fire.wall.spring && fire.wall.springScheduledAudioBeat !== fire.targetBeat) {
      playWallSpringFire()   // asap; this fire's audio will be slightly late, but only once
      fire.wall.springScheduledAudioBeat = fire.targetBeat
      break   // playWallSpringFire is throttled — one call is enough for this frame
    }
  }
}

// Pusher enemies — kinematically shove nearby entities on-beat. Mirrors the wall spring
// firing logic exactly (beat-aligned to the music's downbeat via BEAT_AUDIO_OFFSET, grace
// window via WeakMap-pushed-set, audio pre-scheduled 0.5 beats ahead). Pushes are pure
// kinematics — no damage, no shield break, no revenge trigger. Self-exclusion: a pusher
// never pushes itself; otherwise pushes player, OTHER enemies (including other pushers),
// and orbs.
const PUSHER_BEAT_AUDIO_OFFSET = 0.37   // matches BeatLoop's music kick offset
const pusherPushedThisFire = new WeakMap<Enemy, Set<unknown>>()

function tryPushPusher(
  source: Enemy,
  player: ReturnType<typeof getPlayer>,
  enemies: ReturnType<typeof getEnemies>,
  orbs: ReturnType<typeof getOrbs>,
  playerR: number,
): void {
  const pushed = pusherPushedThisFire.get(source)
  if (!pushed) return
  const strength = source.pusherStrength
  // Same "remove on exit" pattern as tryPushSpring. Especially important here because the
  // pusher itself can be launched into the player by another bounce — when that happens
  // we want the player to get pushed again as the pusher catches up, even though the
  // player was already pushed by this fire's initial Pass 1.
  if (player.recallTimer < 0) {
    const dx = player.x - source.x
    const dy = player.y - source.y
    const d2 = dx * dx + dy * dy
    const reach = source.radius + playerR + SPRING_TRIGGER_BUFFER
    if (d2 < reach * reach) {
      if (!pushed.has(player)) {
        if (player.dashTimer >= 0) player.dashTimer = -1
        applyLaunch(player, dx, dy, d2, strength)
        pushed.add(player)
      }
    } else {
      pushed.delete(player)
    }
  }
  for (const e of enemies) {
    if (e === source || !e.alive || e.dying) continue
    const dx = e.x - source.x
    const dy = e.y - source.y
    const d2 = dx * dx + dy * dy
    const reach = source.radius + e.radius + SPRING_TRIGGER_BUFFER
    if (d2 < reach * reach) {
      if (!pushed.has(e)) {
        applyLaunch(e, dx, dy, d2, e.immovable ? strength * HEAVY_RESIST : strength)
        pushed.add(e)
      }
    } else {
      pushed.delete(e)
    }
  }
  for (const o of orbs) {
    if (!o.alive || o.dying) continue
    const dx = o.x - source.x
    const dy = o.y - source.y
    const d2 = dx * dx + dy * dy
    const reach = source.radius + o.radius + SPRING_TRIGGER_BUFFER
    if (d2 < reach * reach) {
      if (!pushed.has(o)) {
        applyLaunch(o, dx, dy, d2, strength)
        pushed.add(o)
      }
    } else {
      pushed.delete(o)
    }
  }
}

function processPusherEnemies(): void {
  const beatPos = getAbsoluteBeats()
  const player0 = getPlayer()
  const enemies0 = getEnemies()
  const orbs0 = getOrbs()
  const playerR0 = PLAYER_RADIUS * player0.modifiers.sizeMult
  const bz = getBeatZeroTime()
  const AUDIO_LOOKAHEAD_BEATS = 0.5
  // Pass 1 — detect new fires (beat-aligned). On fire: clear push tracker, mark transient
  // flag, push currently overlapping entities.
  for (const e of enemies0) {
    if (!e.pusher || !e.alive || e.dying) continue
    const cycle = e.pusherBeats
    if (cycle <= 0) continue
    const effectivePhase = e.pusherPhase + PUSHER_BEAT_AUDIO_OFFSET
    let nextFire: number
    if (e.pusherLastFireBeat == null) {
      nextFire = Math.ceil((beatPos - effectivePhase) / cycle) * cycle + effectivePhase
      if (nextFire <= beatPos) nextFire += cycle
      e.pusherLastFireBeat = nextFire - cycle
    } else {
      nextFire = e.pusherLastFireBeat + cycle
    }
    if (beatPos >= nextFire) {
      e.pusherLastFireBeat = nextFire
      e.pusherJustFired = true
      pusherPushedThisFire.set(e, new Set())
      tryPushPusher(e, player0, enemies0, orbs0, playerR0)
    }
  }
  // Pass 2 — grace window (same SPRING_GRACE_BEATS as walls — keeps push rules consistent).
  for (const e of enemies0) {
    if (!e.pusher || e.pusherLastFireBeat == null) continue
    if (!pusherPushedThisFire.has(e)) continue
    const beatsSinceFire = beatPos - e.pusherLastFireBeat
    if (beatsSinceFire <= 0) continue
    if (beatsSinceFire > SPRING_GRACE_BEATS) {
      pusherPushedThisFire.delete(e)
      continue
    }
    tryPushPusher(e, player0, enemies0, orbs0, playerR0)
  }
  // Pass 3 — audio pre-schedule (sample-accurate, locked to the music clock).
  for (const e of enemies0) {
    if (!e.pusher || e.pusherLastFireBeat == null) continue
    const nextFire = e.pusherLastFireBeat + e.pusherBeats
    if (nextFire - beatPos > AUDIO_LOOKAHEAD_BEATS) continue
    if (nextFire <= beatPos) continue
    if (e.pusherScheduledAudioBeat != null && e.pusherScheduledAudioBeat >= nextFire) continue
    playWallSpringFire(bz + nextFire * BEAT_SEC)
    e.pusherScheduledAudioBeat = nextFire
  }
}

export function resetPendingEffects(): void {
  pendingExplosions.length = 0
  pendingRevenges.length = 0
  pendingShrineSpawns.length = 0
  pendingDetonations.length = 0
  activeChillZone = null
  Renderer.clearChillZoneViz()
  lowHpToastFired = false
  criticalHpCooldown = 0
  clutchShieldCooldown = 0
  dumbAndDumberFired = false
  leeroyShieldFired = false
  swimmingFired = false
  shieldUpTime = 0
  pushHarderFired = false
  pushingEnemy = null
  pushDuration = 0
  heartsDeliciousCooldown = 0
  dangerousStartFired = false
  backFromDeadFired = false
  lastHit1HpTime = -1
  massExtinctionFired = false
  explosionKillTimes.length = 0
  lastBouncerOnlyStart = -1
  runRunFired = false
  bouncyBallManFired = false
  resetDashCDToast(getActiveChallenge()?.name === 'Beginner Challenge')
  noobToastFired = false
  vibeCodedToastFired = false
  dashYouFoolCooldown = 0
  lastHitTime = 0
  doSomethingFired = false
  doSomethingCooldown = 0
  boomToastFired = false
  shieldRechargeCount = 0
  shieldBreakCount = 0
  challengeElapsed = 0
  aliveToastFired = false
  finishHimFired = false
  lastMoveTime = 0
  afkFired = false
  minuteToastCount = 0
  recentKills = 0
  recentKillTimer = 0
  comboFired = false
  consecutiveAttackKills = 0
  killSpreeFired = false
  attacksSinceLastKill = 0
  prevAttackTimer = -1
  recentHpCollected = 0
  recentHpTimer = 0
  prevPlayerHp = -1  // -1 = uninitialized, will sync on first frame
  lastDashTime = 0
  doubleDashFired = false
  prevDashSlotSum = 0
  wallDashCheckTimer = 0
  wallDashFired = false
  beatDashBeatdownCD = 0
  explosionTimes = []
  boomBoomPowFired = false
  firstBeatDashFired = false
  missedStep2Count = 0
  missedStep3Count = 0
  hitLightFired = false
  summonToastCount = 0
  waitingSummonTimer = 0
  waitingSummonFired = 0
  prevSummonProgress = new Map()
  consecutiveBeatDashes = 0
  lastBeatDashBeat = -1
  doubleBeatDashFired = false
  leroyFired = false
  leroyDashStartNearby = 0
  leroyCheckTimer = 0
  totemSpawnCount = 0
  totemSpawnWindowStart = 0
  grimPatronFired = false
}

function updateDesigner(dt: number): void {
  tickAudioHealth()
  advanceGlobalTime(dt)
  advancePatternClock(dt)
  // Tick wall motion in designer too (so test-play sees rotating walls without leaving the
  // designer). Frozen when the user has zoomed out to see the whole arena — they want a
  // stable view to author against. Uses absolute beats so wall cycles longer than the song
  // loop don't snap backwards on wrap.
  if (!Renderer.isDesignerZoomedOut()) {
    updateWalls(getAbsoluteBeats())
    processSpringFires()
    processPusherEnemies()
  }
  Input.flush()
  const player = getPlayer()
  const cam = getCamera()
  const enemies = getEnemies()
  const grid = getGrid()
  updatePlayer(player, dt)
  // Tick all alive enemies (spawn-test ephemerals AND any children they summon — totems,
  // shrines, summoners. Without this, summoned children stay frozen at spawn radius 1 = "tiny specs").
  // Player can take damage normally — but won't die because death check is gated to phase 'playing'.
  grid.clear()
  for (const e of enemies) {
    if (e.alive) grid.insert(e)
  }
  for (const orb of getOrbs()) {
    if (orb.alive && !orb.dying) grid.insert(orb)
  }
  // Process queued volatile explosions so designer-spawned exploders actually detonate
  processVolatileExplosions(player, enemies, dt)
  // Process pending Aftershock detonations in designer too — without this the fuse pie
  // ticks visually (see Renderer designer-phase check) but the boom never fires.
  for (let i = pendingDetonations.length - 1; i >= 0; i--) {
    const pd = pendingDetonations[i]!
    pd.timer -= dt
    if (pd.timer <= 0) {
      detonateBeatDash(pd.x, pd.y, pd.radius, pd.damage)
      pendingDetonations[i] = pendingDetonations[pendingDetonations.length - 1]!
      pendingDetonations.pop()
    }
  }
  // Chill Zone presence check in designer — mirrors the main pass so the slow/immobile
  // visuals work during test play too.
  if (activeChillZone) {
    const cz = activeChillZone
    for (const e of enemies) {
      if (!e.alive || e.dying) { e.zoneSlowFrac = 0; continue }
      const ddx = e.x - cz.x
      const ddy = e.y - cz.y
      const overlapR = cz.radius + e.radius
      e.zoneSlowFrac = (ddx * ddx + ddy * ddy <= overlapR * overlapR) ? 0.5 : 0
    }
  } else {
    for (const e of enemies) {
      if (e.zoneSlowFrac !== 0) e.zoneSlowFrac = 0
    }
  }
  for (const e of enemies) {
    if (e.dying) updateDeath(e, dt)
    else if (e.alive) updateEnemy(e, player, dt, grid)
  }
  // Ritual nodes (orbiting nodes around summoners) — without this, summoner nodes are frozen.
  updateRitualNodes(dt)
  // Tick orbs (grow-in, animations). Player pushes orbs aside on contact — collection happens
  // via the ring sweep (HitDetection's player:beat handler), same as real game.
  updateOrbs(dt)
  const orbs = getOrbs()
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
      orb.x += nx * overlap * 0.85
      orb.y += ny * overlap * 0.85
      player.x -= nx * overlap * 0.15
      player.y -= ny * overlap * 0.15
    }
  }
  // Orb separation (grid-accelerated, mirrors real-game pass). Uses resolveOrbCollision
  // helper so the battering-ram rules stay in sync with the real-game pass below.
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
        resolveOrbCollision(orb, other as XPOrb | Enemy, isEnemy, dx / dist, dy / dist, minDist - dist)
      }
    }
    const oc = clampToArena(orb.x, orb.y, orb.radius)
    orb.x = oc.x
    orb.y = oc.y
    const ow = resolveWallCollision(orb.x, orb.y, orb.radius)
    orb.x = ow.x
    orb.y = ow.y
  }
  cleanupOrbs()
  // Enemy-vs-enemy separation
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.dying) continue
    const nearby = grid.query(enemy)
    for (const other of nearby) {
      if (other === enemy || !('hp' in other)) continue
      const oe = other as Enemy
      if (!oe.alive || oe.dying) continue
      const minDist = enemy.radius + oe.radius
      const dx = enemy.x - oe.x
      const dy = enemy.y - oe.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < minDist && dist > 0.1) {
        const nx = dx / dist
        const ny = dy / dist
        const overlap = minDist - dist
        // Mirror real-game asymmetric mass: dasher plows normal (80/20).
        if (oe.immovable && enemy.immovable) {
          // Both immovable — split the overlap evenly so they don't stack
          enemy.x += nx * overlap * 0.5; enemy.y += ny * overlap * 0.5
          oe.x    -= nx * overlap * 0.5; oe.y    -= ny * overlap * 0.5
        } else if (oe.immovable) {
          enemy.x += nx * overlap; enemy.y += ny * overlap
        } else if (enemy.immovable) {
          oe.x -= nx * overlap; oe.y -= ny * overlap
        } else {
          const aDashing = enemy.dodge && enemy.dashTimer >= 0
          const bDashing = oe.dodge && oe.dashTimer >= 0
          if (aDashing && !bDashing) {
            enemy.x += nx * overlap * 0.05; enemy.y += ny * overlap * 0.05
            oe.x    -= nx * overlap * 0.95; oe.y    -= ny * overlap * 0.95
          } else if (!aDashing && bDashing) {
            enemy.x += nx * overlap * 0.95; enemy.y += ny * overlap * 0.95
            oe.x    -= nx * overlap * 0.05; oe.y    -= ny * overlap * 0.05
          } else {
            const half = overlap * 0.5
            enemy.x += nx * half; enemy.y += ny * half
            oe.x    -= nx * half; oe.y    -= ny * half
          }
        }
      }
    }
    const ec = clampToArena(enemy.x, enemy.y, enemy.radius)
    enemy.x = ec.x; enemy.y = ec.y
  }
  // Player-vs-enemy push (mirrors line 1736)
  for (const enemy of enemies) {
    if (!enemy.alive || enemy.dying || enemy.isShrine) continue
    const minDist = enemy.radius + player.hitRadius
    const dx = player.x - enemy.x
    const dy = player.y - enemy.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < minDist && dist > 0.1) {
      const overlap = minDist - dist
      const nx = dx / dist
      const ny = dy / dist
      if (enemy.immovable) {
        enemy.x -= nx * overlap * 0.15
        enemy.y -= ny * overlap * 0.15
        player.x += nx * overlap * 0.85
        player.y += ny * overlap * 0.85
        const ec = clampToArena(enemy.x, enemy.y, enemy.radius)
        enemy.x = ec.x; enemy.y = ec.y
      } else if (enemy.dodge && enemy.dashTimer >= 0) {
        enemy.x -= nx * overlap * 0.05
        enemy.y -= ny * overlap * 0.05
        player.x += nx * overlap * 0.95
        player.y += ny * overlap * 0.95
      } else {
        player.x += nx * overlap * 0.2
        player.y += ny * overlap * 0.2
        enemy.x -= nx * overlap * 0.8
        enemy.y -= ny * overlap * 0.8
      }
    }
  }
  const pc = clampToArena(player.x, player.y, player.hitRadius)
  player.x = pc.x; player.y = pc.y
  // Drop dead/cleaned enemies (ephemerals + their offspring)
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i]!
    if (!e.alive && !e.dying) enemies.splice(i, 1)
  }
  const dir = Input.getMovementDir()
  updateCamera(cam, player.x, player.y, dir.x, dir.y, Renderer.getLogicalSize().w, Renderer.getLogicalSize().h, dt)
  updatePreviewEnemy(dt)
}

export function clearDesignerEphemerals(): void {
  // Wipe all enemies (ephemeral spawn-test + any children they summoned) + orbs they dropped.
  // The designer scene should be empty unless the user re-spawns.
  const enemies = getEnemies()
  enemies.length = 0
  resetOrbs()
}

export function update(dt: number): void {
  const phase = getPhase()

  if (phase === 'designer') {
    updateDesigner(dt)
    return
  }
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

  // Process pending shrine spawns
  for (let i = pendingShrineSpawns.length - 1; i >= 0; i--) {
    const ps = pendingShrineSpawns[i]!
    ps.timer -= dt
    if (ps.timer <= 0) {
      pendingShrineSpawns.splice(i, 1)
      // Spawn XP orbs
      const totalOrbs = ps.xpCount + ps.hpCount
      let orbIdx = 0
      for (let o = 0; o < ps.xpCount; o++, orbIdx++) {
        const angle = (orbIdx / Math.max(1, totalOrbs)) * Math.PI * 2 + Math.random() * 0.3
        const orbDist = ps.shrineRadius + 30 + Math.random() * 40
        const ox = ps.shrineX + Math.cos(angle) * orbDist
        const oy = ps.shrineY + Math.sin(angle) * orbDist
        spawnOrb(ox, oy, 1, 'xp')
        Renderer.addSpawnEffect(ps.shrineX, ps.shrineY, ps.shrineRadius, ox, oy, ps.shrineColor)
      }
      // Spawn HP orbs
      for (let o = 0; o < ps.hpCount; o++, orbIdx++) {
        const angle = (orbIdx / Math.max(1, totalOrbs)) * Math.PI * 2 + Math.random() * 0.3
        const orbDist = ps.shrineRadius + 30 + Math.random() * 40
        const ox = ps.shrineX + Math.cos(angle) * orbDist
        const oy = ps.shrineY + Math.sin(angle) * orbDist
        spawnOrb(ox, oy, 1, 'hp')
        Renderer.addSpawnEffect(ps.shrineX, ps.shrineY, ps.shrineRadius, ox, oy, ps.shrineColor)
      }
      // Spawn enemies
      if (ps.spawnEnemy) {
        const [spawnName, spawnCountStr] = ps.spawnEnemy.split(':')
        const spawnType = getEnemyType(spawnName!.trim())
        const spawnCount = parseInt(spawnCountStr ?? '1') || 1
        if (spawnType) {
          const baseAngle = Math.atan2(ps.shrineY - ps.playerY, ps.shrineX - ps.playerX)
          for (let s = 0; s < spawnCount; s++) {
            const spawnAngle = baseAngle + (s / spawnCount) * Math.PI * 2
            const spawnDist = ps.shrineRadius + (spawnType.radius ?? 40) + 20
            const sx = ps.shrineX + Math.cos(spawnAngle) * spawnDist
            const sy = ps.shrineY + Math.sin(spawnAngle) * spawnDist
            const clamped = clampToArena(sx, sy, spawnType.radius ?? 40)
            const newEnemy = createEnemy(clamped.x, clamped.y, spawnType)
            enemies.push(newEnemy)
            Renderer.addSpawnEffect(ps.shrineX, ps.shrineY, ps.shrineRadius, clamped.x, clamped.y, spawnType.color)
          }
        }
      }
      // Kill shrine on last hit — death + spawns + explosion happen together
      if (ps.isLastHit && ps.shrine.alive) {
        ps.shrine.dying = true
        ps.shrine.deathTimer = 0
        spawnDrops(ps.shrine, 1, spawnOrb)
        emit('enemy:killed', ps.shrine)

        // Death explosion particles
        const er = parseInt(ps.shrineColor.slice(1, 3), 16)
        const eg = parseInt(ps.shrineColor.slice(3, 5), 16)
        const eb = parseInt(ps.shrineColor.slice(5, 7), 16)
        // Shrine-colored burst from edge
        for (let p = 0; p < 40; p++) {
          const a = (p / 40) * Math.PI * 2 + Math.random() * 0.3
          const dist = ps.shrineRadius * (0.6 + Math.random() * 0.4)
          const px = ps.shrineX + Math.cos(a) * dist
          const py = ps.shrineY + Math.sin(a) * dist
          const speed = 300 + Math.random() * 400
          const outA = Math.atan2(py - ps.shrineY, px - ps.shrineX)
          Renderer.spawnParticleExport(px, py,
            Math.cos(outA) * speed + (Math.random() - 0.5) * 150,
            Math.sin(outA) * speed + (Math.random() - 0.5) * 150,
            Math.min(255, er + 40), Math.min(255, eg + 30), Math.min(255, eb + 30),
            0.4 + Math.random() * 0.3, 6 + Math.random() * 7)
        }
        // White-hot core burst
        for (let p = 0; p < 20; p++) {
          const a = Math.random() * Math.PI * 2
          const speed = 400 + Math.random() * 350
          Renderer.spawnParticleExport(ps.shrineX, ps.shrineY,
            Math.cos(a) * speed, Math.sin(a) * speed,
            255, 255, 255, 0.3 + Math.random() * 0.2, 5 + Math.random() * 5)
        }
        // Red blood burst
        for (let p = 0; p < 15; p++) {
          const a = Math.random() * Math.PI * 2
          const speed = 250 + Math.random() * 300
          Renderer.spawnParticleExport(ps.shrineX, ps.shrineY,
            Math.cos(a) * speed + (Math.random() - 0.5) * 120,
            Math.sin(a) * speed + (Math.random() - 0.5) * 120,
            255, 50 + Math.floor(Math.random() * 40), 40 + Math.floor(Math.random() * 30),
            0.4 + Math.random() * 0.25, 7 + Math.random() * 6)
        }
      }
    }
  }

  // Process pending Aftershock detonations — fire on next beat. Swap-and-pop iteration so
  // detonation can spawn more enemies/effects without invalidating the loop.
  for (let i = pendingDetonations.length - 1; i >= 0; i--) {
    const pd = pendingDetonations[i]!
    pd.timer -= dt
    if (pd.timer <= 0) {
      detonateBeatDash(pd.x, pd.y, pd.radius, pd.damage)
      pendingDetonations[i] = pendingDetonations[pendingDetonations.length - 1]!
      pendingDetonations.pop()
    }
  }

  // Chill Zone — per-frame presence check. Sets enemy.zoneSlowFrac so updateEnemy's slow
  // calc can combine it with frostbite stacks via max(). Overlap test uses
  // (zone.radius + enemy.radius)² so any part of the body touching the zone counts.
  if (activeChillZone) {
    const cz = activeChillZone
    for (const e of enemies) {
      if (!e.alive || e.dying) { e.zoneSlowFrac = 0; continue }
      const ddx = e.x - cz.x
      const ddy = e.y - cz.y
      const overlapR = cz.radius + e.radius
      e.zoneSlowFrac = (ddx * ddx + ddy * ddy <= overlapR * overlapR) ? 0.5 : 0
    }
  } else {
    // No zone — clear stale slow values from any enemy that was previously chilled by one
    for (const e of enemies) {
      if (e.zoneSlowFrac !== 0) e.zoneSlowFrac = 0
    }
  }

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

  tickAudioHealth()  // auto-fix suspended AudioContext on mobile
  advanceGlobalTime(dt)
  advancePatternClock(dt)
  // Tick wall motion (rotating walls etc.) using a monotonic absolute beat counter. Using
  // getLoopPosition (modulo song-loop) would snap walls backwards when beatsPerCycle exceeds
  // the song loop length — e.g. a 12-beats/rev rotation in an 8-beat song would reset every 8.
  updateWalls(getAbsoluteBeats())
  processSpringFires()
  processPusherEnemies()
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

  // Danger music — dark layer when low HP
  updateDangerMusic(player.hp / player.maxHp)

  // Challenge elapsed timer
  challengeElapsed += dt

  if (beatDashBeatdownCD > 0) beatDashBeatdownCD -= dt
  tickLeaveToastCD(dt)

  // Skip all toast checks if dead or victory
  const skipToasts = player.hp <= 0 || isRunComplete()

  if (!skipToasts) {
  // Track last hit time — any enemy hit or node locked counts as activity
  for (const e of enemies) {
    if (e.alive && e.hitFlash > 0.29) { lastHitTime = challengeElapsed; doSomethingFired = false; break }
    if (e.alive && e.summon && e.summonLockFlash.some(f => f > 0.28)) { lastHitTime = challengeElapsed; doSomethingFired = false; break }
  }
  // "Hey, do something." — no hits for 15s, 1 min cooldown
  if (doSomethingCooldown > 0) doSomethingCooldown -= dt
  if (!doSomethingFired && doSomethingCooldown <= 0 && challengeElapsed > 5 && challengeElapsed - lastHitTime >= 15) {
    doSomethingFired = true
    doSomethingCooldown = 60
    showToast('Hey, do something.', { y: 0.14, duration: 2, id: `do_something_${challengeElapsed}` })
  }

  // AFK detection — no movement for 10s
  const isMoving = Math.abs(player.x - player.prevX) > 0.5 || Math.abs(player.y - player.prevY) > 0.5
  if (isMoving) lastMoveTime = challengeElapsed
  if (!afkFired && challengeElapsed - lastMoveTime >= 10 && challengeElapsed > 3) {
    afkFired = true
    showToast('AFK...?', { y: 0.14, duration: 2, size: 42, id: 'afk', color: [255, 255, 255], style: 'sad' })
  }

  // Detect dash — count charging slots, if more than last frame a dash was used
  const chargingSlots = player.dashSlots.filter(t => t > 0).length
  if (chargingSlots > prevDashSlotSum) {
    // Wall dash — snapshot position
    wallDashStartX = player.x
    wallDashStartY = player.y
    wallDashCheckTimer = 0.25  // check after dash finishes
    const now = challengeElapsed
    if (!doubleDashFired && now - lastDashTime < 0.7 && lastDashTime > 0 && getActiveChallenge()?.name === 'Beginner Challenge') {
      doubleDashFired = true
      showToast('WOW! Look at you GO!', { y: 0.14, duration: 1.5, id: 'double_dash', style: 'glow', glowWords: ['WOW!', 'GO!'], glowColor: [100, 255, 120] })
    }
    lastDashTime = now
    // Leeroy — snapshot nearby enemies at dash start (narrower range, so it's easier to count as "lonely")
    if (!leroyFired) {
      const leroyStartRange = 100
      leroyDashStartNearby = 0
      for (const e of enemies) {
        if (!e.alive || e.dying || e.summon || e.isShrine) continue
        const dx = e.x - player.x, dy = e.y - player.y
        if (dx * dx + dy * dy <= leroyStartRange * leroyStartRange) leroyDashStartNearby++
      }
      leroyCheckTimer = 0.5
    }
  }
  prevDashSlotSum = chargingSlots

  // Wall dash — check if player barely moved after dashing
  if (wallDashCheckTimer > 0) {
    wallDashCheckTimer -= dt
    if (wallDashCheckTimer <= 0 && !wallDashFired) {
      const dx = player.x - wallDashStartX
      const dy = player.y - wallDashStartY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 40) {  // barely moved
        wallDashFired = true
        showToast("Dude, it's a wall.", { y: 0.14, duration: 1.5, id: 'wall_dash' })
      }
    }
  }

  // HP nom tracking — detect healing each frame, accumulate over 0.5s window
  if (prevPlayerHp < 0) prevPlayerHp = player.hp  // sync on first frame
  const hpGain = player.hp - prevPlayerHp
  if (hpGain > 0.5) {
    recentHpCollected += Math.round(hpGain)
    recentHpTimer = 0.3
    // Stayin' Alive — healed from 1 HP to 3+ in one tick
    if (prevPlayerHp === 1 && player.hp >= 3) {
      showToast("Stayin' Alive!", { y: 0.14, duration: 1.5, id: `stayin_${challengeElapsed}`, color: [255, 215, 64], style: 'wave' })
    }
  }
  // BACK FROM THE DEAD — hit 1 HP, then back to full within 4s
  if (player.hp === 1 && prevPlayerHp > 1) {
    lastHit1HpTime = challengeElapsed
  }
  if (!backFromDeadFired && lastHit1HpTime >= 0 && player.hp === player.maxHp && challengeElapsed - lastHit1HpTime <= 4) {
    backFromDeadFired = true
    showToast('BACK FROM THE DEAD!', { y: 0.14, duration: 2.5, size: 56, id: 'back_from_dead', color: [255, 215, 64], style: 'heavy' })
  }
  prevPlayerHp = player.hp
  if (recentHpTimer > 0) {
    recentHpTimer -= dt
    if (recentHpTimer <= 0) {
      if (recentHpCollected >= 4) {
        showToast('NOM NOM NOM NOM', { y: 0.14, duration: 1.2, size: 42, id: `nom_${challengeElapsed}`, color: [100, 255, 160], style: 'combo' })
      }
      recentHpCollected = 0
    }
  }

  // Detect attack beat — attackTimer resets to 0+ when ring fires
  if (player.attackTimer >= 0 && prevAttackTimer < 0) {
    // New attack just fired — did the last attack have kills?
    if (attacksSinceLastKill > 0) {
      // An attack happened with no kill since last kill — break streak
      consecutiveAttackKills = 0
    }
    attacksSinceLastKill++
  }
  prevAttackTimer = player.attackTimer

  // Combo tracking — kills within 0.5s window
  if (recentKillTimer > 0) {
    recentKillTimer -= dt
    if (recentKillTimer <= 0) {
      if (recentKills >= 4) {
        const MEGA_COMBOS = [
          'SUPER MEGA BAD DADDY RAMPAGE!',
          'ABSOLUTELY DISGUSTING.',
          'SOMEBODY CALL THE POLICE!',
          "THAT'S ILLEGAL IN 12 COUNTRIES.",
          'CALM DOWN BRO THEY HAVE FAMILIES.',
          'MOM GET THE CAMERA!',
          "YOU CAN'T KEEP GETTING AWAY WITH THIS.",
          'THIS ONE IS UNHINGED.',
        ]
        const msg = MEGA_COMBOS[Math.floor(Math.random() * MEGA_COMBOS.length)]!
        showToast(msg, { y: 0.14, duration: 1.5, size: 42, id: `mega_${challengeElapsed}`, color: [255, 215, 64], style: 'combo' })
      } else if (recentKills >= 3) {
        showToast('C-C-C-COMBO!', { y: 0.14, duration: 1.2, size: 48, id: `combo_${challengeElapsed}`, color: [255, 215, 64], style: 'combo' })
      }
      if (recentKills > 0) {
        consecutiveAttackKills += recentKills
        attacksSinceLastKill = 0  // reset — this attack had kills
      }
      if (consecutiveAttackKills >= 9) {
        consecutiveAttackKills = 0
        showToast('KILLING SPREE!', { y: 0.14, duration: 1.5, size: 48, id: `spree_${challengeElapsed}`, color: [255, 50, 50], style: 'combo' })
      }
      recentKills = 0
    }
  }

  // "FINISH HIM" — 1 enemy left (all challenges)
  if (!finishHimFired && isRunTimerActive()) {
    const alive = enemies.filter(e => e.alive && !e.dying && !e.summon && !e.totemSpawn && !e.isShrine).length
    const anySpawners = enemies.some(e => e.alive && !e.dying && (e.summon || e.totemSpawn || e.isShrine))
    if (alive === 1 && !anySpawners) {
      finishHimFired = true
      showToast('FINISH HIM!', { y: 0.14, duration: 1.5, size: 52, id: 'finish_him', color: [255, 50, 50], style: 'combo' })
    }
  }

  // Bouncy ball man escalation — only 1 alive enemy and it's a bouncer, hanging on too long
  if (isRunTimerActive()) {
    let aliveCount = 0
    let theBouncer: Enemy | null = null
    for (const e of enemies) {
      if (!e.alive || e.dying) continue
      aliveCount++
      if (e.movePattern === 'bounce') theBouncer = e
    }
    const isLastBouncerLeft = aliveCount === 1 && theBouncer !== null
    if (isLastBouncerLeft) {
      if (lastBouncerOnlyStart < 0) lastBouncerOnlyStart = challengeElapsed
      const elapsed = challengeElapsed - lastBouncerOnlyStart
      if (!runRunFired && elapsed >= 4) {
        runRunFired = true
        showToast('RUN, RUN, AS FAST AS YOU CAN!', { y: 0.14, duration: 3, size: 46, id: 'run_run_fast', color: [100, 255, 200], style: 'wave' })
      }
      if (!bouncyBallManFired && elapsed >= 5) {
        bouncyBallManFired = true
        showToast("CAN'T CATCH ME I'M THE BOUNCY BALL MAN!", { y: 0.19, duration: 3, size: 44, id: 'bouncy_ball_man', color: [255, 215, 64], style: 'wave' })
      }
    } else {
      lastBouncerOnlyStart = -1
    }
  }

  // Leeroy — check 0.5s after dash
  if (!leroyFired && leroyCheckTimer > 0) {
    leroyCheckTimer -= dt
    if (leroyCheckTimer <= 0 && leroyDashStartNearby < 2) {
      const leroyRange = 200
      let nearbyNow = 0
      for (const e of enemies) {
        if (!e.alive || e.dying || e.summon || e.isShrine) continue
        const dx = e.x - player.x, dy = e.y - player.y
        if (dx * dx + dy * dy <= leroyRange * leroyRange) nearbyNow++
      }
      if (nearbyNow >= 5) {
        leroyFired = true
        showToast('LEEEEEEEEEEROY JEEEEEENNNNNKINSSS!!!', { y: 0.14, duration: 2.2, size: 56, id: 'leroy', color: [255, 215, 64], style: 'explosive' })
      }
    }
  }

  // Random minute toasts — one per minute starting at 2 min
  const minuteMark = Math.floor(challengeElapsed / 60)
  if (minuteMark >= 2 && minuteToastCount < minuteMark - 1) {
    minuteToastCount = minuteMark - 1
    const msg = MINUTE_TOASTS[Math.floor(Math.random() * MINUTE_TOASTS.length)]!
    showToast(msg, { y: 0.14, duration: 2, id: `minute_${minuteMark}` })
  }

  // "Still alive" toast — Challenge 1 at 45s
  if (!aliveToastFired && challengeElapsed >= 45 && getActiveChallenge()?.name === 'Beginner Challenge') {
    aliveToastFired = true
    showToast('Still Alive. Pie not a lie.', { y: 0.14, duration: 2.5, id: 'still_alive', style: 'wave', color: [100, 255, 160] })
  }

  // "NOOB" toast at 2:30 — Beginner Challenge
  if (!noobToastFired && challengeElapsed >= 150 && getActiveChallenge()?.name === 'Beginner Challenge') {
    noobToastFired = true
    showToast('Wave2:cyan: N00B you so slow', { y: 0.14, duration: 4, id: 'noob', color: [0, 255, 255], style: 'wave' })
  }

  // 3.3 min vibe-code roast — any challenge
  if (!vibeCodedToastFired && challengeElapsed >= 198) {
    vibeCodedToastFired = true
    showToast('Zzzzz...Did they vibe-code your skills?', { y: 0.14, duration: 4, id: 'vibe_coded', color: [120, 200, 255], style: 'wave' })
  }

  // "You missed step 2" — Challenge 1, node sequence resets after 1 hit
  // "I thought you figured it out" — summoned before but struggling with no enemies left
  if (waitingSummonFired < 3 && getActiveChallenge()?.name === 'Challenge 1' && isRunTimerActive()) {
    const hasSummoner = enemies.some(e => e.alive && !e.dying && e.summon && e.summonCurrentPhase > 0)
    const hasNonSummoner = enemies.some(e => e.alive && !e.dying && !e.summon && !e.isShrine)
    if (hasSummoner && !hasNonSummoner) {
      waitingSummonTimer += dt
      if (waitingSummonTimer >= 23 && waitingSummonFired === 2) {
        waitingSummonFired = 3
        showToast("The 21st time's a charm!", { y: 0.14, duration: 2, id: 'charm_21' })
      } else if (waitingSummonTimer >= 15 && waitingSummonFired === 1) {
        waitingSummonFired = 2
        showToast('This hurts to watch.', { y: 0.14, duration: 2, id: 'hurts_watch' })
      } else if (waitingSummonTimer >= 8 && waitingSummonFired === 0) {
        waitingSummonFired = 1
        showToast('I thought you figured it out.', { y: 0.14, duration: 2, id: 'figured_out' })
      }
    } else {
      waitingSummonTimer = 0
    }
  }

  // "Hit the light already!" — 15s no node hits on Challenge 1
  if (!hitLightFired && getActiveChallenge()?.name === 'Challenge 1' && challengeElapsed >= 15 && !isRunTimerActive()) {
    hitLightFired = true
    showToast('Hit the light already!', { y: 0.14, duration: 2, id: 'hit_light' })
  }

  if (missedStep2Count < 5 && getActiveChallenge()?.name === 'Challenge 1') {
    let missed = false
    for (const e of enemies) {
      if (!e.alive || !e.summon || e.summonCurrentPhase > 0) continue
      const prev = prevSummonProgress.get(e) ?? -1
      if (prev === 1 && e.summonProgress === 0) {
        missed = true
        break
      }
    }
    // DON'T update tracking here — step 3 check needs the same prev values
    if (missed) {
      missedStep2Count++
      if (missedStep2Count === 1) {
        showToast('Nice! You got step 1 down.', { y: 0.14, duration: 2, id: 'missed_step2_1' })
      } else if (missedStep2Count === 2) {
        showToast('You missed step 2.', { y: 0.14, duration: 2, id: 'missed_step2_2' })
      } else if (missedStep2Count === 3) {
        showToast('Bro, 2 in a row not hard.', { y: 0.14, duration: 2, id: 'missed_step2_3' })
      } else if (missedStep2Count === 4) {
        showToast('This is a you problem.', { y: 0.14, duration: 2, id: 'missed_step2_4' })
      } else if (missedStep2Count === 5) {
        showToast("Don't quit, I believe in you <3", { y: 0.14, duration: 2.5, id: 'missed_step2_5', color: [255, 50, 200] })
      }
    }
  }

  // Missed step 3 — got 2 nodes but missed the 3rd (progress drops from 2 to 0)
  if (missedStep3Count < 5 && getActiveChallenge()?.name === 'Challenge 1') {
    let missed3 = false
    for (const e of enemies) {
      if (!e.alive || !e.summon || e.summonCurrentPhase > 0) continue
      const prev = prevSummonProgress.get(e) ?? -1
      if (prev === 2 && e.summonProgress === 0) {
        missed3 = true
        break
      }
    }
    if (missed3) {
      missedStep3Count++
      if (missedStep3Count === 1) {
        showToast('You got 2! Gimme 3.', { y: 0.14, duration: 2, id: 'missed_step3_1' })
      } else if (missedStep3Count === 2) {
        showToast('That was close - kinda.', { y: 0.14, duration: 2, id: 'missed_step3_2' })
      } else if (missedStep3Count === 3) {
        showToast("OK you're doing this on purpose.", { y: 0.14, duration: 2, id: 'missed_step3_3' })
      } else if (missedStep3Count === 4) {
        showToast("I'm not mad, just disappointed.", { y: 0.14, duration: 2.5, id: 'missed_step3_4' })
      } else if (missedStep3Count === 5) {
        showToast('Momma knows you can do it!', { y: 0.14, duration: 2.5, size: 42, id: 'missed_step3_5', color: [255, 50, 200], style: 'combo' })
      }
    }
  }

  // Update summon progress tracking after all checks
  for (const e of enemies) {
    if (e.summon) prevSummonProgress.set(e, e.summonProgress)
  }


  // Low HP toast — Beginner Challenge (once per attempt)
  if (player.hp === 2 && !lowHpToastFired && getActiveChallenge()?.name === 'Beginner Challenge') {
    lowHpToastFired = true
    showToast('AHHH 2-HP maybe dash away?', { y: 0.14, id: 'low_hp', style: 'glow', glowWords: ['AHHH', '2-HP'], glowColor: [255, 50, 50] })
  }

  // Dangerous start — player drops to 4 HP within first 15s
  if (!dangerousStartFired && player.hp <= 3 && challengeElapsed <= 12) {
    dangerousStartFired = true
    const startMsgs = ['DANGEROUS START!', 'Half HP Already?!']
    const msg = startMsgs[Math.floor(Math.random() * startMsgs.length)]!
    showToast(msg, { y: 0.14, duration: 2, size: 50, id: 'dangerous_start', color: [255, 80, 60], style: 'heavy' })
  }

  // Critical HP toast — fires at 1 HP, 40s cooldown
  if (criticalHpCooldown > 0) criticalHpCooldown -= dt
  if (clutchShieldCooldown > 0) clutchShieldCooldown -= dt
  if (heartsDeliciousCooldown > 0) heartsDeliciousCooldown -= dt
  if (dashYouFoolCooldown > 0) dashYouFoolCooldown -= dt

  // Track shield-up duration for swimming toast
  if (player.shieldCharges > 0) shieldUpTime += dt
  else shieldUpTime = 0
  if (!swimmingFired && shieldUpTime >= 10 && player.hp === 5) {
    swimmingFired = true
    showToast('Just Keep Swimming, Just Keep Swimming', { y: 0.14, duration: 3.5, size: 42, id: 'just_keep_swimming', color: [100, 200, 255], style: 'wave' })
  }

  // Push harder — pushing the same heavy enemy/totem for 3.5s
  if (pushedThisFrame && pushedThisFrame === pushingEnemy) {
    pushDuration += dt
  } else {
    pushingEnemy = pushedThisFrame
    pushDuration = 0
  }
  if (!pushHarderFired && pushDuration >= 2.5) {
    pushHarderFired = true
    showToast('PUSH HARDER BOZO!', { y: 0.14, duration: 1.8, size: 46, id: 'push_harder', color: [255, 215, 64], style: 'heavy' })
  }
  if (player.hp === 1 && criticalHpCooldown <= 0) {
    criticalHpCooldown = 40
    const msg = CRITICAL_HP_TOASTS[Math.floor(Math.random() * CRITICAL_HP_TOASTS.length)]!
    showToast(msg, { y: 0.14, duration: 1.6, size: 42, id: `critical_hp_${challengeElapsed}`, color: [255, 80, 80], style: 'glow', glowWords: msg.split(' '), glowColor: [255, 80, 80] })
  }
  } // end skipToasts

  // Death check
  if (player.hp <= 0 && getPhase() === 'playing') {
    // hitFlash stays for jitter/color but shrink is skipped when dead (checked in renderer)
    playDeathRoll()
    resetProTip()
    setPhase('dead')
    const ch = getActiveChallenge()
    if (ch) fetchOnlineScores(ch.name)
    // Freeze active enemy attack rings at peak so the player sees what hit them on the
    // death screen. The enemy update loop is skipped while dead, so attackTimer would
    // otherwise stay wherever it happened to be — anywhere from mid-expand to fully faded
    // out, making this look inconsistent (sometimes the ring lingers, sometimes it vanishes).
    // Snapping to expandTime renders the ring at full expansion + full alpha + peak flash.
    for (const e of enemies) {
      if (!e.alive || e.dying) continue
      for (const rs of e.rings) {
        if (rs.attackTimer < 0) continue
        rs.attackTimer = rs.expandTime
      }
    }
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
        let hpEatenThisRing = 0
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
              if (isHP) hpEatenThisRing++
              Renderer.addAbsorbEffect(orb.x, orb.y, isHP ? 255 : 150, isHP ? 140 : 255, isHP ? 140 : 200, pr.enemy.x, pr.enemy.y)
              break  // one origin per orb
            }
          }
        }
        if (hpEatenThisRing >= 2 && heartsDeliciousCooldown <= 0) {
          heartsDeliciousCooldown = 30
          showToast("Your hearts are DELICIOUS!", { y: 0.14, duration: 2.5, size: 42, id: `hearts_delicious_${challengeElapsed}`, color: [255, 60, 80], style: 'wave' })
        }
      }
      pendingRevenges[i] = pendingRevenges[pendingRevenges.length - 1]!
      pendingRevenges.pop()
    }
  }

  // Process volatile explosions BEFORE enemy updates (so positions match player ring hits)
  perfStart('u_enemies')
  processVolatileExplosions(player, enemies, dt)

  // MASS EXTINCTION EVENT — 10+ enemies killed by explosions within a 5s window
  if (!massExtinctionFired && explosionKillTimes.length > 0) {
    const cutoff = challengeElapsed - 5
    while (explosionKillTimes.length > 0 && explosionKillTimes[0]! < cutoff) {
      explosionKillTimes.shift()
    }
    if (explosionKillTimes.length >= 10) {
      massExtinctionFired = true
      showToast('MASS EXTINCTION EVENT', { y: 0.14, duration: 2.8, size: 56, id: 'mass_extinction', color: [255, 215, 64], style: 'explosive' })
    }
  }

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
        // Don't let magnet pull suck the orb through a wall
        const ow = resolveWallCollision(orb.x, orb.y, orb.radius)
        orb.x = ow.x
        orb.y = ow.y
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
            enemy.x += nx * overlap * 0.05
            enemy.y += ny * overlap * 0.05
            oe.x -= nx * overlap * 0.95
            oe.y -= ny * overlap * 0.95
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
            // Dashing enemy gets heavy "dasher mass" — plows through normals (90/10 in dasher's favor).
            // Higher than player's 80/20 because the dash is short — needs less per-frame friction
            // to traverse a clump of enemies in a 0.2s burst.
            const aDashing = enemy.dodge && enemy.dashTimer >= 0
            const bDashing = oe.dodge && oe.dashTimer >= 0
            const overlap = minDist - dist
            if (aDashing && !bDashing) {
              enemy.x += nx * overlap * 0.05
              enemy.y += ny * overlap * 0.05
              oe.x    -= nx * overlap * 0.95
              oe.y    -= ny * overlap * 0.95
            } else if (!aDashing && bDashing) {
              enemy.x += nx * overlap * 0.95
              enemy.y += ny * overlap * 0.95
              oe.x    -= nx * overlap * 0.05
              oe.y    -= ny * overlap * 0.05
            } else {
              const half = overlap * 0.5
              enemy.x += nx * half
              enemy.y += ny * half
              oe.x    -= nx * half
              oe.y    -= ny * half
            }
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

    // Orb separation (grid-accelerated, uses same grid build from top of pass). Uses
    // resolveOrbCollision helper for battering-ram rules (matches designer pass + enemy
    // separation in Enemy.ts).
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
          resolveOrbCollision(orb, other as XPOrb | Enemy, isEnemy, dx / dist, dy / dist, minDist - dist)
        }
      }
      const oc = clampToArena(orb.x, orb.y, orb.radius)
      orb.x = oc.x
      orb.y = oc.y
      // Walls
      const ow = resolveWallCollision(orb.x, orb.y, orb.radius)
      orb.x = ow.x
      orb.y = ow.y
    }

    // Player vs enemies + orbs
    pushedThisFrame = null
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying || enemy.isShrine) continue
      const minDist = enemy.radius + player.hitRadius
      const dx = player.x - enemy.x
      const dy = player.y - enemy.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < minDist && dist > 0.1) {
        const overlap = minDist - dist
        const nx = dx / dist
        const ny = dy / dist
        if (enemy.immovable) {
          pushedThisFrame = enemy
          // Player pushes heavy enemy a little (15%), player takes the rest
          enemy.x -= nx * overlap * 0.15
          enemy.y -= ny * overlap * 0.15
          player.x += nx * overlap * 0.85
          player.y += ny * overlap * 0.85
          const ec = clampToArena(enemy.x, enemy.y, enemy.radius)
          enemy.x = ec.x
          enemy.y = ec.y
        } else if (enemy.dodge && enemy.dashTimer >= 0) {
          // Dashing enemy plows the player (90/10 — same heavy "dasher mass" as enemy-vs-enemy)
          enemy.x -= nx * overlap * 0.05
          enemy.y -= ny * overlap * 0.05
          player.x += nx * overlap * 0.95
          player.y += ny * overlap * 0.95
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
      playVictoryFanfare()
      completeRun()
      const ch = getActiveChallenge()
      if (ch && !isInDesignerTestPlay()) {
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
    Renderer.drawIrisTransition(renderDt)
    return
  }
  if (getPhase() === 'designer') {
    Renderer.render(player, enemies, alpha, fps, renderDt, cam)
    Renderer.drawIrisTransition(renderDt)
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

  // Iris transition overlay — draws on top of everything
  Renderer.drawIrisTransition(renderDt)
}

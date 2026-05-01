import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer, hurtPlayer, getEffectiveRadius, resetDashCDToast } from '../entities/Player.ts'
import type { Player } from '../entities/Player.ts'
import { createEnemy, updateEnemy, updateDeath, damageEnemy, spawnDrops, tickLeaveToastCD, resetLeaveToastCD } from '../entities/Enemy.ts'
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
import { shouldFire, timeUntilNextBeat, getLoopPosition } from '../audio/PatternClock.ts'
import { playHit, playPlayerHit, playShieldBreak, playShieldRestore, playVolatileExplosion, playBeatDash, playSummonerSpawn, playTotemSpawn, playNodeLock, playNodeComplete, startShieldFuseBurn, stopShieldFuseBurn, playShrineHit, playShrineSummon, updateDangerMusic, playDeathRoll, playVictoryFanfare } from '../audio/AudioEngine.ts'
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

// Queue volatile explosion on death
on('enemy:killed', () => {
  recentKills++
  recentKillTimer = 0.5  // 0.5s window to count as "same time"
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

// On-beat dash shockwave — area damage at dash start position
on('player:beatDash', (player: Player) => {
  if (getActiveChallenge()?.name === 'Beginner Challenge') {
    if (!firstBeatDashFired) {
      firstBeatDashFired = true
      showToast('You did the thing!', { y: 0.14, duration: 1.5, id: 'first_beat_dash', color: [100, 255, 120] })
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
      showToast('2 in a row?! My hero <3', { y: 0.14, duration: 2, id: 'double_beat_dash', color: [100, 255, 120] })
    }
  }
  const shockRadius = getEffectiveRadius(player) * 0.7 * player.modifiers.beatBlastMult
  const damage = player.damage * player.modifiers.damageMult
  const enemies = getEnemies()
  let beatDashHitCount = 0
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
    const dx = enemy.x - player.x
    const dy = enemy.y - player.y
    const hitRange = shockRadius + enemy.radius
    if (dx * dx + dy * dy <= hitRange * hitRange) {
      beatDashHitCount++
      const wasDying = enemy.dying
      damageEnemy(enemy, damage)
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
  shieldBreakCount++
  if (shieldBreakCount <= 1 && getActiveChallenge()?.name === 'Beginner Challenge') {
    showToast('Shield Down :(', { y: 0.14, duration: 1.5, fadeOut: 0.3, id: 'shield_down', color: [255, 50, 200], style: 'sad' })
  }
})
on('player:shieldRestore', () => {
  stopShieldFuseBurn()
  playShieldRestore()
  shieldRechargeCount++
  if (shieldRechargeCount <= 1 && getActiveChallenge()?.name === 'Beginner Challenge') {
    showToast('Shield UP!', { y: 0.14, duration: 1.5, id: 'shield_up', color: [255, 50, 200], style: 'glow', glowWords: ['UP!'], glowColor: [255, 50, 200] })
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
      showToast('MY BABIES WILL EAT YOUR HEALTH!', { y: 0.14, duration: 2, size: 38, id: 'babies', color: [255, 50, 50], style: 'combo' })
    } else if (summonToastCount === 2) {
      showToast('A lovely surprise inside!', { y: 0.14, duration: 2, id: 'lovely_surprise' })
    } else if (summonToastCount === 3) {
      showToast("You can run, but you can't hide.", { y: 0.14, duration: 2, id: 'cant_hide', color: [255, 200, 220], style: 'glow', glowWords: ['run,', 'hide.'], glowColor: [255, 150, 255] })
    }
  }
  if (chName === 'Challenge 1') {
    summonToastCount++
    if (summonToastCount === 1) {
      showToast('Lets GOOOO!', { y: 0.14, duration: 1.5, size: 52, id: 'lets_go', color: [255, 215, 64], style: 'combo' })
    } else if (summonToastCount === 2) {
      showToast('ZIG ZAG ZOOM!', { y: 0.14, duration: 1.5, size: 44, id: 'zigzag', color: [255, 80, 80], style: 'zigzag' })
    } else if (summonToastCount === 3) {
      showToast('BOUNCY BOY TIME!', { y: 0.14, duration: 1.5, size: 44, id: 'bouncy_boy', color: [255, 160, 80], style: 'combo' })
    } else if (summonToastCount === 4) {
      showToast('BEEFY BOY TIME!', { y: 0.14, duration: 2, size: 52, id: 'beefy_boy', color: [0, 200, 220], style: 'heavy' })
    } else if (summonToastCount === 5) {
      showToast('FIRE IN THE HOLE!', { y: 0.14, duration: 1.5, size: 44, id: 'fire_hole', color: [255, 120, 30], style: 'explosive' })
    } else if (summonToastCount === 6) {
      showToast('HIDE YOUR HEARTS!', { y: 0.14, duration: 1.5, size: 44, id: 'hide_hearts', color: [200, 60, 180], style: 'glow', glowWords: ['HEARTS!'], glowColor: [200, 60, 180] })
    } else if (summonToastCount === 7) {
      showToast('RELEASE THE KRA- CIRCLE!', { y: 0.14, duration: 2, size: 48, id: 'kraken', color: [255, 215, 64], style: 'heavy' })
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
let lastHitTime = 0
let doSomethingFired = false
let doSomethingCooldown = 0
let noobToastFired = false
let flyFoolsFired = false
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

export function resetPendingEffects(): void {
  pendingExplosions.length = 0
  pendingRevenges.length = 0
  pendingShrineSpawns.length = 0
  lowHpToastFired = false
  resetDashCDToast(getActiveChallenge()?.name === 'Beginner Challenge')
  noobToastFired = false
  lastHitTime = 0
  doSomethingFired = false
  doSomethingCooldown = 0
  flyFoolsFired = false
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
    // Leeroy — snapshot nearby enemies at dash start
    if (!leroyFired) {
      const leroyRange = 180
      leroyDashStartNearby = 0
      for (const e of enemies) {
        if (!e.alive || e.dying || e.summon || e.isShrine) continue
        const dx = e.x - player.x, dy = e.y - player.y
        if (dx * dx + dy * dy <= leroyRange * leroyRange) leroyDashStartNearby++
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
    recentHpTimer = 0.5
    // Stayin' Alive — healed from 1 HP to 3+ in one tick
    if (prevPlayerHp === 1 && player.hp >= 3) {
      showToast("Stayin' Alive!", { y: 0.14, duration: 1.5, id: `stayin_${challengeElapsed}`, color: [255, 215, 64], style: 'wave' })
    }
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
        showToast(msg, { y: 0.14, duration: 1.5, size: 38, id: `mega_${challengeElapsed}`, color: [255, 215, 64], style: 'combo' })
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

  // Leeroy — check 0.5s after dash
  if (!leroyFired && leroyCheckTimer > 0) {
    leroyCheckTimer -= dt
    if (leroyCheckTimer <= 0 && leroyDashStartNearby < 2) {
      const leroyRange = 180
      let nearbyNow = 0
      for (const e of enemies) {
        if (!e.alive || e.dying || e.summon || e.isShrine) continue
        const dx = e.x - player.x, dy = e.y - player.y
        if (dx * dx + dy * dy <= leroyRange * leroyRange) nearbyNow++
      }
      if (nearbyNow >= 5) {
        leroyFired = true
        showToast('LEEEEEEEEEEROY JEEEEEENNNNNKINSSS!!!', { y: 0.14, duration: 1.5, size: 40, id: 'leroy', color: [255, 215, 64], style: 'combo' })
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
    showToast('Still Alive. Pie not a lie.', { y: 0.14, duration: 2.5, id: 'still_alive' })
  }

  // "NOOB" toast at 4 HP — Beginner Challenge
  if (player.hp === 4 && !noobToastFired && getActiveChallenge()?.name === 'Beginner Challenge') {
    noobToastFired = true
    showToast('Wave2:cyan: NOOB', { y: 0.14, duration: 2, id: 'noob', color: [0, 255, 255], style: 'wave' })
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
        showToast('Momma knows you can do it!', { y: 0.14, duration: 2.5, size: 40, id: 'missed_step3_5', color: [255, 50, 200], style: 'combo' })
      }
    }
  }

  // Update summon progress tracking after all checks
  for (const e of enemies) {
    if (e.summon) prevSummonProgress.set(e, e.summonProgress)
  }

  // "Fly, you fools!" — 2 HP with 5+ enemies nearby
  if (!flyFoolsFired && player.hp <= 3) {
    const flyRange = 250
    let nearbyCount = 0
    for (const e of enemies) {
      if (!e.alive || e.dying || e.summon || e.isShrine) continue
      const dx = e.x - player.x, dy = e.y - player.y
      if (dx * dx + dy * dy <= flyRange * flyRange) nearbyCount++
    }
    if (nearbyCount >= 6) {
      flyFoolsFired = true
      showToast('Fly, you fools!', { y: 0.14, duration: 1.5, size: 38, id: 'fly_fools', color: [255, 50, 50], style: 'glow', glowWords: ['Fly,'], glowColor: [255, 50, 50] })
    }
  }

  // Low HP toast — Beginner Challenge (once per attempt)
  if (player.hp === 2 && !lowHpToastFired && getActiveChallenge()?.name === 'Beginner Challenge') {
    lowHpToastFired = true
    showToast('AHHH 2-HP maybe dash away?', { y: 0.14, id: 'low_hp', style: 'glow', glowWords: ['AHHH', '2-HP'], glowColor: [255, 50, 50] })
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
    if (exp.timer >= BEAT_SEC && !boomToastFired && getActiveChallenge()?.name === 'Beginner Challenge') {
      boomToastFired = true
      showToast('BOOM!', { y: 0.14, duration: 1.0, size: 56, id: 'boom', color: [255, 120, 30], style: 'combo' })
    }
    if (exp.timer >= BEAT_SEC) {
      // Track explosion for BOOM BOOM POW
      if (!boomBoomPowFired) {
        const now = challengeElapsed
        explosionTimes.push(now)
        while (explosionTimes.length > 0 && explosionTimes[0]! < now - 3) explosionTimes.shift()
        if (explosionTimes.length >= 5) {
          boomBoomPowFired = true
          showToast('BOOM BOOM POW!', { y: 0.14, duration: 1.5, size: 46, id: 'boom_pow', color: [255, 120, 30], style: 'combo' })
        }
      }
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
          // Start run timer on first damage dealt
          if (!isRunTimerActive() && !isRunComplete()) {
            startRunTimer()
          }
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
      playVictoryFanfare()
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

import * as Input from '../game/InputManager.ts'
import * as Renderer from '../render/Renderer.ts'
import { updatePlayer, hurtPlayer, healPlayer, resetDashCDToast, RECALL_DURATION } from '../entities/Player.ts'
import type { Player } from '../entities/Player.ts'
import { createEnemy, updateEnemy, updateDeath, damageEnemy, healEnemy, spawnDrops, tickLeaveToastCD, resetLeaveToastCD } from '../entities/Enemy.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { advanceGlobalTime } from './RhythmClock.ts'
import { updatePreviewEnemy } from '../game/EnemyDesigner.ts'
import { advancePatternClock } from '../audio/PatternClock.ts'
import { getPlayer, getEnemies, getGrid, getCamera, getPhase, setPhase, getXpForNextLevel, startRunTimer, advanceRunTimer, isRunTimerActive, isRunComplete, completeRun, getRunTimer, isInDesignerTestPlay } from './GameState.ts'
import { updateOrbs, cleanupOrbs, getOrbs, spawnOrb, collectOrb, resetOrbs } from '../entities/XPOrb.ts'
import type { XPOrb } from '../entities/XPOrb.ts'
import { updateCamera, clampToArena, getArenaShape, setArenaShape, findClearSpawnPos, resolveWallCollision, updateWalls, consumeSpringFires, consumeZoneFires, computeWallArc, getWalls } from '../game/Arena.ts'
import type { Wall } from '../game/Arena.ts'
import { PLAYER_RADIUS, MAGNET_RANGE, MAGNET_STRENGTH, BEAT_SEC, HEAVY_YIELD, DASH_SHOT_SPEED, DASH_SHOT_RADIUS_MULT } from '../utils/constants.ts'
import { staccatoProgress, STACCATO_LEAD } from '../utils/math.ts'
import { RING_FIRE_LEAD_SEC } from './PhaseSystem.ts'
import { tryTriggerUpgrade, updateUpgradeScreen, drawUpgradeScreen, drawXPBar } from '../game/UpgradeScreen.ts'
import { on, emit } from './EventBus.ts'
import { shouldFire, timeUntilNextBeat, getLoopPosition, getAbsoluteBeats } from '../audio/PatternClock.ts'
import { getBeatZeroTime } from '../audio/BeatLoop.ts'
import { playHit, playPlayerHit, playShieldBreak, playShieldRestore, playVolatileExplosion, playHealExplosion, playHeal, playWallHealEnemy, playBeatDash, playFuseStart, playRecallStart, playChillZonePlace, playIceShardBurst, playWallSpringFire, playSummonerSpawn, playTotemSpawn, playNodeLock, playNodeComplete, startShieldFuseBurn, stopShieldFuseBurn, playShrineHit, playShrineSummon, updateDangerMusic, playDeathRoll, playVictoryFanfare, tickAudioHealth, playBoing, playShockPush, playDashShotFire, startDashShotCrackle, stopDashShotCrackle, playEnemyBeatTick } from '../audio/AudioEngine.ts'
import { resetProTip, showToast } from '../render/Renderer.ts'
import { updateRitualNodes, getRitualGroups, removeGroup } from '../game/RitualNodes.ts'
import { getScoresForChallenge, fetchOnlineScores } from '../game/HighScores.ts'
import { getActiveChallenge } from '../game/ChallengeBuilder.ts'
import { openShop, updateShopScreen, drawShopScreen } from '../game/ShopScreen.ts'
import { HIT_FLASH_DURATION, BEAT_DASH_RADIUS_MULT } from '../utils/constants.ts'
import { perfStart, perfEnd, perfStep, perfSetPhase, exportPerfLog, addSpawnEffect, addVolatileExplosion, setPendingExplosions } from '../render/Renderer.ts'
import { getEnemyType } from '../entities/EnemyTypes.ts'
import { hasBonus } from '../game/UpgradeManager.ts'
import { probe } from '../audio/TimingProbe.ts'

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
  buildup: number  // seconds the telegraph expands before bursting (default BEAT_SEC; longer for on-beat bullet explosions)
  soundPlayed: boolean
  heal: boolean    // NOURISH variant — heals player + enemies in range by 1 instead of damaging (gold VFX + chime)
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
      // Heal blasts get a soft NOURISH chime instead of the boom; both share the buildup timing
      // so the resolve still lands on the burst.
      if (exp.heal) {
        // Will this blast actually heal anyone? (a target in range AND below max HP). Predicted now
        // from current positions so the bloom can land on the beat; if nobody needs healing the
        // chime stays tame instead of blaring for a no-op. Player or any live enemy counts.
        let willHeal = false
        const pdx = player.x - exp.x, pdy = player.y - exp.y
        const pr = exp.range + player.hitRadius
        if (player.hp < player.maxHp && pdx * pdx + pdy * pdy <= pr * pr) willHeal = true
        if (!willHeal) {
          for (const e of enemies) {
            if (!e.alive || e.dying || e.summon || e.hp >= e.maxHp) continue
            const dx = e.x - exp.x, dy = e.y - exp.y
            const hr = exp.range + e.radius
            if (dx * dx + dy * dy <= hr * hr) { willHeal = true; break }
          }
        }
        playHealExplosion(exp.buildup, willHeal)
      } else {
        playVolatileExplosion(exp.buildup)
      }
    }
    if (exp.timer >= exp.buildup && getActiveChallenge()?.name === 'Beginner Challenge') {
      showToast('BOOM!', { y: 0.14, duration: 1.0, size: 56, id: 'boom', color: [255, 120, 30], style: 'combo' })
    }
    if (exp.timer >= exp.buildup) {
      probe('boom')   // the explosion burst — the boom sound is aligned to this moment
      // BOOM BOOM POW combo is a DAMAGE streak — heal blasts don't count toward it.
      if (!boomBoomPowFired && !exp.heal) {
        const now = challengeElapsed
        explosionTimes.push(now)
        while (explosionTimes.length > 0 && explosionTimes[0]! < now - 3) explosionTimes.shift()
        if (explosionTimes.length >= 5) {
          boomBoomPowFired = true
          showToast('BOOM BOOM POW!', { y: 0.14, duration: 1.5, size: 46, id: 'boom_pow', color: [255, 120, 30], style: 'combo' })
        }
      }
      // GOLD GVFX colors — heal blasts read gold regardless of the source enemy's color, so the
      // "nourish" meaning is unmistakable. The warm gold matches the player's heal halo palette.
      const vfxR = exp.heal ? 255 : exp.r
      const vfxG = exp.heal ? 215 : exp.g
      const vfxB = exp.heal ? 110 : exp.b
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
          if (exp.heal) {
            // NOURISH — top the enemy up by 1 (no drops/revenge/totem; those are damage reactions).
            // healEnemy records the event so the gold halo + sparkle fire in drawEnemy even if the
            // enemy is also hit this frame (event-driven, doesn't cancel on net HP).
            healEnemy(enemy, 1)
          } else {
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
      }
      const pdx = player.x - exp.x
      const pdy = player.y - exp.y
      const playerHitRange = exp.range + player.hitRadius
      if (pdx * pdx + pdy * pdy <= playerHitRange * playerHitRange) {
        if (exp.heal) {
          if (healPlayer(player, 1) > 0) playHeal()   // event-driven gold pulse + heal chime (only if HP actually restored)
        } else if (hurtPlayer(player, 1)) {
          playPlayerHit()
        }
      }
      addVolatileExplosion(exp.x, exp.y, exp.range, vfxR, vfxG, vfxB, exp.heal)
      if (exp.heal) Renderer.spawnHealExplosionParticles(exp.x, exp.y, exp.range)
      else Renderer.spawnVolatileParticles(exp.x, exp.y, exp.range, vfxR, vfxG, vfxB)
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
    buildup: BEAT_SEC,
    soundPlayed: false,
    heal: enemy.volatileHeal,
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
  pushScale: number // Reverb push-strength multiplier (beatBlastMult × Quiet Storm AOE), captured at dash time
  timer: number     // counts down to 0
  lifetime: number  // original delay — used for pie-fill progress
}
const pendingDetonations: PendingDetonation[] = []
export function getPendingDetonations(): readonly PendingDetonation[] { return pendingDetonations }

// Reverb shock-push — a TIME-SWEPT push wave. Instead of shoving every enemy on detonation
// frame (which threw enemies before the visual ring reached them), we expand a front outward
// over time and push each entity only when the front touches its body — in lockstep with the
// cyan visual. Timing/easing MUST mirror the Renderer's shock-push leading ring so push ==
// what you see: front reaches the full radius at SHOCK_WAVE_TRAVEL_TIME with the same ease-out.
interface ShockWave {
  x: number
  y: number
  pushRadius: number
  pushStrength: number
  edgeFrac: number      // minimum falloff at the rim
  heavyResist: number   // multiplier applied to immovable enemies
  elapsed: number
  pushedEnemies: WeakSet<Enemy>
  pushedOrbs: WeakSet<XPOrb>
  pushPlayer: boolean   // enemy reverb detonations push the PLAYER too (player's own reverb doesn't)
  playerPushed: boolean // one-shot guard so the player only gets shoved once per wave
}

// Pending delayed sound — used by push-mode bullets to fire the ring sound at exactly
// RING_FIRE_LEAD_SEC after landing (= the same beat a tether would strike on). Decoupled
// from the shock wave's lifecycle so the sound still plays even after the wave retires.
interface PendingSound {
  timer: number
  sound: string
  patternName: string
}
const pendingSounds: PendingSound[] = []

// Pending push detonation — delays the shock wave SPAWN + VISUAL by PUSH_DETONATION_DELAY
// so the wave's mid-expansion aligns with the tether strike beat. Without this delay the
// wave visually starts at bullet landing (= beat − 0.13s for typical lifetimes), which
// reads as "a hair early" compared to where the tether snaps. Sound stays on-beat via the
// existing pendingSounds queue.
const PUSH_DETONATION_DELAY = 0.10
interface PendingPushDetonation {
  timer: number
  x: number; y: number
  pushRadius: number
  pushStrength: number
  colorR: number; colorG: number; colorB: number
}
const pendingPushDetonations: PendingPushDetonation[] = []
const shockWaves: ShockWave[] = []
const SHOCK_WAVE_DURATION = 0.588                                 // ~40% slower push; mirrors Renderer SHOCK_PUSH_DURATION (keep all three equal so push physics == visual)
const SHOCK_WAVE_TRAVEL = 0.5                                      // mirrors Renderer RING_TRAVEL
const SHOCK_WAVE_TRAVEL_TIME = SHOCK_WAVE_DURATION * SHOCK_WAVE_TRAVEL  // front sweeps center→edge in this time

function spawnShockWave(x: number, y: number, pushRadius: number, pushStrength: number, edgeFrac: number, heavyResist: number, pushPlayer: boolean = false): void {
  shockWaves.push({ x, y, pushRadius, pushStrength, edgeFrac, heavyResist, elapsed: 0, pushedEnemies: new WeakSet(), pushedOrbs: new WeakSet(), pushPlayer, playerPushed: false })
}

// Queue a sound to play `delaySec` from now. Decoupled from any entity lifecycle so push
// detonations can fire the ring sound on the same beat a tether would strike on, even
// after the shock wave has retired.
function schedulePendingSound(delaySec: number, sound: string, patternName: string): void {
  if (!sound) return
  pendingSounds.push({ timer: delaySec, sound, patternName })
}

function updatePendingSounds(dt: number): void {
  if (pendingSounds.length === 0) return
  for (let i = pendingSounds.length - 1; i >= 0; i--) {
    const ps = pendingSounds[i]!
    // Trigger when the timer is LESS than half a frame away from zero — picks whichever
    // frame is closer to the ideal trigger moment, ~halving average frame slop.
    if (ps.timer <= dt * 0.5) {
      playEnemyBeatTick(ps.patternName, ps.sound)
      pendingSounds[i] = pendingSounds[pendingSounds.length - 1]!
      pendingSounds.pop()
      continue
    }
    ps.timer -= dt
  }
}

// Queue a push detonation (shock wave + visual triggers) to fire after `delay` seconds.
// Same half-frame snap as the sound queue. Sound is NOT queued here — push sounds stay on
// the existing pendingSounds queue so they remain locked to the beat regardless of the
// wave's visual delay.
const PUSH_EDGE_FRAC_QUEUED = 0.35
const REVERB_HEAVY_RESIST_QUEUED = 0.6
function schedulePushDetonation(delay: number, x: number, y: number, pushRadius: number, pushStrength: number, colorR: number, colorG: number, colorB: number): void {
  pendingPushDetonations.push({ timer: delay, x, y, pushRadius, pushStrength, colorR, colorG, colorB })
}

function updatePendingPushDetonations(dt: number): void {
  if (pendingPushDetonations.length === 0) return
  for (let i = pendingPushDetonations.length - 1; i >= 0; i--) {
    const p = pendingPushDetonations[i]!
    if (p.timer <= dt * 0.5) {
      spawnShockWave(p.x, p.y, p.pushRadius, p.pushStrength, PUSH_EDGE_FRAC_QUEUED, REVERB_HEAVY_RESIST_QUEUED, true)
      Renderer.triggerEnemyShockPush(p.x, p.y, p.pushRadius, p.colorR, p.colorG, p.colorB)
      Renderer.triggerColoredLightning(p.x, p.y, p.pushRadius * 0.45, p.colorR, p.colorG, p.colorB)
      pendingPushDetonations[i] = pendingPushDetonations[pendingPushDetonations.length - 1]!
      pendingPushDetonations.pop()
      continue
    }
    p.timer -= dt
  }
}

// Advance active shock waves and push any entity the front has just reached. Called from BOTH
// the main update loop and the designer update loop (Reverb can fire in either).
//
// Perf notes: many simultaneous waves (cluster + volley push-mode bullets) used to O(W × E)
// iterate every enemy per wave. Now:
//   - Enemy broadphase uses the SpatialGrid — only enemies whose cells overlap the wave's
//     reach disc are even considered. The query entity is reused across waves to avoid
//     per-wave allocation.
//   - Squared-distance early-out before computing sqrt skips entities clearly out of reach.
//   - Per-wave constants (1 / pushRadius, etc.) hoisted out of inner loops.
// Behavior is identical — only the work done to arrive at the same push set is reduced.
const SHOCK_WAVE_BROADPHASE_PAD = 150   // padding added to query radius to cover any enemy size (true max in game is well under this; conservative is safe)
const _shockQueryEntity = { x: 0, y: 0, radius: 0 }
function updateShockWaves(dt: number): void {
  if (shockWaves.length === 0) return
  const grid = getGrid()
  const orbs = getOrbs()
  for (let i = shockWaves.length - 1; i >= 0; i--) {
    const w = shockWaves[i]!
    w.elapsed += dt
    const frontProg = Math.min(1, w.elapsed / SHOCK_WAVE_TRAVEL_TIME)
    const frontRadius = w.pushRadius * (1 - Math.pow(1 - frontProg, 2.4))   // ease-out — matches visual leading ring
    const invPushRadius = 1 / w.pushRadius
    // ── Enemies — broadphase via spatial grid (only nearby cells), then exact check.
    _shockQueryEntity.x = w.x
    _shockQueryEntity.y = w.y
    _shockQueryEntity.radius = frontRadius + SHOCK_WAVE_BROADPHASE_PAD
    const candidates = grid.query(_shockQueryEntity)
    for (let c = 0; c < candidates.length; c++) {
      const enemy = candidates[c] as Enemy
      if (!enemy.alive || enemy.dying) continue
      if (w.pushedEnemies.has(enemy)) continue
      const dx = enemy.x - w.x
      const dy = enemy.y - w.y
      const d2 = dx * dx + dy * dy
      const reach = frontRadius + enemy.radius
      if (d2 > reach * reach) continue   // front hasn't reached the body yet (sqrt-free reject)
      const dist = Math.sqrt(d2)
      const falloff = w.edgeFrac > (1 - dist * invPushRadius) ? w.edgeFrac : (1 - dist * invPushRadius)
      const str = w.pushStrength * falloff * (enemy.immovable ? w.heavyResist : 1)
      applyLaunch(enemy, dx, dy, d2, str)
      w.pushedEnemies.add(enemy)
    }
    // ── Orbs — no grid for them; linear scan with squared-distance early-out. HP orbs are
    // intrinsically heavier (heart-mass) — they absorb a fraction of the wave impulse so a
    // Reverb / push-mode wave nudges them rather than yeeting them across the arena. The
    // wave math itself is identical between player + enemy sources; only the orb's response
    // differs by type. XP orbs unchanged.
    for (let o = 0; o < orbs.length; o++) {
      const orb = orbs[o]!
      if (!orb.alive || orb.dying) continue
      if (w.pushedOrbs.has(orb)) continue
      const dx = orb.x - w.x
      const dy = orb.y - w.y
      const d2 = dx * dx + dy * dy
      const reach = frontRadius + orb.radius
      if (d2 > reach * reach) continue
      const dist = Math.sqrt(d2)
      const falloff = w.edgeFrac > (1 - dist * invPushRadius) ? w.edgeFrac : (1 - dist * invPushRadius)
      const heaviness = orb.orbType === 'hp' ? 0.35 : 1.0
      applyLaunch(orb, dx, dy, d2, w.pushStrength * falloff * heaviness)
      w.pushedOrbs.add(orb)
    }
    // ── Player — squared-distance gate, then sqrt + push. One-shot per wave.
    if (w.pushPlayer && !w.playerPushed) {
      const player = getPlayer()
      const dx = player.x - w.x
      const dy = player.y - w.y
      const d2 = dx * dx + dy * dy
      const reach = frontRadius + player.hitRadius
      if (d2 <= reach * reach) {
        const dist = Math.sqrt(d2)
        const falloff = w.edgeFrac > (1 - dist * invPushRadius) ? w.edgeFrac : (1 - dist * invPushRadius)
        applyLaunch(player, dx, dy, d2, w.pushStrength * falloff)
        w.playerPushed = true
      }
    }
    // Front has reached full radius — every in-range entity got pushed on this frame; retire.
    if (w.elapsed >= SHOCK_WAVE_TRAVEL_TIME) {
      shockWaves[i] = shockWaves[shockWaves.length - 1]!
      shockWaves.pop()
    }
  }
}

// Dash-shot (Bolt upgrade) — replaces the beat-dash AOE with a projectile that flies in the dash
// direction and explodes 1 beat later (2 with Aftershock). Passes through walls. No damage in
// flight. The visual radius swells from a small core up to targetRadius as it travels (ease-in
// — slow start, ramps up near impact), telegraphing the blast area for the last fraction of the
// flight. On expiry it calls applyBeatDashImpact at its current position so the explosion uses
// the same damage/orb/visual path as a normal beat-dash (and Reverb still composes if active).
interface DashShotProjectile {
  x: number; y: number
  vx: number; vy: number
  elapsed: number
  lifetime: number
  targetRadius: number  // final explosion radius (= the beat-dash radius captured at spawn)
  damage: number
  pushScale: number     // forwarded to applyBeatDashImpact so Reverb (if also active) scales right
  crackleId: number     // sustained lightning crackle audio — stopped when projectile detonates
}
const dashShotProjectiles: DashShotProjectile[] = []

// Enemy ranged bullet — fired by a ring with rangedMode on. Travels for `lifetime` seconds,
// then detonates into a one-shot ring AOE at its current position using the ring's existing
// radius/expandTime/color properties. ringRef captures the ring config at fire time so even
// if the ring changes mid-flight, the detonation uses the values that were fired with.
interface EnemyBullet {
  x: number; y: number
  vx: number; vy: number
  elapsed: number
  lifetime: number
  launchDelay: number      // volley stagger — bullet holds at owner's live position until elapsed >= launchDelay
  released: boolean        // true once the stagger window has elapsed; controls re-anchor + velocity recompute
  offX: number; offY: number   // offset from enemy center at fire time — preserved as enemy moves
  isSurround: boolean      // surround_player needs velocity recomputed at release to keep landing target fixed
  surroundTargetX: number  // landing point (used only when isSurround)
  surroundTargetY: number
  ringRadius: number       // detonation AOE final radius
  expandTime: number       // detonation expand time
  damage: number           // damage at peak (uses enemy.damage at fire time)
  colorR: number           // for visual (bullet trail + detonation ring tint)
  colorG: number
  colorB: number
  ownerEnemy: Enemy        // reference for stats AND live position during volley hold (parent bullets only)
  ringIndex: number        // which ring config — needed to look up rs at cluster split time
  layerIndex: number       // cluster generation: 0 = parent fire, 1 = gen 1 child, 2 = gen 2 grandchild, 3 = gen 3
  bornRotation: number     // rotation snapshot this bullet's salvo fired with. ALL siblings of a generation share the same value, so cluster children of any one parent bullet rotate uniformly with all the other gen-N children — no per-spawn drift.
  anchorToEnemy: boolean   // parent: true (follows enemy during hold). child: false (stays at spawn point).
  trackingRate: number     // radians/sec — 0 = no tracking; >0 = homes toward player
  pushMode: boolean        // detonation = reverb shock push (no damage ring) instead of normal AOE
  staccato: boolean        // freeze-between-beats, snap-forward-on-beat movement
  staccatoDivision: number // hops per beat (1 = whole, 2 = half-beat)
  staccatoPhase: number    // hop-grid phase shift in beats (0 = on-beat, 0.5 = off-beat)
  staccatoFireBeat: number // absolute beat captured at release (lazy-init)
  staccatoHops: number     // # of beat-aligned hops across the remaining flight
  staccatoReleased: number // 0..1 flight fraction already moved; -1 = not yet initialised
  salvoId: number          // groups this bullet with its siblings for tether beam formation
  salvoIndex: number       // stable 0-based position within the salvo (for topology ordering)
}

// Tether entity — at the salvo's detonation beat, this materializes with the captured
// detonation points and the bullets' linkage topology. Damage flashes once per player along
// each beam segment; the visual lingers for TETHER_DUR seconds then fades.
import type { TetherTopology } from '../entities/EnemyTypes.ts'
interface TetherEntity {
  xs: number[]; ys: number[]     // detonation points in order
  topology: TetherTopology
  width: number                  // beam thickness (used for hit detection padding)
  damage: number
  colorR: number; colorG: number; colorB: number
  bornTime: number               // tetherClock value at spawn; elapsed = tetherClock - bornTime (shared clock, no drift)
  struckProbed: boolean          // one-shot guard for the TimingProbe at materialization
  prearmTime: number             // seconds to wait after spawn before the tether materializes — makes damage land exactly TETHER_RING_LEAD seconds before ring peak
  playerHit: boolean             // one-shot guard so a single beam window can't tick damage twice
  consume: boolean               // owner has consume? — eat orbs touching beams, heal owner
  enemyOwner: Enemy              // source enemy ref for heal target
  consumeFired: boolean          // one-shot guard mirroring playerHit
  tetherSound: string            // played when the tether STRIKES (materializes). Empty = silent.
  patternName: string            // routed to playEnemyBeatTick
  soundFired: boolean            // one-shot guard for the strike sound
  probeTag: string               // 'deton' | 'hop' — which path, for the TimingProbe split
}
const tetherEntities: TetherEntity[] = []
const TETHER_DUR = 0.20            // total visual lifetime in seconds (after prearm)
const TETHER_HIT_WINDOW = 0.10     // damage can only land in the first ~half (the bright flash, after prearm)
// How many seconds BEFORE the ring's peak the tether should snap. So:
//   prearmTime = max(0, ringExpandTime - TETHER_RING_LEAD)
// With expandTime=0.68 → prearm=0.18 (tether fires 0.18s after landing → 0.5s before peak).
// With expandTime=0.5  → prearm=0    (tether fires at landing → 0.5s before peak).
// With expandTime<0.5  → prearm=0    (tether fires at landing → less than 0.5s before peak — clamped).
const TETHER_RING_LEAD = 0.5
// Early-lead applied to beat-critical sounds so the HEARD tick lands on the visual/beat despite
// audio output latency. Shared by the push-detonation sound and the tether strike sound so they
// stay consistent — change it once, both move together.
const SOUND_AUDIO_LATENCY = 0.015
// The tether tick fires from the game loop (not sample-accurate like scheduled sounds), so it
// needs this extra lead on top of the shared latency to cover the up-to-one-frame timer slop.
const TETHER_SOUND_EXTRA = 0.005
// Tether beat-alignment (measured via TimingProbe vs the player's felt-beat pulse). The two
// tether paths strike at DIFFERENT phases, so each gets its own prearm so both land on the felt
// beat. The strike sound is anchored to prearmTime, so it follows automatically.
//   • staccato-hop tethers were ~55ms EARLY  → delay them (+0.055)
//   • detonation/cluster tethers were ~66ms LATE → strike them earlier (−0.066)
const TETHER_PREARM_HOP = RING_FIRE_LEAD_SEC + 0.055
const TETHER_PREARM_DETON = RING_FIRE_LEAD_SEC - 0.066
// Staccato hop tethers fire this much BEFORE the hop lands (predicting the snap positions) so the
// red telegraph appears a touch earlier = fairer. The strike stays on its beat (prearm is extended
// by the exact time-to-boundary, so strike time is unchanged).
const TETHER_TELEGRAPH_LEAD = 0.045

// Pending salvo registry — bullets register their detonation point under salvoId at their
// salvoIndex (stable position). When the last sibling lands (registered == expected) we
// spawn the Tether (sim + viz) and clear. Indexed assignment instead of push so the topology
// matches the firing order (matters for 'open' and 'pairs').
interface PendingSalvo {
  expected: number
  received: number
  xs: number[]; ys: number[]
  topology: TetherTopology
  width: number
  damage: number
  colorR: number; colorG: number; colorB: number
  consume: boolean               // captured at fire time so consume tracks the original owner state
  enemyOwner: Enemy              // healing target
  expandTime: number             // ring expansion time — drives tether prearm so it fires TETHER_RING_LEAD seconds before ring peak
  tetherSound: string            // played when the tether STRIKES (materializes + deals damage)
  patternName: string            // routed to playEnemyBeatTick alongside tetherSound
}
const pendingSalvos = new Map<number, PendingSalvo>()
let nextSalvoId = 1
const enemyBullets: EnemyBullet[] = []

// Active detonation — a one-shot ring AOE spawned when an EnemyBullet expires. Has its own
// expanding attackTimer and applies damage at peak via direct hit check.
interface EnemyDetonation {
  x: number; y: number
  attackTimer: number
  expandTime: number
  ringRadius: number       // final radius at peak
  damage: number
  colorR: number; colorG: number; colorB: number
  peakFired: boolean       // one-shot guard so peak hit check fires exactly once
  consume: boolean         // owner has consume? — eat orbs at ring peak, heal owner
  enemyOwner: Enemy        // source enemy ref for heal target (mirrored from bullet)
  sound: string            // played at ring peak (damage moment). Empty = silent.
  patternName: string      // routed to playEnemyBeatTick alongside sound
}
const enemyDetonations: EnemyDetonation[] = []

function spawnDashShot(x: number, y: number, dirX: number, dirY: number, targetRadius: number, damage: number, pushScale: number): void {
  // Normalize the direction defensively (dashDirX/Y is unit, but cheap to ensure).
  const len = Math.sqrt(dirX * dirX + dirY * dirY)
  if (len < 0.001) return   // no direction → nothing to fire (caught earlier by the dispatcher, but safe)
  const nx = dirX / len, ny = dirY / len
  // Normal Bolt: 1 beat flight. Aftershock: 2 beats flight, but speed × 0.5 so total distance
  // stays the same — projectile reaches the same spot, just drifts slower and explodes one beat
  // later. Composed here rather than via pendingDetonations so the player's-position pie
  // wouldn't telegraph an explosion that doesn't happen there.
  const aftershock = hasBonus('aftershock')
  const lifetime = BEAT_SEC * (aftershock ? 2 : 1)
  const speed = DASH_SHOT_SPEED * (aftershock ? 0.5 : 1)
  const vx = nx * speed
  const vy = ny * speed
  // Bolt's explosion is bigger than the in-place beat-dash blast (chunkier impact at the
  // destination). beatBlastMult and Quiet Storm scalings are already baked into targetRadius.
  const blastRadius = targetRadius * DASH_SHOT_RADIUS_MULT
  const crackleId = startDashShotCrackle(lifetime)
  dashShotProjectiles.push({
    x, y,
    vx, vy,
    elapsed: 0, lifetime,
    targetRadius: blastRadius, damage, pushScale, crackleId,
  })
  // Register the visual mirror in the Renderer (its own list, ticks the same dt). Sim still
  // owns the truth — Renderer just draws. The boom on impact is fired by applyBeatDashImpact
  // (triggerBeatDashFlash + spawnVolatileParticles), same channel as a normal beat-dash.
  // reverbMode flag: when Reverb is also active, the renderer swaps the gold palette to cyan
  // so the projectile reads as the same lightning vocabulary as Reverb's push wave.
  Renderer.addDashShotViz(x, y, vx, vy, blastRadius, lifetime, hasBonus('shockPush'), aftershock)
  // Spawn feedback — the "I hit the beat" punch. Three layered effects so the on-beat fire
  // reads across audio + visual channels: sharp electric SFX, a cone of gold sparks shooting
  // forward (muzzle plume), plus the bright disc + lightning lance already drawn by the viz.
  playDashShotFire()
  const SPARK_COUNT = 14
  for (let s = 0; s < SPARK_COUNT; s++) {
    // Cone spread ±25° around the dash direction
    const spread = (Math.random() - 0.5) * 0.85
    const cs = Math.cos(spread), sn = Math.sin(spread)
    const dirNx = nx * cs - ny * sn
    const dirNy = nx * sn + ny * cs
    const sp = 220 + Math.random() * 420
    Renderer.spawnParticleExport(
      x + (Math.random() - 0.5) * 10,
      y + (Math.random() - 0.5) * 10,
      dirNx * sp, dirNy * sp,
      255, 230 + Math.floor(Math.random() * 25), 130 + Math.floor(Math.random() * 70),
      0.22 + Math.random() * 0.22,
      3 + Math.random() * 3,
    )
  }
}

// Advance projectiles and detonate any whose lifetime has expired. Called from both update loops.
function updateDashShots(dt: number): void {
  if (dashShotProjectiles.length === 0) return
  for (let i = dashShotProjectiles.length - 1; i >= 0; i--) {
    const p = dashShotProjectiles[i]!
    p.elapsed += dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    if (p.elapsed >= p.lifetime) {
      stopDashShotCrackle(p.crackleId)
      applyBeatDashImpact(p.x, p.y, p.targetRadius, p.damage, p.pushScale)
      dashShotProjectiles[i] = dashShotProjectiles[dashShotProjectiles.length - 1]!
      dashShotProjectiles.pop()
    }
  }
}

// ── Enemy ranged bullets + detonations ──
// Compute the BASE angles for a salvo (before universal rotation offset). One angle per
// bullet. For 'surround_player' these are angles around the player; for others they're
// directions FROM the origin.
function computeBaseAngles(rs: import('../entities/Enemy.ts').RingState, originX: number, originY: number, playerX: number, playerY: number): number[] {
  const dx = playerX - originX
  const dy = playerY - originY
  const aimAngle = Math.atan2(dy, dx)
  const n = Math.max(1, rs.bulletCount)
  switch (rs.rangedPattern) {
    case 'aimed':
      return [aimAngle]
    case 'radial': {
      // Evenly-spaced directions from origin
      const angles: number[] = []
      for (let i = 0; i < n; i++) angles.push((i / n) * Math.PI * 2)
      return angles
    }
    case 'surround_player': {
      // Evenly-spaced angles AROUND the player. The velocity calc later targets these points.
      const angles: number[] = []
      for (let i = 0; i < n; i++) angles.push((i / n) * Math.PI * 2)
      return angles
    }
    case 'spread_cone': {
      if (n === 1) return [aimAngle]
      // Spread evenly across spreadAngle, centered on aimAngle
      const angles: number[] = []
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1)   // 0..1
        angles.push(aimAngle - rs.spreadAngle / 2 + t * rs.spreadAngle)
      }
      return angles
    }
    case 'rotating': {
      switch (rs.rotationMode) {
        case 'turret':           return [rs.rotationAngle]   // ignore player; sweeps freely
        case 'player_anchored':  return [aimAngle + rs.rotationAngle]
        case 'oscillate':        return [aimAngle + Math.sin(rs.rotationAngle) * (Math.PI / 3)]
      }
      return [aimAngle]
    }
  }
  return [aimAngle]
}

// Compute bullet velocity vectors for a salvo. Dispatches per pattern; applies universal
// rotation offset (rs.rotationAngle is added to ALL pattern angles, not just 'rotating', so
// rotationStep can rotate radial/surround/cone arrangements between fires too).
function computeSalvoVelocities(rs: import('../entities/Enemy.ts').RingState, originX: number, originY: number, playerX: number, playerY: number, bornRotation: number): Array<{ vx: number; vy: number }> {
  // bornRotation is the rotation snapshot for THIS salvo. For parent fires it's rs.rotationAngle
  // (and rs.rotationAngle advances afterward). For cluster children it's parent.bornRotation
  // + nextLayer.rotationStep — all siblings of a generation share the same value so the salvos
  // visually rotate as one unit.
  // For 'rotating' pattern, baseAngles already contain rs.rotationAngle, so we offset by
  // (bornRotation - rs.rotationAngle) to swap the baked-in rotation for bornRotation.
  const angles = computeBaseAngles(rs, originX, originY, playerX, playerY)
  const isRotating = rs.rangedPattern === 'rotating'
  const extra = isRotating ? (bornRotation - rs.rotationAngle) : bornRotation
  const out: Array<{ vx: number; vy: number }> = []
  if (rs.rangedPattern === 'surround_player') {
    const life = Math.max(0.05, rs.bulletLifetime)
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i]! + extra
      const tx = playerX + Math.cos(a) * rs.surroundRadius
      const ty = playerY + Math.sin(a) * rs.surroundRadius
      out.push({ vx: (tx - originX) / life, vy: (ty - originY) / life })
    }
  } else {
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i]! + extra
      out.push({ vx: Math.cos(a) * rs.bulletSpeed, vy: Math.sin(a) * rs.bulletSpeed })
    }
  }
  return out
}

// Spawn a salvo from a given origin point. layerIndex picks the RingState to fire with:
//   0      = the parent ring (event handler fires from enemy on beats)
//   1..N   = cluster generation N (resolved from parent.childLayers[layerIndex - 1])
// Each layer has its own pattern, count, push/tether, etc. — driven entirely by the
// resolved RingState's fields.
function spawnSalvo(enemy: Enemy, ringIndex: number, layerIndex: number, originX: number, originY: number, anchorToEnemy: boolean, bornRotationOverride?: number, startElapsed: number = 0): void {
  const parentRs = enemy.rings[ringIndex]
  if (!parentRs) return
  const rs = layerIndex === 0
    ? parentRs
    : parentRs.childLayers[layerIndex - 1]
  if (!rs) return
  // Tether beam thickness ALWAYS inherits layer 0 (the parent ring), so chained/cluster child
  // layers don't render thinner telegraph dots/beams than the first set. Per-layer width still
  // drives everything else; only the visual+hit thickness is unified.
  const tetherW = parentRs.tetherWidth
  const player = getPlayer()
  // bornRotation = the rotation ALL siblings of this salvo fire with. For parent fires
  // (no override) it's the layer's current rotationAngle. For cluster children it's the
  // parent-bullet's bornRotation + the child layer's rotationStep — supplied by caller.
  const bornRotation = bornRotationOverride ?? rs.rotationAngle
  // startElapsed is the parent bullet's frame overshoot (`elapsed - lifetime` at detonation
  // time). Children inherit it so each generation absorbs its parent's frame slop and
  // detonates back on the ideal beat — no drift accumulation across cluster layers.
  const vels = computeSalvoVelocities(rs, originX, originY, player.x, player.y, bornRotation)
  const n = vels.length
  const cr = enemy.cr, cg = enemy.cg, cb = enemy.cb
  const trackingRate = rs.tracking ? rs.trackingStrength : 0
  const useVolley = rs.volleyMode && n > 1
  const isSurround = rs.rangedPattern === 'surround_player'
  const baseLife = Math.max(0.05, rs.bulletLifetime)
  // Offset from enemy center captured ONLY when anchored — for child salvos the origin is
  // a fixed world point (the parent's detonation), so the enemy's motion shouldn't drag it.
  const offX = anchorToEnemy ? originX - enemy.x : 0
  const offY = anchorToEnemy ? originY - enemy.y : 0
  // Tether bookkeeping — every bullet in this call shares a salvoId. If tether is active
  // and there are ≥2 bullets, register an empty pending salvo; bullets will fill in their
  // detonation points as they land, and the last lander spawns the Tether.
  const salvoId = nextSalvoId++
  // Staccato salvos fire a tether on EVERY hop (fireStaccatoHopTethers), so they must NOT also
  // register the one-shot detonation tether — otherwise the last hop + the detonation strike
  // stack into a double hit on the final beat.
  const useTether = rs.tetherMode !== 'off' && n >= 2 && !rs.staccato
  if (useTether) {
    // Pre-fill arrays with zeros at correct length so indexed assignment by salvoIndex
    // is order-stable (otherwise sparse indices show up as `undefined`).
    const xs = new Array<number>(n).fill(0)
    const ys = new Array<number>(n).fill(0)
    pendingSalvos.set(salvoId, {
      expected: n,
      received: 0,
      xs, ys,
      topology: rs.tetherMode,
      width: tetherW,
      damage: enemy.damage,
      colorR: cr, colorG: cg, colorB: cb,
      consume: enemy.consume,
      enemyOwner: enemy,
      expandTime: rs.expandTime,
      tetherSound: rs.tetherSound,
      patternName: rs.patternName,
    })
  }
  for (let i = 0; i < n; i++) {
    const v = vels[i]!
    let launchDelay = useVolley ? (i / (n - 1)) * rs.volleyWindow : 0
    // Off-beat enemy salvos: hold the bullet INVISIBLE (launchDelay hides it) for half a beat so
    // it "appears" right before its first off-beat hop — same short idle as on-beat — instead of
    // sitting at the enemy through the whole half-beat. elapsed keeps ticking, so it still
    // detonates on its original beat. Enemy-fired only (layerIndex 0); cluster children unchanged.
    if (rs.staccatoPhase > 0 && layerIndex === 0) launchDelay += 0.5 * BEAT_SEC
    let vx = v.vx, vy = v.vy
    const surroundTargetX = isSurround ? originX + v.vx * baseLife : 0
    const surroundTargetY = isSurround ? originY + v.vy * baseLife : 0
    if (useVolley && isSurround && launchDelay > 0) {
      const scale = baseLife / Math.max(0.05, baseLife - launchDelay)
      vx *= scale; vy *= scale
    }
    enemyBullets.push({
      x: originX, y: originY,
      vx, vy,
      elapsed: startElapsed,
      lifetime: rs.bulletLifetime,
      launchDelay,
      released: launchDelay <= startElapsed,
      offX, offY,
      isSurround,
      surroundTargetX, surroundTargetY,
      ringRadius: rs.ring.radius,
      expandTime: rs.expandTime,
      damage: enemy.damage,
      colorR: cr, colorG: cg, colorB: cb,
      ownerEnemy: enemy,
      ringIndex,
      layerIndex,
      bornRotation,
      anchorToEnemy,
      trackingRate,
      pushMode: rs.pushMode,
      staccato: rs.staccato,
      staccatoDivision: rs.staccatoDivision,
      staccatoPhase: rs.staccatoPhase,
      staccatoFireBeat: 0,
      staccatoHops: 1,
      staccatoReleased: -1,
      salvoId,
      salvoIndex: i,
    })
    Renderer.addEnemyBulletViz(originX, originY, vx, vy, rs.bulletLifetime, rs.ring.radius, cr, cg, cb, trackingRate, launchDelay, anchorToEnemy ? enemy : null, offX, offY, isSurround, surroundTargetX, surroundTargetY, salvoId, i, rs.tetherMode, tetherW, rs.pushMode, rs.staccato, rs.staccatoDivision, rs.staccatoPhase, layerIndex > 0, rs.explodeMode, rs.healMode)
  }
  // Layer rotation only advances on a FRESH parent fire (no override). Cluster child salvos
  // inherit their rotation directly from the parent bullet's bornRotation + step, so they
  // don't and shouldn't touch the layer's rotationAngle counter — otherwise N parent bullets
  // each spawning a child salvo would advance the layer N times per beat instead of zero.
  if (bornRotationOverride === undefined) {
    rs.rotationAngle += rs.rotationStep
  }
}

// Subscribe to enemy ranged ring fires — initial salvo from the enemy (layer 0).
on('enemy:rangedFire', (enemy: Enemy, ringIndex: number, originX: number, originY: number) => {
  spawnSalvo(enemy, ringIndex, 0, originX, originY, true)
})

// Advance enemy bullets and detonate when their lifetime expires (spawns a detonation entry).
function updateEnemyBullets(dt: number): void {
  if (enemyBullets.length === 0) return
  const player = getPlayer()
  for (let i = enemyBullets.length - 1; i >= 0; i--) {
    const b = enemyBullets[i]!
    b.elapsed += dt
    // Volley hold — parent bullets follow the enemy's live position so they pop out of
    // where the enemy actually is (incl. edge offset). Child bullets (cluster split) stay
    // at their spawn point (= parent's detonation) since they're not tied to the enemy.
    // elapsed still ticks either way so the salvo detonates on the SAME beat.
    if (!b.released) {
      if (b.anchorToEnemy) {
        b.x = b.ownerEnemy.x + b.offX
        b.y = b.ownerEnemy.y + b.offY
      }
      if (b.elapsed < b.launchDelay) continue
      // Release this frame — for surround_player, recompute velocity from the LIVE origin so
      // the bullet still reaches its captured target landing point in the remaining flight time.
      b.released = true
      if (b.isSurround) {
        const remaining = Math.max(0.05, b.lifetime - b.elapsed)
        b.vx = (b.surroundTargetX - b.x) / remaining
        b.vy = (b.surroundTargetY - b.y) / remaining
      }
    }
    // Tracking — rotate velocity vector toward the player's current position, limited by
    // trackingRate (radians/sec). Preserves bullet speed (only direction changes).
    if (b.trackingRate > 0) {
      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy)
      if (speed > 0.01) {
        const curAng = Math.atan2(b.vy, b.vx)
        const desAng = Math.atan2(player.y - b.y, player.x - b.x)
        let delta = desAng - curAng
        if (delta > Math.PI) delta -= 2 * Math.PI
        else if (delta < -Math.PI) delta += 2 * Math.PI
        const maxTurn = b.trackingRate * dt
        if (delta > maxTurn) delta = maxTurn
        else if (delta < -maxTurn) delta = -maxTurn
        const newAng = curAng + delta
        b.vx = Math.cos(newAng) * speed
        b.vy = Math.sin(newAng) * speed
      }
    }
    if (b.staccato) {
      // Staccato — frozen between global beats, snaps forward on each. Lazy-init the release beat
      // + hop count on the first post-release frame (so volley/cluster capture at their real
      // release). Movement = the per-frame DELTA of the beat-quantized progress applied along the
      // current velocity (so it composes with tracking — re-aims, then lunges).
      if (b.staccatoReleased < 0) {
        b.staccatoFireBeat = getAbsoluteBeats()
        // Count the ACTUAL hop-grid boundaries between release and detonation (accounts for the
        // phase + lead so off-beat / launch-delayed bullets reach full distance on the LAST hop,
        // not early). round(duration) was undercounting and parking the bullet a hop short.
        const detBeat = b.staccatoFireBeat + (b.lifetime - b.elapsed) / BEAT_SEC
        b.staccatoHops = Math.max(1, Math.floor((detBeat - STACCATO_LEAD - b.staccatoPhase) * b.staccatoDivision) - Math.floor((b.staccatoFireBeat - STACCATO_LEAD - b.staccatoPhase) * b.staccatoDivision))
        b.staccatoReleased = 0
      }
      const target = staccatoProgress(getAbsoluteBeats(), b.staccatoFireBeat, b.staccatoHops, b.staccatoDivision, b.staccatoPhase)
      const move = target - b.staccatoReleased
      if (move > 0) {
        b.x += b.vx * move * b.lifetime
        b.y += b.vy * move * b.lifetime
        b.staccatoReleased = target
        probe('staccato-hop')   // the snap-forward moment
      }
    } else {
      b.x += b.vx * dt
      b.y += b.vy * dt
    }
    if (b.elapsed >= b.lifetime) {
      // Lead the detonation forward along the velocity direction by ~15ms of motion to
      // compensate for perceptual motion-induced position shift (see note added earlier).
      const LEAD_TIME = 0.015
      const dx = b.x + b.vx * LEAD_TIME
      const dy = b.y + b.vy * LEAD_TIME
      // Resolve the layer's RingState — used to capture detonation/tether sounds + pattern
      // name onto the spawned detonation/tether entities so they play at DAMAGE TIME (ring
      // peak / tether strike), not at landing.
      const detRs = b.layerIndex === 0
        ? b.ownerEnemy.rings[b.ringIndex]
        : b.ownerEnemy.rings[b.ringIndex]?.childLayers[b.layerIndex - 1]
      const detSound = detRs?.sound ?? ''
      const detPatternName = detRs?.patternName ?? b.ownerEnemy.typeName
      const detTetherSound = detRs?.tetherSound ?? ''
      // ringRadius 0 = NO detonation at all (no ring, no push, no damage, no FX) — the bullet
      // simply splits into the next cluster layer below. Lets a layer be a pure "relay" hop.
      if (b.ringRadius <= 0) {
        // no-op — fall through to tether registration + cluster split
      } else if (b.pushMode) {
        // Push-mode detonation — Reverb-style shock wave in the ring's color INSTEAD of the
        // expanding damage ring. Push radius = the configured ringRadius. Strength scales
        // with ringRadius so bigger rings shove harder. Falls off toward the rim.
        // The wave + visual are DELAYED by PUSH_DETONATION_DELAY (0.10s) so the wave's
        // mid-expansion aligns with the tether-strike beat — felt as "push and tether hit
        // together" rather than "push slightly early." Sound stays locked to the beat via
        // the separate pendingSounds queue.
        const pushRadius = b.ringRadius
        const pushStrength = b.ringRadius * 30   // ringRadius 100 → 3000 base; scales linearly
        const overshoot = b.elapsed - b.lifetime
        schedulePushDetonation(PUSH_DETONATION_DELAY - overshoot, dx, dy, pushRadius, pushStrength, b.colorR, b.colorG, b.colorB)
        // Sound is queued separately — fires at landing + RING_FIRE_LEAD_SEC (on the beat),
        // independent of the wave's delayed visual start.
        schedulePendingSound(RING_FIRE_LEAD_SEC - overshoot - SOUND_AUDIO_LATENCY, detSound, detPatternName)
      } else if (detRs?.explodeMode) {
        // Explode-mode detonation — behave EXACTLY like a volatile enemy blowing up, just sourced
        // from a bullet. Queue the SAME pendingExplosion the volatile-death path uses, so it gets
        // the identical telegraph buildup, blast animation, sound, and filled-disc damage to the
        // player AND nearby enemies. ringRadius = blast range (like push uses it for its radius).
        // The telegraph circle starts expanding IMMEDIATELY at the bullet's destruction (no
        // dormant gap), but the buildup window is STRETCHED so the burst still lands on the beat.
        // The bullet detonates RING_FIRE_LEAD_SEC before its felt beat (it fires early to land on
        // rhythm), so the buildup = one beat + that lead (minus frame overshoot). Same on-beat
        // burst as a volatile death, but the circle brews from frame one — and since it appears
        // instantly at detonation, dx/dy's small lead is right (no extra lead needed).
        const overshoot = Math.max(0, b.elapsed - b.lifetime)
        // Detonate at the bullet's NATURAL detonation point (dx/dy, the same place a normal/push
        // detonation lands) — no extra forward lead, so the explosion sits exactly where the bullet
        // popped instead of drifting ahead of it.
        pendingExplosions.push({
          x: dx, y: dy,
          range: b.ringRadius,
          r: b.colorR, g: b.colorG, b: b.colorB,
          timer: 0,
          buildup: BEAT_SEC + Math.max(0, RING_FIRE_LEAD_SEC - overshoot) - 0.05,  // −50ms: boom measured ~51ms late vs felt beat
          soundPlayed: false,
          heal: detRs?.healMode ?? false,
        })
        // Destruction burst — the dart shatters (flash + hot ember scatter) at the shatter point
        // as the telegraph begins expanding, so the transition reads as a violent ignition.
        Renderer.spawnExplodeBulletDestruction(dx, dy, detRs?.healMode ?? false)
      } else {
        // Normal detonation — expanding damage ring, hit check applied at peak.
        enemyDetonations.push({
          x: dx, y: dy,
          attackTimer: 0,
          expandTime: b.expandTime,
          ringRadius: b.ringRadius,
          damage: b.damage,
          colorR: b.colorR, colorG: b.colorG, colorB: b.colorB,
          peakFired: false,
          consume: b.ownerEnemy.consume,
          enemyOwner: b.ownerEnemy,
          sound: detSound,
          patternName: detPatternName,
        })
        Renderer.addEnemyDetonationViz(dx, dy, b.expandTime, b.ringRadius, b.colorR, b.colorG, b.colorB)
      }
      // Tether registration — write our detonation point at our stable salvoIndex slot.
      // When the LAST sibling lands (received == expected) we materialize the tether.
      const pending = pendingSalvos.get(b.salvoId)
      if (pending) {
        pending.xs[b.salvoIndex] = dx
        pending.ys[b.salvoIndex] = dy
        pending.received++
        if (pending.received >= pending.expected) {
          // prearmTime locks the tether's strike to the natural beat the bullets were aimed
          // at. Bullets fire RING_FIRE_LEAD_SEC (0.23s) BEFORE their scheduled beat so the
          // ring lands on rhythm. If we delay the tether by exactly RING_FIRE_LEAD_SEC after
          // landing, the strike happens at: (beat - lead) + bulletLifetime + lead = beat +
          // bulletLifetime — i.e., the next clean beat/half-beat regardless of expandTime.
          // TETHER_PREARM_DETON nudges it onto the player's felt beat (chaining/cluster tethers
          // were measured ~66ms late vs the pulse).
          const prearmTime = TETHER_PREARM_DETON
          tetherEntities.push({
            xs: pending.xs, ys: pending.ys,
            topology: pending.topology,
            width: pending.width,
            damage: pending.damage,
            colorR: pending.colorR, colorG: pending.colorG, colorB: pending.colorB,
            bornTime: tetherClock,
            struckProbed: false,
            prearmTime,
            playerHit: false,
            consume: pending.consume,
            enemyOwner: pending.enemyOwner,
            consumeFired: false,
            tetherSound: pending.tetherSound,
            patternName: pending.patternName,
            soundFired: false,
            probeTag: 'deton',
          })
          Renderer.addTetherViz(pending.xs, pending.ys, pending.topology, pending.width, pending.colorR, pending.colorG, pending.colorB, prearmTime, tetherClock)
          pendingSalvos.delete(b.salvoId)
        }
      }
      // Cluster — if this bullet has a NEXT layer configured, spawn a child salvo at the
      // detonation point driven by that layer's RingState (its pattern, count, push/tether,
      // rotation, etc — all independent of this bullet's layer). Children are anchored to
      // the world (not the enemy) so their volley hold stays at the detonation point.
      // Telegraph the children's directions via a directional starburst FX so the player
      // can read the next salvo's threat shape from the impact moment.
      const parentRs = b.ownerEnemy.rings[b.ringIndex]
      const nextLayerIndex = b.layerIndex + 1
      if (parentRs && nextLayerIndex <= parentRs.childLayers.length) {
        const nextRs = parentRs.childLayers[nextLayerIndex - 1]!
        // Children's bornRotation = THIS bullet's bornRotation + child layer's step. ALL
        // children of this generation share the same bornRotation so the gen rotates as one.
        const childBornRotation = b.bornRotation + nextRs.rotationStep
        const childVels = computeSalvoVelocities(nextRs, dx, dy, player.x, player.y, childBornRotation)
        const angles: number[] = []
        for (const v of childVels) angles.push(Math.atan2(v.vy, v.vx))
        Renderer.spawnClusterSplitFX(dx, dy, b.colorR, b.colorG, b.colorB, angles)
        Renderer.spawnDetonationBurst(dx, dy, b.ringRadius, b.colorR, b.colorG, b.colorB)   // same destruction explosion as a normal detonation
        // Pass parent overshoot as child startElapsed — each generation absorbs its parent's
        // frame slop so timing stays locked to the ideal beat regardless of cluster depth.
        const parentOvershoot = Math.max(0, b.elapsed - b.lifetime)
        spawnSalvo(b.ownerEnemy, b.ringIndex, nextLayerIndex, dx, dy, false, childBornRotation, parentOvershoot)
      }
      enemyBullets[i] = enemyBullets[enemyBullets.length - 1]!
      enemyBullets.pop()
    }
  }
  fireStaccatoHopTethers()
}

// Staccato + Tether — the salvo's beam re-snaps between the FROZEN bullets on EACH beat (not just
// at detonation), so it walks toward the player and strikes every time they hold position. Fired
// once per integer beat per salvo at the bullets' current hop positions, reusing the normal tether
// visual + strike (prearmTime 0 = instant snap on the beat). Skips the spawn beat (bullets still
// bunched at the enemy) by requiring at least one completed hop.
const staccatoTetherFiredBeat = new Map<number, number>()  // salvoId → last integer beat fired
// Reused across frames so the per-frame salvo grouping doesn't allocate a fresh Map + sub-arrays
// every tick while staccato+tether bullets are in flight. Bullet flights are beat-aligned, so that
// GC churn was landing right on the beat — the worst moment for a hitch.
const staccatoHopGroups = new Map<number, EnemyBullet[]>()
const staccatoGroupPool: EnemyBullet[][] = []
function fireStaccatoHopTethers(): void {
  const curBeat = getAbsoluteBeats()
  // Recycle last frame's group arrays into the pool, then reuse the same Map (clear is alloc-free).
  for (const arr of staccatoHopGroups.values()) { arr.length = 0; staccatoGroupPool.push(arr) }
  staccatoHopGroups.clear()
  for (const b of enemyBullets) {
    if (!b.staccato || !b.released || b.elapsed < b.launchDelay) continue
    if (b.staccatoReleased <= 0.001) continue   // not hopped yet
    const rs = b.layerIndex === 0 ? b.ownerEnemy.rings[b.ringIndex] : b.ownerEnemy.rings[b.ringIndex]?.childLayers[b.layerIndex - 1]
    if (!rs || rs.tetherMode === 'off') continue
    let arr = staccatoHopGroups.get(b.salvoId)
    if (!arr) { arr = staccatoGroupPool.pop() ?? []; staccatoHopGroups.set(b.salvoId, arr) }
    arr.push(b)
  }
  for (const [salvoId, arr] of staccatoHopGroups) {
    // Sort kept ON PURPOSE: enemyBullets uses swap-remove, so a salvo's bullets can fall out of
    // salvoIndex order as other bullets die — chain/ring topology connects segments in this order.
    if (arr.length < 2) continue
    arr.sort((a, b) => a.salvoIndex - b.salvoIndex)
    const b0 = arr[0]!
    // Fire exactly when a HOP completes, so the strike lands on the beat grid (never mid-beat —
    // that was making the first one late + muddling the SFX). Mirror the bullet's own hop grid,
    // dedupe by hop so each strikes once. Fire from hop 1 — the first STOP is already a spread-out
    // position (not the bunched origin), so the web starts there.
    const div = b0.staccatoDivision
    const ph = b0.staccatoPhase
    const g = (curBeat - STACCATO_LEAD - ph) * div
    const completed = Math.floor(g) - Math.floor((b0.staccatoFireBeat - STACCATO_LEAD - ph) * div)
    // Fire TETHER_TELEGRAPH_LEAD before the next hop lands (telegraph early), or at completion as
    // a fallback if a slow frame skipped that window. `leadTime` = seconds until the hop boundary,
    // baked into prearm so the strike lands on the SAME beat regardless of how early we fired.
    const toNextBeats = (Math.floor(g) + 1 - g) / div
    let hopK: number
    let leadTime: number
    if (toNextBeats * BEAT_SEC <= TETHER_TELEGRAPH_LEAD) {
      hopK = completed + 1                 // the hop about to land
      leadTime = toNextBeats * BEAT_SEC
    } else {
      hopK = completed                     // the hop just landed (fallback / normal)
      leadTime = 0
    }
    if (hopK < 1) continue
    if (staccatoTetherFiredBeat.get(salvoId) === hopK) continue
    staccatoTetherFiredBeat.set(salvoId, hopK)
    const rs0 = b0.layerIndex === 0 ? b0.ownerEnemy.rings[b0.ringIndex] : b0.ownerEnemy.rings[b0.ringIndex]?.childLayers[b0.layerIndex - 1]
    if (!rs0) continue
    // Beam thickness inherits layer 0 so chained hop tethers match the first set's width.
    const tetherW0 = b0.ownerEnemy.rings[b0.ringIndex]?.tetherWidth ?? rs0.tetherWidth
    // Predict each bullet's position AT hop hopK (progress = hopK / staccatoHops) so the early
    // telegraph sits where the bullets are about to snap, not where they currently are.
    const xs = arr.map(b => b.x + (hopK / b.staccatoHops - b.staccatoReleased) * b.vx * b.lifetime)
    const ys = arr.map(b => b.y + (hopK / b.staccatoHops - b.staccatoReleased) * b.vy * b.lifetime)
    const hopPrearm = TETHER_PREARM_HOP + leadTime   // +leadTime keeps the strike on its beat
    tetherEntities.push({
      xs, ys, topology: rs0.tetherMode, width: tetherW0, damage: b0.damage,
      colorR: b0.colorR, colorG: b0.colorG, colorB: b0.colorB,
      bornTime: tetherClock, struckProbed: false, prearmTime: hopPrearm, playerHit: false,
      consume: b0.ownerEnemy.consume, enemyOwner: b0.ownerEnemy,
      consumeFired: false, tetherSound: rs0.tetherSound, patternName: rs0.patternName,
      soundFired: false, probeTag: 'hop',
    })
    Renderer.addTetherViz(xs, ys, rs0.tetherMode, tetherW0, b0.colorR, b0.colorG, b0.colorB, hopPrearm, tetherClock)
  }
  // Keep the dedupe map bounded to live salvos
  if (staccatoTetherFiredBeat.size > staccatoHopGroups.size) {
    for (const sid of staccatoTetherFiredBeat.keys()) if (!staccatoHopGroups.has(sid)) staccatoTetherFiredBeat.delete(sid)
  }
}

// Advance enemy detonations. At peak, apply damage to the player if in range. Detonations
// are removed when their attackTimer exceeds expandTime + linger.
function updateEnemyDetonations(dt: number): void {
  if (enemyDetonations.length === 0) return
  const player = getPlayer()
  for (let i = enemyDetonations.length - 1; i >= 0; i--) {
    const d = enemyDetonations[i]!
    const prev = d.attackTimer
    d.attackTimer += dt
    // Peak hit check — fires exactly once on the frame where attackTimer crosses expandTime
    if (!d.peakFired && prev < d.expandTime && d.attackTimer >= d.expandTime) {
      d.peakFired = true
      // Ring sound — fires exactly at the damage moment (peak), not at landing. Player
      // perceives this as "the ring hit" rather than "the bullet arrived."
      if (d.sound) playEnemyBeatTick(d.patternName, d.sound)
      // Player hit if distance from detonation center to player crosses the ring at peak.
      // Mirrors enemy-ring hit detection logic (`Math.abs(dist - ringRadius) < hitRadius`).
      const px = player.x - d.x
      const py = player.y - d.y
      const pdist = Math.sqrt(px * px + py * py)
      if (Math.abs(pdist - d.ringRadius) < player.hitRadius) {
        // Skip if ghost-dashing (matches existing player-ring damage gating)
        if (!(player.dashTimer >= 0 && hasBonus('ghostDash'))) {
          if (hurtPlayer(player, d.damage)) playPlayerHit()
        }
      }
      // Consume — eat orbs touching the ring's circumference at peak, heal source enemy.
      // Mirrors revenge-ring consume logic. Skips if owner is dead.
      if (d.consume) {
        const owner = d.enemyOwner
        const allOrbs = getOrbs()
        for (const orb of allOrbs) {
          if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
          const odx = orb.x - d.x
          const ody = orb.y - d.y
          const oDist = Math.sqrt(odx * odx + ody * ody)
          if (Math.abs(oDist - d.ringRadius) < orb.radius + 2) {
            collectOrb(orb, 'enemy')
            healEnemy(owner, 1)
            const isHP = orb.orbType === 'hp'
            Renderer.addAbsorbEffect(orb.x, orb.y, isHP ? 250 : 150, isHP ? 190 : 255, isHP ? 134 : 200, owner.x, owner.y, owner)
          }
        }
      }
    }
    // Remove after linger window
    if (d.attackTimer > d.expandTime + 0.05) {
      enemyDetonations[i] = enemyDetonations[enemyDetonations.length - 1]!
      enemyDetonations.pop()
    }
  }
}

// Accessors for the renderer to draw bullets + detonations
export function getEnemyBullets(): readonly EnemyBullet[] { return enemyBullets }
export function getEnemyDetonations(): readonly EnemyDetonation[] { return enemyDetonations }

// Iterate the connection pairs for a given topology — produces (a, b) index pairs for the
// `n` points. Used by the hit check + (mirrored) by the renderer for the visual beams.
function* tetherPairs(topology: TetherTopology, n: number): Generator<[number, number]> {
  if (n < 2) return
  if (topology === 'closed') {
    for (let i = 0; i < n; i++) yield [i, (i + 1) % n]
  } else if (topology === 'open') {
    for (let i = 0; i < n - 1; i++) yield [i, i + 1]
  } else if (topology === 'pairs') {
    for (let i = 0; i + 1 < n; i += 2) yield [i, i + 1]
  } else if (topology === 'star') {
    // Hub = centroid; treat as virtual index n. Caller must compute centroid separately.
    for (let i = 0; i < n; i++) yield [i, n]
  } else if (topology === 'all') {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) yield [i, j]
  }
}

// Squared distance from a point to a line segment AB.
function distSqPointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax, aby = by - ay
  const lenSq = abx * abx + aby * aby
  if (lenSq < 0.001) {
    const ex0 = px - ax, ey0 = py - ay
    return ex0 * ex0 + ey0 * ey0
  }
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const cx = ax + abx * t, cy = ay + aby * t
  const ex = px - cx, ey = py - cy
  return ex * ex + ey * ey
}

function updateTethers(dt: number): void {
  if (tetherEntities.length === 0) return
  const player = getPlayer()
  for (let i = tetherEntities.length - 1; i >= 0; i--) {
    const t = tetherEntities[i]!
    const elapsed = tetherClock - t.bornTime   // shared clock — locked to the viz telegraph
    // Pre-arm gate — tether is dormant until prearmTime elapses. Bullets have landed and
    // rings are already expanding by the time we reach this point, but no damage/visual yet.
    // Strike sound — fired SOUND_AUDIO_LATENCY before materialization so the heard tick lands with
    // the visual (same audio-latency lead the other beat sounds use). Checked BEFORE the prearm gate.
    if (!t.soundFired && elapsed >= t.prearmTime - (SOUND_AUDIO_LATENCY + TETHER_SOUND_EXTRA)) {
      t.soundFired = true
      if (t.tetherSound) playEnemyBeatTick(t.patternName, t.tetherSound)
    }
    if (!t.struckProbed && elapsed >= t.prearmTime) { t.struckProbed = true; probe('tether-' + t.probeTag) }  // one-shot
    if (elapsed < t.prearmTime) continue
    // Effective tether time = how long we've been MATERIALIZED. Hit windows + retire timing
    // are all measured from materialization, not raw spawn.
    const effective = elapsed - t.prearmTime
    // Player hit check — applies once per tether during the early bright window. Treat each
    // beam segment as a fat line of width tetherWidth; player hits if perpendicular distance
    // to any segment <= (hitRadius + width/2). Ghost-dash invuln mirrors the ring damage gate.
    if (!t.playerHit && effective <= TETHER_HIT_WINDOW) {
      const ghost = player.dashTimer >= 0 && hasBonus('ghostDash')
      if (!ghost) {
        const reach = player.hitRadius + t.width * 0.5
        const reachSq = reach * reach
        const n = t.xs.length
        let hubX = 0, hubY = 0
        if (t.topology === 'star') {
          for (let k = 0; k < n; k++) { hubX += t.xs[k]!; hubY += t.ys[k]! }
          hubX /= n; hubY /= n
        }
        for (const [a, b] of tetherPairs(t.topology, n)) {
          const ax = t.xs[a]!, ay = t.ys[a]!
          const bx = b === n ? hubX : t.xs[b]!
          const by = b === n ? hubY : t.ys[b]!
          if (distSqPointToSegment(player.x, player.y, ax, ay, bx, by) <= reachSq) {
            if (hurtPlayer(player, t.damage)) playPlayerHit()
            t.playerHit = true
            break
          }
        }
      }
    }
    // Consume — eat any orbs touching the beam segments, heal source enemy. One-shot during
    // the bright window (post-prearm). Mirrors revenge-ring consume.
    if (t.consume && !t.consumeFired && effective <= TETHER_HIT_WINDOW) {
      t.consumeFired = true
      const owner = t.enemyOwner
      const n = t.xs.length
      let hubX = 0, hubY = 0
      if (t.topology === 'star') {
        for (let k = 0; k < n; k++) { hubX += t.xs[k]!; hubY += t.ys[k]! }
        hubX /= n; hubY /= n
      }
      const halfW = t.width * 0.5
      // AABB broadphase — every segment endpoint lies within this box (the star hub is the
      // centroid, also inside), so an orb farther than its own `reach` from the box can't touch
      // any segment. One cheap reject per orb skips the O(segments) distance loop for distant orbs.
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (let k = 0; k < n; k++) {
        const x = t.xs[k]!, y = t.ys[k]!
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      const allOrbs = getOrbs()
      for (const orb of allOrbs) {
        if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
        const reach = orb.radius + halfW
        if (orb.x < minX - reach || orb.x > maxX + reach || orb.y < minY - reach || orb.y > maxY + reach) continue
        const reachSq = reach * reach
        let hit = false
        for (const [a, b] of tetherPairs(t.topology, n)) {
          const ax = t.xs[a]!, ay = t.ys[a]!
          const bx = b === n ? hubX : t.xs[b]!
          const by = b === n ? hubY : t.ys[b]!
          if (distSqPointToSegment(orb.x, orb.y, ax, ay, bx, by) <= reachSq) {
            hit = true
            break
          }
        }
        if (hit) {
          collectOrb(orb, 'enemy')
          healEnemy(owner, 1)
          const isHP = orb.orbType === 'hp'
          Renderer.addAbsorbEffect(orb.x, orb.y, isHP ? 250 : 150, isHP ? 190 : 255, isHP ? 134 : 200, owner.x, owner.y, owner)
        }
      }
    }
    if (effective >= TETHER_DUR) {
      tetherEntities[i] = tetherEntities[tetherEntities.length - 1]!
      tetherEntities.pop()
    }
  }
}

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
// Dispatcher — routes the beat-dash event to its actual behavior:
//   - Dash-shot (Bolt) → spawn a projectile that explodes 1 beat later (2 with Aftershock)
//   - Otherwise → apply the impact right here at (x, y)
// Reverb is handled INSIDE applyBeatDashImpact so it composes correctly with Dash-shot
// (Bolt + Reverb = the projectile explodes as a push wave at its destination).
function detonateBeatDash(x: number, y: number, radius: number, damage: number, pushScale: number = 1, dirX: number = 0, dirY: number = 0): void {
  // Skip dashShot path if no direction was supplied (e.g. an Aftershock queued from before the
  // upgrade was picked) — fall back to a normal impact instead of spawning a stationary projectile.
  if (hasBonus('dashShot') && (dirX !== 0 || dirY !== 0)) {
    spawnDashShot(x, y, dirX, dirY, radius, damage, pushScale)
    return
  }
  applyBeatDashImpact(x, y, radius, damage, pushScale)
}

// The actual beat-dash impact — damage, orb collect, blast visual/audio, Reverb branch. Called
// directly by detonateBeatDash for normal/Reverb dashes, and by updateDashShots when a Dash-shot
// projectile expires (so the explosion lands at the projectile's destination, not the dash origin).
function applyBeatDashImpact(x: number, y: number, radius: number, damage: number, pushScale: number = 1): void {
  const player = getPlayer()
  const enemies = getEnemies()
  // Reverb REPLACES the beat-dash damage explosion entirely — beat dash deals NO damage and
  // instead emits the push wave (see push block below). All beat-dash radius upgrades still
  // scale it (radius is passed in pre-scaled by beatBlastMult + Quiet Storm). Without Reverb,
  // the beat dash works as before (damage explosion).
  const reverbActive = hasBonus('shockPush')
  let beatDashHitCount = 0
  if (!reverbActive) {
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
  }

  // Collect orbs in blast area — ONLY when Reverb is OFF. The beat-dash AOE explosion is what
  // vacuums orbs; Reverb replaces that explosion with a push wave, so it must NOT collect orbs.
  // Instead the wave just shoves them (see push wave below), and the player's ring pulse picks
  // them up as normal — any the wave nudges into the ring get collected naturally.
  if (!reverbActive) {
    const allOrbs = getOrbs()
    for (const orb of allOrbs) {
      if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
      const odx = orb.x - x
      const ody = orb.y - y
      if (odx * odx + ody * ody <= (radius + orb.radius) * (radius + orb.radius)) {
        collectOrb(orb)
        if (orb.orbType === 'hp') {
          healPlayer(player, 1)
        } else {
          player.xp += orb.value * player.modifiers.xpMult
        }
      }
    }
  }
  // Reverb — the beat-dash push wave (REPLACES the damage explosion; see reverbActive gate
  // on the damage loop above). Push radius is 2× the would-be damage radius, scaling with
  // every beat-dash radius upgrade (beatBlastMult) and Quiet Storm's 2×. Player not affected
  // (source). Heavy enemies get HEAVY_RESIST.
  if (reverbActive) {
    const pushRadius = radius * 2.75        // beat-dash AOE size (was 2.5×, +10%)
    const pushStrength = 6000 * pushScale   // base (at center); scales with AOE upgrades so a bigger wave hits harder. Falloff scales it down toward the edge
    // Distance falloff — full strength at the dash center, dropping to PUSH_EDGE_FRAC at the
    // outer edge of the push radius. So slamming an enemy point-blank flings it hard; an
    // enemy barely caught at the rim just gets nudged.
    const PUSH_EDGE_FRAC = 0.35       // minimum push fraction at the outer rim
    // Reverb is the player's signature knockback, so heavies should still clearly FLY — use a
    // gentler resist here than the shared HEAVY_RESIST (0.5). At 0.6 a heavy edge-hit gets
    // 6000×0.35×0.6 ≈ 1260 px/s instead of 1050, enough to read as a real shove on a big body.
    const REVERB_HEAVY_RESIST = 0.6
    // Spawn a TIME-SWEPT wave rather than pushing instantly: updateShockWaves() shoves each
    // enemy/orb only once the expanding front reaches its body, so the knockback lands in
    // lockstep with the visual ring instead of all at once before it makes contact. The
    // matching cyan visual + SFX start now at detonation.
    spawnShockWave(x, y, pushRadius, pushStrength, PUSH_EDGE_FRAC, REVERB_HEAVY_RESIST)
    Renderer.triggerShockPush(x, y, pushRadius)
    // Blue lightning burst at the explosion focal point — same arc vocabulary as Bolt's
    // crackle, fixed in place, ~0.3s burst. Sized to ~45% of the push radius so it reads as
    // a concentrated discharge at the center of the push wave.
    Renderer.triggerBlueLightning(x, y, pushRadius * 0.45)
    playShockPush()
  }

  // SFX + Visual — the gold damage-explosion flash + particles only when Reverb is NOT
  // active. With Reverb, the cyan push wave (triggered above) IS the beat-dash visual.
  playBeatDash()
  if (!reverbActive) {
    Renderer.triggerBeatDashFlash(x, y, radius)
    Renderer.spawnVolatileParticles(x, y, radius, 0, 230, 255)
  }
  // Background ripple — fires for BOTH paths (normal gold flash AND Reverb cyan push) so the
  // floor wave reads on every beat-blast regardless of which AOE visual is showing.
  Renderer.triggerBackgroundRipple(x, y)

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
  // Screen-space "you nailed the beat" confirmation — vignette pulse + corner brackets. Fires
  // the moment the on-beat dash registers (independent of the AOE/aftershock-pie/Bolt branch
  // below) so the player sees the confirmation even if the actual explosion is delayed.
  Renderer.triggerBeatDashConfirm()
  // Beat-dash radius scales with beatBlastMult only — NOT ringRadiusMult. Ring-range
  // upgrades already grow the main ring; coupling them to the beat-dash too would let one
  // upgrade pull double duty.
  // Quiet Storm: if the dash consumed a full charge, double the AOE radius (visual ring
  // already telegraphed this 2× area during the charge fill). chargedDashActive flag is
  // set at dash initiation and cleared here so it only buffs ONE beat-dash event.
  const aoeMult = player.chargedDashActive ? 2.0 : 1.0
  const shockRadius = player.ring.radius * BEAT_DASH_RADIUS_MULT * player.modifiers.beatBlastMult * aoeMult
  const damage = player.damage * player.modifiers.damageMult
  // Reverb push strength scales with the same upgrades that grow the AOE (beat blast + Quiet
  // Storm) so a bigger wave hits harder, but dampened by ^0.35 (gentler than sqrt) so the push
  // doesn't ramp too fast at high stacks. 1.0 at base. Examples: ×1.5 raw → ×1.15 push, ×2.0
  // (Quiet Storm) → ×1.27, ×3.0 (Quiet Storm + max beat blast) → ×1.46.
  const pushScale = Math.pow(player.modifiers.beatBlastMult * aoeMult, 0.35)
  if (player.chargedDashActive) player.chargedDashActive = false
  placeBeatDash(player, shockRadius)
  // With Bolt (Dash-shot): bypass Aftershock's pendingDetonations queue entirely. Aftershock's
  // pie telegraphs the explosion AT THE PLAYER, but with Bolt the explosion happens at the
  // projectile's destination — the pie at player position would be misleading. Bolt composes
  // Aftershock by doubling the projectile lifetime instead (handled in spawnDashShot).
  const useAftershockPie = hasBonus('aftershock') && !hasBonus('dashShot')
  if (useAftershockPie) {
    pendingDetonations.push({
      x: player.x, y: player.y,
      radius: shockRadius, damage, pushScale,
      timer: BEAT_SEC, lifetime: BEAT_SEC,
    })
    Renderer.addPendingDetonation(player.x, player.y, shockRadius, BEAT_SEC)
    playFuseStart()
  } else {
    detonateBeatDash(player.x, player.y, shockRadius, damage, pushScale, player.dashDirX, player.dashDirY)
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
// Monotonic sim-time clock for tether timing. Advances ONLY in update() (so it pauses with the
// game), every frame regardless of phase. Both the sim tether strike AND the viz telegraph read
// THIS single clock, so they can't drift apart at low/variable framerate (the old desync: the
// sim ran on the fixed-timestep accumulator while the viz counted real render dt).
let tetherClock = 0
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
  // Bouncer redirect: a bouncing enemy's patrol heading (bounceVx/Vy) is a SEPARATE channel
  // from the launch, so once the launch decays it would snap back to its old bounce angle. Any
  // push (wall spring, Reverb, pusher enemy) all route through here, so re-aim the bounce
  // heading to the push direction — the bouncer keeps travelling the way it was shoved, at its
  // constant patrol speed. Walls/other bouncers still reflect it from there as normal.
  if ('movePattern' in entity && (entity as Enemy).movePattern === 'bounce') {
    const b = entity as Enemy
    b.bounceVx = nx * b.moveSpeed
    b.bounceVy = ny * b.moveSpeed
  }
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
    // Heavy yields HEAVY_YIELD so an orb pinned against / between heavies can carve its own
    // space instead of oscillating with no exit. Heavy still reads as immovable visually.
    orbPush = total * (1 - HEAVY_YIELD); otherPush = total * HEAVY_YIELD
  } else if (launchedOrb && !launchedOther) {
    orbPush = 0; otherPush = total
  } else if (!launchedOrb && launchedOther) {
    orbPush = total; otherPush = 0
  } else if (isEnemy && orb.orbType === 'hp') {
    // Heart vs regular enemy (neither launched) — heart is heavier, enemy yields slightly
    // more so hearts act as a soft obstacle in enemy pathing. Subtle nudge over the 0.5/0.5
    // default used for XP orbs (and for hearts vs other orbs).
    orbPush = total * 0.35; otherPush = total * 0.65
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
        playBoing(true)   // player bounce — loud
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
        playBoing(false)   // enemy bounce — quieter, throttled
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

// ── Wall damage/heal zones — beat-locked band pulses (mirrors the spring's fire+grace shape) ──
const ZONE_GRACE_BEATS = 0.18
const zoneHitThisFire = new WeakMap<Wall, Set<unknown>>()

// Apply one zone pulse's effect to everything inside the wall's band (capsule grown by range).
// Same closest-point distance test as the spring trigger, but the reach is the full zone range
// and the effect is HP, not a launch. Each entity is hit at most once per fire (grace re-checks).
function tryHitZone(
  w: Wall,
  player: ReturnType<typeof getPlayer>,
  enemies: ReturnType<typeof getEnemies>,
): number {
  // Returns a bitmask of what was actually HEALED this call (1 = player, 2 = an enemy) so the
  // caller can play the right heal SFX once per pulse. No object alloc in the hot/grace path.
  let healFlags = 0
  if (!w.zone) return healFlags
  const hit = zoneHitThisFire.get(w)
  if (!hit) return healFlags
  const heal = w.zone.mode === 'heal'
  const range = w.zone.range
  const playerR = PLAYER_RADIUS * player.modifiers.sizeMult
  // Player
  {
    const cp = closestPointOnWall(w, player.x, player.y)
    const dx = player.x - cp.x, dy = player.y - cp.y
    const reach = w.radius + range + playerR
    if (dx * dx + dy * dy < reach * reach) {
      if (!hit.has(player)) {
        hit.add(player)
        if (heal) { if (healPlayer(player, 1) > 0) healFlags |= 1 }   // event-driven gold pulse
        else if (hurtPlayer(player, 1)) playPlayerHit()
      }
    } else hit.delete(player)
  }
  for (const e of enemies) {
    if (!e.alive || e.dying || e.summon) continue
    const cp = closestPointOnWall(w, e.x, e.y)
    const dx = e.x - cp.x, dy = e.y - cp.y
    const reach = w.radius + range + e.radius
    if (dx * dx + dy * dy < reach * reach) {
      if (!hit.has(e)) {
        hit.add(e)
        if (heal) {
          if (healEnemy(e, 1) > 0) healFlags |= 2   // event-driven gold sparkle
        } else {
          const wasDying = e.dying
          damageEnemy(e, 1)
          if (e.revenge) emit('enemy:revenge', e)
          if (e.totemSpawn) emit('totem:spawn', e)
          if (e.dying && !wasDying) spawnDrops(e, 1, spawnOrb)
        }
      }
    } else hit.delete(e)
  }
  return healFlags
}

function processZoneFires(): void {
  const fires = consumeZoneFires()
  const player0 = getPlayer()
  const enemies0 = getEnemies()
  // Pass 1 — fresh fires: reset the per-fire hit set + spawn the burst for every fire, THEN apply
  // effects HEALS-FIRST so a same-beat heal grants its overheal buffer before the damage lands (the
  // hit gets soaked → net 0, deterministically, regardless of wall placement order).
  if (fires.length > 0) {
    for (const fire of fires) {
      const w = fire.wall
      if (!w.zone) continue
      zoneHitThisFire.set(w, new Set())
      // Inline flash/edge/ripple (drawWalls) + this rich debris burst, the latter parent-attached
      // to the wall's live center+rotation so the whole explosion rides a moving/turning wall.
      Renderer.spawnWallZoneBurst(w, w.zone.mode === 'heal')
    }
    let healFlags = 0
    for (const fire of fires) if (fire.wall.zone?.mode === 'heal') healFlags |= tryHitZone(fire.wall, player0, enemies0)
    for (const fire of fires) if (fire.wall.zone?.mode === 'damage') tryHitZone(fire.wall, player0, enemies0)
    // One heal SFX per beat per kind — bright chime if it healed the player, dull/ominous tone if it
    // healed an enemy (bad for you). Only fires when a heal actually landed (not at full HP).
    if (healFlags & 1) playHeal()   // unified heal chime (same as volatile nourish)
    if (healFlags & 2) playWallHealEnemy()
  }
  // Pass 2 — grace window: re-check the band for a short spell so an entity that slips in a frame
  // after the beat still takes the pulse once (mirrors the spring grace). Heals before damage here too.
  const beatPos = getAbsoluteBeats()
  const wallsLive = getWalls()
  const graceTick = (w: Wall): void => {
    if (!w.zone || w.zoneLastFireBeat == null) return
    if (!zoneHitThisFire.has(w)) return
    const bsf = beatPos - w.zoneLastFireBeat
    if (bsf <= 0) return
    if (bsf > ZONE_GRACE_BEATS) { zoneHitThisFire.delete(w); return }
    tryHitZone(w, player0, enemies0)
  }
  for (const w of wallsLive) if (w.zone?.mode === 'heal') graceTick(w)
  for (const w of wallsLive) if (w.zone?.mode === 'damage') graceTick(w)
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
        playBoing(true)   // player bounce — loud
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
        playBoing(false)
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
  shockWaves.length = 0
  pendingSounds.length = 0
  pendingPushDetonations.length = 0
  for (const p of dashShotProjectiles) stopDashShotCrackle(p.crackleId)   // silence any in-flight bolts before clearing the list
  dashShotProjectiles.length = 0
  enemyBullets.length = 0
  enemyDetonations.length = 0
  tetherEntities.length = 0
  pendingSalvos.clear()
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
  // D_TOTAL = whole designer-update path. The designer skips the normal update() body, so
  // WITHOUT this the designer's per-frame sim cost (bullets/tethers/enemies/collision) was
  // completely unmeasured — only R_TOTAL (render) showed up. Mirrors U_TOTAL for gameplay.
  perfStart('D_TOTAL')
  tetherClock += dt                      // designer has its own update path; advance the shared
  Renderer.setTetherClock(tetherClock)   // tether clock here too or tether telegraphs freeze
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
    processZoneFires()
    processPusherEnemies()
  }
  Input.flush()
  const player = getPlayer()
  const cam = getCamera()
  const enemies = getEnemies()
  const grid = getGrid()
  perfStart('u_player'); updatePlayer(player, dt); perfEnd('u_player')
  perfStart('u_dashshots'); updateDashShots(dt); perfEnd('u_dashshots')     // Bolt projectiles
  perfStart('u_bullets'); updateEnemyBullets(dt); perfEnd('u_bullets')      // bullets travel + cluster cascade spawn
  perfStart('u_shockwaves'); updateShockWaves(dt); perfEnd('u_shockwaves')  // Reverb / push-mode wave
  perfStart('u_detons'); updateEnemyDetonations(dt); perfEnd('u_detons')    // detonation rings + peak damage
  perfStart('u_tethers'); updateTethers(dt); perfEnd('u_tethers')           // tether beams + damage window
  // Push-mode wave/visual + ring-sound queues (shared label with the gameplay path).
  perfStart('u_pending'); updatePendingPushDetonations(dt); updatePendingSounds(dt); perfEnd('u_pending')
  // Tick all alive enemies (spawn-test ephemerals AND any children they summon — totems,
  // shrines, summoners. Without this, summoned children stay frozen at spawn radius 1 = "tiny specs").
  // Player can take damage normally — but won't die because death check is gated to phase 'playing'.
  perfStart('u_grid')
  grid.clear()
  for (const e of enemies) {
    if (e.alive) grid.insert(e)
  }
  for (const orb of getOrbs()) {
    if (orb.alive && !orb.dying) grid.insert(orb)
  }
  perfEnd('u_grid')
  // Process queued volatile explosions so designer-spawned exploders actually detonate
  processVolatileExplosions(player, enemies, dt)
  // Process pending revenge rings — without this, revenge enemies in designer queue their
  // rings but the ring damage never gets applied (mirrors the main-loop pass).
  for (let i = pendingRevenges.length - 1; i >= 0; i--) {
    const pr = pendingRevenges[i]!
    pr.timer += dt
    if (pr.timer >= pr.expandTime) {
      for (const origin of pr.origins) {
        const pdx = player.x - origin.x
        const pdy = player.y - origin.y
        const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
        if (Math.abs(pDist - pr.radius) < player.hitRadius) {
          if (!(player.dashTimer >= 0 && hasBonus('ghostDash'))) {
            if (hurtPlayer(player, pr.damage)) playPlayerHit()
          }
          break
        }
      }
      // Consume: eat orbs at ring peak, heal source enemy (mirrors the main-loop pass — without
      // this, revenge+consume enemies fire rings in the designer but never eat the hearts).
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
              healEnemy(pr.enemy, 1)
              const isHP = orb.orbType === 'hp'
              Renderer.addAbsorbEffect(orb.x, orb.y, isHP ? 250 : 150, isHP ? 190 : 255, isHP ? 134 : 200, pr.enemy.x, pr.enemy.y, pr.enemy)
              break  // one origin per orb
            }
          }
        }
      }
      pendingRevenges[i] = pendingRevenges[pendingRevenges.length - 1]!
      pendingRevenges.pop()
    }
  }
  // Process pending Aftershock detonations in designer too — without this the fuse pie
  // ticks visually (see Renderer designer-phase check) but the boom never fires.
  for (let i = pendingDetonations.length - 1; i >= 0; i--) {
    const pd = pendingDetonations[i]!
    pd.timer -= dt
    if (pd.timer <= 0) {
      detonateBeatDash(pd.x, pd.y, pd.radius, pd.damage, pd.pushScale)
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
  perfStart('u_enemies')
  for (const e of enemies) {
    if (e.dying) updateDeath(e, dt)
    else if (e.alive) updateEnemy(e, player, dt, grid)
  }
  perfEnd('u_enemies')
  // Ritual nodes (orbiting nodes around summoners) — without this, summoner nodes are frozen.
  updateRitualNodes(dt)
  // Tick orbs (grow-in, animations). Player pushes orbs aside on contact — collection happens
  // via the ring sweep (HitDetection's player:beat handler), same as real game.
  perfStart('u_orbs')
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
  perfEnd('u_orbs')
  perfStart('u_collision')
  // Orb separation (grid-accelerated, mirrors real-game pass). Uses resolveOrbCollision
  // helper so the battering-ram rules stay in sync with the real-game pass below.
  for (const orb of orbs) {
    if (!orb.alive || orb.dying) continue
    const nearby = grid.query(orb)
    for (const other of nearby) {
      if (other === orb) continue
      const isEnemy = 'hp' in other
      // Don't let a fresh drop be shoved off a DYING enemy's corpse (pinned at the death spot) — that
      // slid the hearts out to the big corpse's edge in a lopsided curved line.
      if (isEnemy && (other as Enemy).dying) continue
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
          // Heavy yields HEAVY_YIELD so a normal pinned can carve space instead of vibrating.
          enemy.x += nx * overlap * (1 - HEAVY_YIELD); enemy.y += ny * overlap * (1 - HEAVY_YIELD)
          oe.x    -= nx * overlap * HEAVY_YIELD;       oe.y    -= ny * overlap * HEAVY_YIELD
        } else if (enemy.immovable) {
          oe.x    -= nx * overlap * (1 - HEAVY_YIELD); oe.y    -= ny * overlap * (1 - HEAVY_YIELD)
          enemy.x += nx * overlap * HEAVY_YIELD;       enemy.y += ny * overlap * HEAVY_YIELD
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
  perfEnd('u_collision')
  // Drop dead/cleaned enemies (ephemerals + their offspring)
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i]!
    if (!e.alive && !e.dying) enemies.splice(i, 1)
  }
  const dir = Input.getMovementDir()
  updateCamera(cam, player.x, player.y, dir.x, dir.y, Renderer.getLogicalSize().w, Renderer.getLogicalSize().h, dt, Renderer.getCameraZoom())
  updatePreviewEnemy(dt)
  perfEnd('D_TOTAL')
}

export function clearDesignerEphemerals(): void {
  // Wipe all enemies (ephemeral spawn-test + any children they summoned) + orbs they dropped.
  // The designer scene should be empty unless the user re-spawns.
  const enemies = getEnemies()
  enemies.length = 0
  resetOrbs()
}

export function update(dt: number): void {
  // Perf-log export (P) — checked BEFORE the per-phase early-returns so it works in the
  // designer / paused / any phase, not just active play. Perf data accumulates every frame in
  // render() regardless of phase, so the export is valid wherever you press it.
  if (Input.isKeyDown('p') && !perfExportLock) {
    perfExportLock = true
    exportPerfLog()
  }
  if (!Input.isKeyDown('p')) perfExportLock = false

  const phase = getPhase()
  // Perf attribution: tag every frame with its phase and count this fixed-update step so the
  // tracker works in EVERY mode (not just play/designer) and catch-up spirals are visible.
  perfSetPhase(phase)
  perfStep()

  if (phase === 'designer') {
    updateDesigner(dt)
    return
  }
  if (phase === 'title' || phase === 'dead' || phase === 'challenge_select' || phase === 'paused' || phase === 'entering_name') {
    perfStart('PHASE_UPD'); advancePatternClock(dt); perfEnd('PHASE_UPD')
    return
  }
  if (phase === 'upgrading') {
    perfStart('PHASE_UPD'); updateUpgradeScreen(dt); perfEnd('PHASE_UPD')
    return
  }
  if (phase === 'shopping') {
    perfStart('PHASE_UPD'); updateShopScreen(dt); perfEnd('PHASE_UPD')
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
      detonateBeatDash(pd.x, pd.y, pd.radius, pd.damage, pd.pushScale)
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
    const shapes = ['rect', 'circle', 'hex', 'pill', 'cross', 'polygon'] as const
    const cur = shapes.indexOf(getArenaShape())
    setArenaShape(shapes[(cur + 1) % shapes.length]!)
  }
  if (!Input.isKeyDown('g')) arenaToggleLock = false

  perfStart('U_TOTAL')

  tickAudioHealth()  // auto-fix suspended AudioContext on mobile
  advanceGlobalTime(dt)
  advancePatternClock(dt)
  // Tick wall motion (rotating walls etc.) using a monotonic absolute beat counter. Using
  // getLoopPosition (modulo song-loop) would snap walls backwards when beatsPerCycle exceeds
  // the song loop length — e.g. a 12-beats/rev rotation in an 8-beat song would reset every 8.
  updateWalls(getAbsoluteBeats())
  processSpringFires()
  processZoneFires()
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

  perfStart('u_dashshots'); updateDashShots(dt); perfEnd('u_dashshots')    // Bolt projectiles — advance + detonate on expiry
  perfStart('u_bullets'); updateEnemyBullets(dt); perfEnd('u_bullets')     // Enemy ranged ring bullets — travel, then detonate
  perfStart('u_shockwaves'); updateShockWaves(dt); perfEnd('u_shockwaves') // Reverb / push-mode wave — runs AFTER spawners
  perfStart('u_detons'); updateEnemyDetonations(dt); perfEnd('u_detons')   // Detonation rings expand; apply damage at peak
  perfStart('u_tethers'); updateTethers(dt); perfEnd('u_tethers')          // Tether beams — damage window, retire after fade
  // Push-mode wave/visual + ring-sound queues — fire shortly after landing so wave/strike align.
  perfStart('u_pending'); updatePendingPushDetonations(dt); updatePendingSounds(dt); perfEnd('u_pending')

  // Danger music — dark layer when low HP
  updateDangerMusic(player.hp / player.maxHp)

  // Challenge elapsed timer
  challengeElapsed += dt
  tetherClock += dt
  Renderer.setTetherClock(tetherClock)   // hand the viz the same clock so the red telegraph can't drift

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
  updateCamera(cam, player.x, player.y, dir.x, dir.y, Renderer.getLogicalSize().w, Renderer.getLogicalSize().h, dt, Renderer.getCameraZoom())

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
              healEnemy(pr.enemy, 1)
              const isHP = orb.orbType === 'hp'
              if (isHP) hpEatenThisRing++
              Renderer.addAbsorbEffect(orb.x, orb.y, isHP ? 250 : 150, isHP ? 190 : 255, isHP ? 134 : 200, pr.enemy.x, pr.enemy.y, pr.enemy)
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

  // Magnet pull — each orb attracted to closest magnet enemy. Collect live magnet enemies
  // ONCE up front so the per-orb loop only iterates magnets (and skips entirely when there are
  // none — the common case). Selection uses squared distance so the only sqrt is the single one
  // needed for the actual pull. Behavior is identical to the old O(orbs×enemies) scan.
  const magnetEnemies: Enemy[] = []
  for (const e of enemies) {
    if (e.alive && !e.dying && e.magnet) magnetEnemies.push(e)
  }
  if (magnetEnemies.length > 0) {
    const magnetOrbs = getOrbs()
    for (const orb of magnetOrbs) {
      if (!orb.alive || orb.dying) continue
      let closestDistSq = Infinity
      let closestEnemy: Enemy | null = null
      for (const enemy of magnetEnemies) {
        const dx = orb.x - enemy.x
        const dy = orb.y - enemy.y
        const distSq = dx * dx + dy * dy
        if (distSq < enemy.magnetRange * enemy.magnetRange && distSq < closestDistSq) {
          closestDistSq = distSq
          closestEnemy = enemy
        }
      }
      if (closestEnemy) {
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
  }
  perfEnd('u_orbs')

  // Multi-pass separation
  perfStart('u_collision')
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
            // Immovable barely moves (HEAVY_YIELD), other takes the rest
            enemy.x += nx * overlap * HEAVY_YIELD
            enemy.y += ny * overlap * HEAVY_YIELD
            oe.x -= nx * overlap * (1 - HEAVY_YIELD)
            oe.y -= ny * overlap * (1 - HEAVY_YIELD)
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
            // Heavy yields HEAVY_YIELD so a normal pinned against / between heavies can carve
            // its own space instead of vibrating forever. Self takes the rest of the overlap.
            const overlap = minDist - dist
            enemy.x += nx * overlap * (1 - HEAVY_YIELD)
            enemy.y += ny * overlap * (1 - HEAVY_YIELD)
            oe.x -= nx * overlap * HEAVY_YIELD
            oe.y -= ny * overlap * HEAVY_YIELD
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
        // Don't let a fresh drop be shoved off a DYING enemy's corpse (its body is pinned at the
        // death spot) — that scattered the hearts radially, biased rightward by the drop spiral.
        if (isEnemy && (other as Enemy).dying) continue
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

  perfEnd('u_collision')

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

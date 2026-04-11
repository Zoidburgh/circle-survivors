import { on, emit } from '../core/EventBus.ts'
import { getPlayer, getGrid, getEnemies } from '../core/GameState.ts'
import { getEffectiveRadius, hurtPlayer } from '../entities/Player.ts'
import { damageEnemy, getRingOrigins } from '../entities/Enemy.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { getRingExpansion, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { distance } from '../utils/math.ts'
import { HIT_GRACE, CHILL_MAX_STACKS } from '../utils/constants.ts'
import { playMiss, playHit, playEnemyBeatTick, playPlayerHit, playKill, playCollect } from '../audio/AudioEngine.ts'
import { getBlockedArcs, isTargetBlocked } from './RingOcclusion.ts'
import { spawnOrb, collectOrb, ORB_HP_HEAL } from '../entities/XPOrb.ts'
import type { XPOrb } from '../entities/XPOrb.ts'
import { addAbsorbEffect } from '../render/Renderer.ts'
import { hasBonus } from './UpgradeManager.ts'

export function initHitDetection(): void {
  on('player:beat', () => {
    const player = getPlayer()
    const grid = getGrid()

    // Find which ring timer is currently at peak (base or extra)
    let activeTimer = player.attackTimer
    for (let i = 0; i < player.extraRingCount; i++) {
      const t = player.extraRingTimers[i]!
      if (t >= 0 && Math.abs(t - ATTACK_EXPAND_TIME) < Math.abs(activeTimer - ATTACK_EXPAND_TIME)) {
        activeTimer = t
      }
    }
    const isDashing = player.dashTimer >= 0
    // During dash, use full ring radius to match visual sweep band
    const ringRadius = isDashing
      ? getEffectiveRadius(player)
      : getEffectiveRadius(player) * getRingExpansion(activeTimer)
    const grace = isDashing ? HIT_GRACE + 6 : HIT_GRACE
    const hitEnemies = new Set<Enemy>()
    const killedEnemies: Enemy[] = []

    // Build sweep positions — curved dash path or straight line
    const sweepPositions: { x: number; y: number }[] = []
    if (isDashing && player.dashPath.length > 1) {
      // Use last 30% of recorded dash path — ALL points, no sampling gaps
      const DASH_SWEEP_CAP = 0.3
      const startIdx = Math.floor(player.dashPath.length * (1 - DASH_SWEEP_CAP))
      for (let s = startIdx; s < player.dashPath.length; s++) {
        sweepPositions.push(player.dashPath[s]!)
      }
      sweepPositions.push({ x: player.x, y: player.y })
    } else {
      const steps = 4
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        sweepPositions.push({
          x: player.prevX + (player.x - player.prevX) * t,
          y: player.prevY + (player.y - player.prevY) * t,
        })
      }
    }

    for (const { x: sx, y: sy } of sweepPositions) {

      const ringEntity = { x: sx, y: sy, radius: ringRadius }
      const nearby = grid.query(ringEntity)
      for (const entity of nearby) {
        if (!('hp' in entity)) continue  // skip orbs
        const enemy = entity as Enemy
        if (!enemy.alive || hitEnemies.has(enemy)) continue
        const dist = distance({ x: sx, y: sy }, { x: enemy.x, y: enemy.y })
        // Also check blink destination if mid-phase
        let hitAtDest = false
        if (enemy.blink && enemy.blinkPreview > 0) {
          const destDist = distance({ x: sx, y: sy }, { x: enemy.blinkGhostX, y: enemy.blinkGhostY })
          hitAtDest = Math.abs(destDist - ringRadius) < enemy.radius + grace
        }
        if (Math.abs(dist - ringRadius) < enemy.radius + grace || hitAtDest) {
          const wasDying = enemy.dying
          damageEnemy(enemy, player.damage * player.modifiers.damageMult)
          hitEnemies.add(enemy)
          // Frostbite: apply chill stack
          if (hasBonus('chillHit')) {
            enemy.chillStacks = Math.min(enemy.chillStacks + 1, CHILL_MAX_STACKS)
            enemy.chillDecayTimer = 0
          }
          // Totem: spawn enemy on hit
          if (enemy.totemSpawn) {
            emit('totem:spawn', enemy)
          }
          // Revenge: fire immediately from current position (including killing blow)
          if (enemy.revenge) {
            emit('enemy:revenge', enemy)
          }
          if (enemy.dying && !wasDying) killedEnemies.push(enemy)
        }
      }
    }

    // Multi-kill XP bonus: 2+ kills in one beat = double XP per orb
    const multiKill = killedEnemies.length >= 2 && hasBonus('multiKillBonus')
    const orbValue = multiKill ? 2 : 1
    for (const dead of killedEnemies) {
      if (dead.dropType === 'none') continue
      spawnOrb(dead.x, dead.y, orbValue, dead.dropType)
    }

    // Check orbs along the same sweep (grid-accelerated)
    const collectedOrbs = new Set<XPOrb>()
    for (const { x: sx, y: sy } of sweepPositions) {
      const ringEntity = { x: sx, y: sy, radius: ringRadius }
      const nearbyOrbs = grid.query(ringEntity)
      for (const entity of nearbyOrbs) {
        if ('hp' in entity) continue  // skip enemies
        const orb = entity as XPOrb
        if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
        if (collectedOrbs.has(orb)) continue
        const odx = sx - orb.x
        const ody = sy - orb.y
        const oDist = Math.sqrt(odx * odx + ody * ody)
        const orbGrace = isDashing ? grace + 4 : grace
        if (Math.abs(oDist - ringRadius) < orb.radius + orbGrace) {
          collectOrb(orb)
          collectedOrbs.add(orb)
        }
      }
    }
    if (collectedOrbs.size > 0) {
      const multiCollect = collectedOrbs.size >= 2 && hasBonus('multiCollectBonus')
      const xpMult = player.modifiers.xpMult * (multiCollect ? 2 : 1)
      for (const orb of collectedOrbs) {
        if (orb.orbType === 'hp') {
          player.hp = Math.min(player.hp + ORB_HP_HEAL * orb.value, player.maxHp)
        } else {
          player.xp += orb.value * xpMult
        }
      }
      playCollect()
    }

    playMiss()
    if (hitEnemies.size > 0) {
      playHit()
    }
  })

  on('enemy:beat', (enemy, ringIndex) => {
    const player = getPlayer()
    if (!enemy.alive) return
    const rs = enemy.rings[ringIndex]
    if (!rs) return

    playEnemyBeatTick(rs.patternName, rs.sound)

    const ringRadius = rs.ring.radius * getRingExpansion(rs.attackTimer)
    const origins = getRingOrigins(enemy, rs)
    let playerHit = false
    for (const origin of origins) {
      const dist = distance({ x: player.x, y: player.y }, origin)
      if (Math.abs(dist - ringRadius) < player.hitRadius) {
        playerHit = true
        break
      }
    }
    if (playerHit) {
      if (player.dashTimer >= 0 && hasBonus('ghostDash')) return
      // Check occlusion from first origin (approximation)
      const arcs = getBlockedArcs(origins[0]!.x, origins[0]!.y, ringRadius, getEnemies(), enemy)
      const blocked = isTargetBlocked(origins[0]!.x, origins[0]!.y, player.x, player.y, arcs)
      if (!blocked) {
        if (hurtPlayer(player, enemy.damage)) playPlayerHit()
      }
    }

    // Consume: eat nearby orbs at ring peak, heal +1 per orb
    if (enemy.consume && ringRadius > 1) {
      const grid = getGrid()
      for (const origin of origins) {
      const ringEntity = { x: origin.x, y: origin.y, radius: ringRadius }
      const nearby = grid.query(ringEntity)
      for (const entity of nearby) {
        if ('hp' in entity) continue
        const orb = entity as XPOrb
        if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
        const oDist = distance(origin, { x: orb.x, y: orb.y })
        if (Math.abs(oDist - ringRadius) < orb.radius + HIT_GRACE) {
          collectOrb(orb, 'enemy')
          // Heal enemy
          if (enemy.hp < enemy.maxHp) {
            enemy.hp = Math.min(enemy.hp + 1, enemy.maxHp)
          }
          // Absorb stream from orb to enemy
          const isHP = orb.orbType === 'hp'
          const absR = isHP ? 255 : 150
          const absG = isHP ? 140 : 255
          const absB = isHP ? 140 : 200
          addAbsorbEffect(orb.x, orb.y, absR, absG, absB, enemy.x, enemy.y)
        }
      }
      } // end origins loop
    }
  })

  // Revenge damage handled in GameManager at ring peak timing

  on('enemy:killed', () => {
    playKill()
    // Orbs now spawned in player:beat handler for multi-kill tracking
  })
}

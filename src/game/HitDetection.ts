import { on, emit } from '../core/EventBus.ts'
import { getPlayer, getGrid, getEnemies } from '../core/GameState.ts'
import { getEffectiveRadius } from '../entities/Player.ts'
import { damageEnemy } from '../entities/Enemy.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { getRingExpansion, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { distance } from '../utils/math.ts'
import { HIT_FLASH_DURATION, HIT_GRACE, CHILL_MAX_STACKS } from '../utils/constants.ts'
import { playMiss, playHit, playEnemyBeatTick, playPlayerHit, playKill, playCollect } from '../audio/AudioEngine.ts'
import { getBlockedArcs, isTargetBlocked } from './RingOcclusion.ts'
import { spawnOrb, getOrbs, collectOrb, ORB_HP_HEAL, ORB_HP_DROP_CHANCE } from '../entities/XPOrb.ts'
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
    const ringRadius = getEffectiveRadius(player) * getRingExpansion(activeTimer)

    const isDashing = player.dashTimer >= 0
    const sweepFromX = isDashing ? player.dashStartX : player.prevX
    const sweepFromY = isDashing ? player.dashStartY : player.prevY
    const steps = isDashing ? 8 : 4
    const grace = isDashing ? HIT_GRACE + 6 : HIT_GRACE
    const hitEnemies = new Set<Enemy>()
    const killedEnemies: Enemy[] = []

    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const sx = sweepFromX + (player.x - sweepFromX) * t
      const sy = sweepFromY + (player.y - sweepFromY) * t

      const ringEntity = { x: sx, y: sy, radius: ringRadius }
      const nearby = grid.query(ringEntity)
      for (const entity of nearby) {
        const enemy = entity as Enemy
        if (!enemy.alive || hitEnemies.has(enemy)) continue
        const dist = distance({ x: sx, y: sy }, { x: enemy.x, y: enemy.y })
        if (Math.abs(dist - ringRadius) < enemy.radius + grace) {
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

    // Check orbs along the same sweep — collect first, then apply XP
    const orbs = getOrbs()
    const collectedOrbs = new Set<typeof orbs[number]>()
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const sx = sweepFromX + (player.x - sweepFromX) * t
      const sy = sweepFromY + (player.y - sweepFromY) * t
      for (const orb of orbs) {
        if (!orb.alive || orb.dying || orb.spawnTimer < 1) continue
        if (collectedOrbs.has(orb)) continue
        const odx = sx - orb.x
        const ody = sy - orb.y
        const oDist = Math.sqrt(odx * odx + ody * ody)
        if (Math.abs(oDist - ringRadius) < orb.radius + grace) {
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
    const dist = distance(
      { x: player.x, y: player.y },
      { x: enemy.x, y: enemy.y }
    )
    if (Math.abs(dist - ringRadius) < player.hitRadius) {
      // Ghost dash — invincible while dashing
      if (player.dashTimer >= 0 && hasBonus('ghostDash')) return

      const arcs = getBlockedArcs(enemy.x, enemy.y, ringRadius, getEnemies(), enemy)
      const blocked = isTargetBlocked(enemy.x, enemy.y, player.x, player.y, arcs)
      if (!blocked) {
        player.hp -= enemy.damage
        player.hitFlash = HIT_FLASH_DURATION
        playPlayerHit()
        if (player.hp <= 0) player.hp = 0
      }
    }
  })

  on('enemy:killed', () => {
    playKill()
    // Orbs now spawned in player:beat handler for multi-kill tracking
  })
}

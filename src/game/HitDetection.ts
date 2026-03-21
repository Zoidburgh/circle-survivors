import { on } from '../core/EventBus.ts'
import { getPlayer, getGrid, getEnemies } from '../core/GameState.ts'
import { getEffectiveRadius } from '../entities/Player.ts'
import { damageEnemy } from '../entities/Enemy.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { getRingExpansion } from '../core/PhaseSystem.ts'
import { distance } from '../utils/math.ts'
import { HIT_FLASH_DURATION } from '../utils/constants.ts'
import * as Audio from '../audio/AudioEngine.ts'
import { getBlockedArcs, isTargetBlocked } from './RingOcclusion.ts'

export function initHitDetection(): void {
  on('player:beat', () => {
    const player = getPlayer()
    const grid = getGrid()
    const ringRadius = getEffectiveRadius(player) * getRingExpansion(player.attackTimer)

    const isDashing = player.dashTimer >= 0
    const sweepFromX = isDashing ? player.dashStartX : player.prevX
    const sweepFromY = isDashing ? player.dashStartY : player.prevY
    const steps = isDashing ? 8 : 4
    const hitEnemies = new Set<Enemy>()

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
        if (Math.abs(dist - ringRadius) < enemy.radius) {
          damageEnemy(enemy, player.damage)
          hitEnemies.add(enemy)
        }
      }
    }

    Audio.playMiss()
    if (hitEnemies.size > 0) {
      Audio.playHit()
    }
  })

  on('enemy:beat', (enemy, ringIndex) => {
    const player = getPlayer()
    if (!enemy.alive) return
    const rs = enemy.rings[ringIndex]
    if (!rs) return

    Audio.playEnemyBeatTick(rs.patternName, rs.sound)

    const ringRadius = rs.ring.radius * getRingExpansion(rs.attackTimer)
    const dist = distance(
      { x: player.x, y: player.y },
      { x: enemy.x, y: enemy.y }
    )
    if (Math.abs(dist - ringRadius) < player.hitRadius) {
      const arcs = getBlockedArcs(enemy.x, enemy.y, ringRadius, getEnemies(), enemy)
      const blocked = isTargetBlocked(enemy.x, enemy.y, player.x, player.y, arcs)
      if (!blocked) {
        player.hp -= enemy.damage
        player.hitFlash = HIT_FLASH_DURATION
        Audio.playPlayerHit()
        if (player.hp <= 0) player.hp = 0
      }
    }
  })

  on('enemy:killed', () => {
    Audio.playKill()
  })
}

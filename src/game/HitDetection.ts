import { on } from '../core/EventBus.ts'
import { getPlayer, getEnemies } from '../core/GameState.ts'
import { getEffectiveRadius } from '../entities/Player.ts'
import { damageEnemy } from '../entities/Enemy.ts'
import { getRingExpansion } from '../core/PhaseSystem.ts'
import { distance } from '../utils/math.ts'
import { PLAYER_RADIUS } from '../utils/constants.ts'
import * as Audio from '../audio/AudioEngine.ts'

export function initHitDetection(): void {
  on('player:beat', () => {
    const player = getPlayer()
    const enemies = getEnemies()
    const ringRadius = getEffectiveRadius(player) * getRingExpansion(player.attackTimer)
    let hitAny = false
    for (const enemy of enemies) {
      if (!enemy.alive) continue
      const dist = distance(
        { x: player.x, y: player.y },
        { x: enemy.x, y: enemy.y }
      )
      if (Math.abs(dist - ringRadius) < enemy.radius) {
        damageEnemy(enemy, player.damage)
        hitAny = true
      }
    }
    if (hitAny) {
      Audio.playHit()
    } else {
      Audio.playMiss()
    }
  })

  on('enemy:beat', (enemy) => {
    const player = getPlayer()
    if (!enemy.alive) return
    Audio.playEnemyBeatTick(enemy.typeName)

    const ringRadius = enemy.ring.radius * getRingExpansion(enemy.attackTimer)
    const dist = distance(
      { x: player.x, y: player.y },
      { x: enemy.x, y: enemy.y }
    )
    if (Math.abs(dist - ringRadius) < PLAYER_RADIUS) {
      player.hp -= enemy.damage
      player.hitFlash = 0.15
      Audio.playPlayerHit()
      if (player.hp <= 0) player.hp = 0
    }
  })

  on('enemy:killed', (_enemy) => {
    Audio.playKill()
  })
}

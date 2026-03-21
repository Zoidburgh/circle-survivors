import { start } from './core/GameLoop.ts'
import * as Input from './game/InputManager.ts'
import * as Renderer from './render/Renderer.ts'
import * as Audio from './audio/AudioEngine.ts'
import { createEnemy } from './entities/Enemy.ts'
import { ENEMY_TYPES } from './entities/EnemyTypes.ts'
import { getPlayer, getEnemies } from './core/GameState.ts'
import { update, render } from './core/GameManager.ts'
import { initHitDetection } from './game/HitDetection.ts'
import { initDesigner } from './game/EnemyDesigner.ts'
import { setPattern } from './audio/PatternClock.ts'
import { SONG_DEFAULT } from './audio/SongPatterns.ts'

// ── Init ──
const canvas = document.getElementById('game') as HTMLCanvasElement
Input.init(canvas)
Renderer.init(canvas)
Audio.init()
initHitDetection()
setPattern(SONG_DEFAULT)
initDesigner()

// ── Spawn enemies with number keys ──
window.addEventListener('keydown', e => {
  const player = getPlayer()
  const enemies = getEnemies()

  if (e.key === '0') {
    for (let i = 0; i < 100; i++) {
      const type = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)]!
      const angle = Math.random() * Math.PI * 2
      const dist = 200 + Math.random() * 500
      enemies.push(createEnemy(
        player.x + Math.cos(angle) * dist,
        player.y + Math.sin(angle) * dist,
        type
      ))
    }
    return
  }
  const type = ENEMY_TYPES.find(t => t.key === e.key)
  if (type) {
    const angle = Math.random() * Math.PI * 2
    const dist = 300 + Math.random() * 150
    enemies.push(createEnemy(
      player.x + Math.cos(angle) * dist,
      player.y + Math.sin(angle) * dist,
      type
    ))
  }
})

// ── Start game loop ──
start(update, render)

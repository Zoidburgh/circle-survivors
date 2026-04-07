import { start } from './core/GameLoop.ts'
import * as Input from './game/InputManager.ts'
import * as Renderer from './render/Renderer.ts'
import { getSpawnPanelClick } from './render/Renderer.ts'
import * as Audio from './audio/AudioEngine.ts'
import { createEnemy } from './entities/Enemy.ts'
import { ENEMY_TYPES } from './entities/EnemyTypes.ts'
import { getPlayer, getEnemies, getPhase } from './core/GameState.ts'
import { update, render } from './core/GameManager.ts'
import { initHitDetection } from './game/HitDetection.ts'
import { initDesigner } from './game/EnemyDesigner.ts'
import { setPattern } from './audio/PatternClock.ts'
import { SONG_DEFAULT } from './audio/SongPatterns.ts'
import { getSpawnPos } from './game/Arena.ts'
import { spawnOrb } from './entities/XPOrb.ts'
import { handleUpgradeClick, handleUpgradeHover } from './game/UpgradeScreen.ts'

// ── Init ──
const canvas = document.getElementById('game') as HTMLCanvasElement
Input.init(canvas)
Renderer.init(canvas)
Audio.init()
initHitDetection()
setPattern(SONG_DEFAULT)
initDesigner()

// ── Spawn enemies ──
function spawnEnemy(type: typeof ENEMY_TYPES[number]): void {
  const player = getPlayer()
  const pos = getSpawnPos(player.x, player.y)
  getEnemies().push(createEnemy(pos.x, pos.y, type))
}

window.addEventListener('keydown', e => {
  // F1-F5: switch beat presets
  if (e.key.startsWith('F') && e.key.length <= 3) {
    const num = parseInt(e.key.slice(1))
    if (num >= 1 && num <= 11 && num !== 12) {
      Audio.switchBeat(num - 1)
      return
    }
  }
  if (e.key === '9') {
    const player = getPlayer()
    for (let i = 0; i < 50; i++) {
      const pos = getSpawnPos(player.x, player.y, 50)
      spawnOrb(pos.x, pos.y, 1, 'hp')
    }
    return
  }
  if (e.key === '0') {
    for (let i = 0; i < 10; i++) {
      const type = ENEMY_TYPES[Math.floor(Math.random() * ENEMY_TYPES.length)]!
      spawnEnemy(type)
    }
    return
  }
  const type = ENEMY_TYPES.find(t => t.key === e.key)
  if (type) {
    console.log(`Spawning: ${type.name} (key=${type.key}, r=${type.radius}, hp=${type.hp}, totem=${type.totemSpawn || 'none'})`)
    spawnEnemy(type)
  }
})

canvas.addEventListener('click', e => {
  // Upgrade screen takes priority
  if (getPhase() === 'upgrading') {
    handleUpgradeClick(e.clientX, e.clientY, canvas.width, canvas.height)
    return
  }
  const idx = getSpawnPanelClick(e.clientX, e.clientY)
  if (idx >= 0 && idx < ENEMY_TYPES.length) {
    spawnEnemy(ENEMY_TYPES[idx]!)
  }
})

canvas.addEventListener('mousemove', e => {
  handleUpgradeHover(e.clientX, e.clientY, canvas.width, canvas.height)
})

// ── Start game loop ──
start(update, render)

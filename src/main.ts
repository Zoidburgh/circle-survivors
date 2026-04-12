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
import { handleShopClick, handleShopHover, closeShop } from './game/ShopScreen.ts'
import { createNodeGroup, resetRitualNodes } from './game/RitualNodes.ts'
import { ARENA_W, ARENA_H } from './game/Arena.ts'

let debugNodeType = 0  // 0 = triangle shop, 1 = pentagon star

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
  if (e.key === 'v') {
    // Debug: spawn a test summoner enemy
    const player = getPlayer()
    const pos = getSpawnPos(player.x, player.y, 200)
    const summoner = createEnemy(pos.x, pos.y, {
      name: 'Summoner',
      color: '#FFD740',
      hp: 20,
      moveSpeed: 0,
      radius: 80,
      ringRadius: 0,
      key: '',
      role: 'bass',
      movePattern: 'immovable',
      summon: true,
      summonNodes: 3,
      summonPhases: [
        { spawns: [{ enemyName: 'Enemy3', count: 2 }] },
        { spawns: [{ enemyName: 'Enemy3', count: 3 }] },
      ],
      dropType: 'none',
    })
    getEnemies().push(summoner)
    console.log('Spawned: summoner')
    return
  }
  if (e.key === '9') {
    const player = getPlayer()
    for (let i = 0; i < 50; i++) {
      const pos = getSpawnPos(player.x, player.y, 50)
      spawnOrb(pos.x, pos.y, 1, 'hp')
    }
    return
  }
  if (e.key === 'b') {
    resetRitualNodes()
    const cx = ARENA_W / 2, cy = ARENA_H / 2

    if (debugNodeType === 0) {
      // Triangle shop
      const spread = 90
      createNodeGroup('shop', [
        { x: cx, y: cy - spread },
        { x: cx - spread * 0.87, y: cy + spread * 0.5 },
        { x: cx + spread * 0.87, y: cy + spread * 0.5 },
      ])
      console.log('Spawned: triangle shop')
    } else {
      // Pentagon star — random star pattern (connect every 2nd point)
      const spread = 130
      const baseAngle = -Math.PI / 2 + Math.random() * Math.PI * 2
      const points: { x: number; y: number }[] = []
      // Place 5 points in a circle
      for (let i = 0; i < 5; i++) {
        const a = baseAngle + (i / 5) * Math.PI * 2
        points.push({ x: cx + Math.cos(a) * spread, y: cy + Math.sin(a) * spread })
      }
      // Star order: skip every other point (0, 2, 4, 1, 3)
      const starOrder = [0, 2, 4, 1, 3]
      const starPoints = starOrder.map(i => points[i]!)
      createNodeGroup('spawn', starPoints)
      console.log('Spawned: pentagon star')
    }

    debugNodeType = (debugNodeType + 1) % 2
    return
  }
  if (e.key === 'Escape' && getPhase() === 'shopping') {
    closeShop()
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
  if (getPhase() === 'shopping') {
    handleShopClick(e.clientX, e.clientY, canvas.width, canvas.height)
    return
  }
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
  handleShopHover(e.clientX, e.clientY, canvas.width, canvas.height)
})

// ── Start game loop ──
start(update, render)

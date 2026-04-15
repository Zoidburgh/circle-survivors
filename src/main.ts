import { start } from './core/GameLoop.ts'
import * as Input from './game/InputManager.ts'
import * as Renderer from './render/Renderer.ts'
import { getSpawnPanelClick } from './render/Renderer.ts'
import * as Audio from './audio/AudioEngine.ts'
import { createEnemy } from './entities/Enemy.ts'
import { ENEMY_TYPES } from './entities/EnemyTypes.ts'
import { getPlayer, getEnemies, getPhase, setPhase, isRunComplete, resetGameState, getRunFinalTime } from './core/GameState.ts'
import { update, render } from './core/GameManager.ts'
import { initHitDetection } from './game/HitDetection.ts'
import { initDesigner, challengeCanvasClick, challengeCanvasMouseMove, onStartChallenge } from './game/EnemyDesigner.ts'
import { handleChallengeSelectClick, handleChallengeSelectHover, getNameEntryText, setNameEntryText, resetNameEntry, scrollVictoryLeaderboard, handleVictoryScrollDragStart, handleVictoryScrollDrag, handleVictoryScrollDragEnd, setLastSubmittedName, setLastSubmittedTime } from './render/Renderer.ts'
import { submitScore, isNameClean } from './game/HighScores.ts'
import type { Challenge } from './game/ChallengeBuilder.ts'
import { setArenaShape } from './game/Arena.ts'
import { setPattern, getPattern } from './audio/PatternClock.ts'
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
import { loadScores, setLeaderboardUrl } from './game/HighScores.ts'
initHitDetection()
initDesigner()
loadScores()
setLeaderboardUrl('https://beatback-leaderboard.pohling777.workers.dev')

let lastChallenge: Challenge | null = null

import { setActiveChallenge, getActiveChallenge } from './game/ChallengeBuilder.ts'

function launchChallenge(ch: Challenge): void {
  lastChallenge = ch
  setActiveChallenge(ch)
  ensureAudio()
  Audio.switchBeat(0)
  resetGameState()
  setArenaShape(ch.arenaShape as any)
  console.log('Launch challenge:', ch.name, 'enemies:', ch.enemies.map(e => e.typeName), 'ENEMY_TYPES:', ENEMY_TYPES.map(t => t.name))
  for (const ce of ch.enemies) {
    const type = ENEMY_TYPES.find(t => t.name === ce.typeName)
    if (type) {
      getEnemies().push(createEnemy(ce.x, ce.y, type))
    } else {
      console.warn('Type not found:', ce.typeName)
    }
  }
  setPhase('playing')
}

function restartChallenge(): void {
  if (!lastChallenge) return
  resetGameState()
  setArenaShape(lastChallenge.arenaShape as any)
  for (const ce of lastChallenge.enemies) {
    const type = ENEMY_TYPES.find(t => t.name === ce.typeName)
    if (type) getEnemies().push(createEnemy(ce.x, ce.y, type))
  }
  setPhase('playing')
}

// Challenge start handler
onStartChallenge((ch: Challenge) => {
  lastChallenge = ch
  ensureAudio()
  Audio.switchBeat(0)
  resetGameState()
  setArenaShape(ch.arenaShape as any)
  // Spawn all challenge enemies
  console.log('Starting challenge:', ch.name, 'enemies:', ch.enemies.length, 'types available:', ENEMY_TYPES.map(t => t.name))
  for (const ce of ch.enemies) {
    const type = ENEMY_TYPES.find(t => t.name === ce.typeName)
    if (type) {
      getEnemies().push(createEnemy(ce.x, ce.y, type))
    } else {
      console.warn('Challenge enemy type not found:', ce.typeName)
    }
  }
  console.log('Spawned enemies:', getEnemies().length)
  setPhase('playing')
})

// ── Spawn enemies ──
function spawnEnemy(type: typeof ENEMY_TYPES[number]): void {
  const player = getPlayer()
  const pos = getSpawnPos(player.x, player.y)
  getEnemies().push(createEnemy(pos.x, pos.y, type))
}

let audioStarted = false
function ensureAudio(): void {
  if (audioStarted) return
  audioStarted = true
  Audio.init()
  // Only set default pattern if designer hasn't already set one
  if (!getPattern()) setPattern(SONG_DEFAULT)
}

function startGame(): void {
  if (getPhase() !== 'title') return
  ensureAudio()
  Audio.switchBeat(0)
  setPhase('challenge_select')
}

window.addEventListener('keydown', e => {
  if (getPhase() === 'title') {
    if (!audioStarted) {
      ensureAudio()
      Audio.switchBeat(0)
    }
    if (e.key === ' ' || e.key === 'Enter') startGame()
    return
  }
  // Name entry
  if (getPhase() === 'entering_name') {
    if (e.key === 'Enter') {
      const name = (getNameEntryText().trim() || 'Player').slice(0, 16)
      if (!isNameClean(name)) {
        setNameEntryText('')  // clear and let them try again
        return
      }
      const ch = getActiveChallenge()
      const scoreTime = Math.ceil(getRunFinalTime())
      if (ch) submitScore(ch.name, scoreTime, name)
      setLastSubmittedName(name)
      setLastSubmittedTime(scoreTime)
      resetNameEntry()
      setPhase('playing')
    } else if (e.key === 'Backspace') {
      setNameEntryText(getNameEntryText().slice(0, -1))
    } else if (e.key.length === 1 && getNameEntryText().length < 16) {
      setNameEntryText(getNameEntryText() + e.key)
    }
    e.preventDefault()
    return
  }
  // Pause toggle
  if (getPhase() === 'playing' && e.key === 'Escape') {
    setPhase('paused')
    return
  }
  if (getPhase() === 'paused') {
    if (e.key === 'Escape' || e.key === ' ') {
      setPhase('playing')
    } else if (e.key === 'r' || e.key === 'R') {
      restartChallenge()
    }
    return
  }
  // Challenge select — back to title
  if (getPhase() === 'challenge_select' && e.key === 'Escape') {
    setPhase('title')
    return
  }
  // Victory
  if (isRunComplete()) {
    if (e.key === 'r' || e.key === 'R') {
      restartChallenge()
    } else if (e.key === ' ' || e.key === 'Enter' || e.key === 'Escape') {
      resetGameState()
      setPhase('challenge_select')
    }
    return
  }
  // Death screen — no Space (too easy to accidentally press while dashing)
  if (getPhase() === 'dead') {
    if (e.key === 'r' || e.key === 'R') {
      restartChallenge()
    } else if (e.key === 'Escape') {
      resetGameState()
      setPhase('challenge_select')
    }
    return
  }
  // Fullscreen toggle — works in both dev and release
  if (e.key === 'F11') {
    e.preventDefault()
    if (document.fullscreenElement) document.exitFullscreen()
    else document.documentElement.requestFullscreen()
    return
  }
  if (!__DEV__) return  // no debug keys in release
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
        { spawns: [{ enemyName: 'SHOP', count: 1 }] },
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

canvas.addEventListener('mousedown', e => {
  if (isRunComplete()) handleVictoryScrollDragStart(e.clientX, e.clientY)
})
canvas.addEventListener('mouseup', () => {
  handleVictoryScrollDragEnd()
})

canvas.addEventListener('click', e => {
  // Victory buttons
  if (isRunComplete() && getPhase() === 'playing') {
    const vBtnW = 180, vBtnH = 44, vBtnGap = 14
    const vBtnY = canvas.height - 80
    const retryX = canvas.width / 2 - vBtnW - vBtnGap / 2
    const menuX = canvas.width / 2 + vBtnGap / 2
    if (e.clientY >= vBtnY && e.clientY <= vBtnY + vBtnH) {
      if (e.clientX >= retryX && e.clientX <= retryX + vBtnW) {
        restartChallenge()
      } else if (e.clientX >= menuX && e.clientX <= menuX + vBtnW) {
        resetGameState()
        setPhase('challenge_select')
      }
    }
    return
  }
  if (getPhase() === 'paused') {
    const pcx = canvas.width / 2
    const pcy = canvas.height * 0.35
    const btnW = 180, btnH = 44, btnGap = 14
    const resumeY = pcy + 40
    const restartBtnY = resumeY + btnH + btnGap
    const menuBtnY = restartBtnY + btnH + btnGap
    if (e.clientX >= pcx - btnW / 2 && e.clientX <= pcx + btnW / 2) {
      if (e.clientY >= resumeY && e.clientY <= resumeY + btnH) {
        setPhase('playing')
      } else if (e.clientY >= restartBtnY && e.clientY <= restartBtnY + btnH) {
        restartChallenge()
      } else if (e.clientY >= menuBtnY && e.clientY <= menuBtnY + btnH) {
        resetGameState()
        setPhase('challenge_select')
      }
    }
    return
  }
  if (getPhase() === 'challenge_select') {
    const ch = handleChallengeSelectClick(e.clientX, e.clientY)
    if (ch) launchChallenge(ch)
    return
  }
  if (getPhase() === 'dead') {
    const dcx = canvas.width / 2
    const dcy = canvas.height * 0.38
    const btnW = 180, btnH = 44, btnGap = 16
    const restartY = dcy + 80
    const menuY = restartY + btnH + btnGap
    if (e.clientX >= dcx - btnW / 2 && e.clientX <= dcx + btnW / 2) {
      if (e.clientY >= restartY && e.clientY <= restartY + btnH) {
        restartChallenge()
      } else if (e.clientY >= menuY && e.clientY <= menuY + btnH) {
        resetGameState()
        setPhase('challenge_select')
      }
    }
    return
  }
  if (getPhase() === 'title') {
    // First click anywhere starts music
    if (!audioStarted) {
      ensureAudio()
      Audio.switchBeat(0)
    }
    // Check if click is on the Start button
    const btnW = 200, btnH = 50
    const btnX = canvas.width / 2 - btnW / 2
    const btnY = canvas.height * 0.52
    if (e.clientX >= btnX && e.clientX <= btnX + btnW && e.clientY >= btnY && e.clientY <= btnY + btnH) {
      startGame()
    }
    // Fullscreen button
    const fsW = 240, fsH = 50
    const fsY = btnY + btnH + 160
    const fsX = canvas.width / 2 - fsW / 2
    if (e.clientX >= fsX && e.clientX <= fsX + fsW && e.clientY >= fsY && e.clientY <= fsY + fsH) {
      if (document.fullscreenElement) document.exitFullscreen()
      else document.documentElement.requestFullscreen()
    }
    return
  }
  if (getPhase() === 'shopping') {
    handleShopClick(e.clientX, e.clientY, canvas.width, canvas.height)
    return
  }
  if (getPhase() === 'upgrading') {
    handleUpgradeClick(e.clientX, e.clientY, canvas.width, canvas.height)
    return
  }
  if (__DEV__) {
    // Challenge builder placement
    if (challengeCanvasClick?.(e.clientX, e.clientY)) return
    const idx = getSpawnPanelClick(e.clientX, e.clientY)
    if (idx >= 0 && idx < ENEMY_TYPES.length) {
      spawnEnemy(ENEMY_TYPES[idx]!)
    }
  }
})

canvas.addEventListener('mousemove', e => {
  handleVictoryScrollDrag(e.clientY)
  if (getPhase() === 'challenge_select') {
    handleChallengeSelectHover(e.clientX, e.clientY)
    return
  }
  handleUpgradeHover(e.clientX, e.clientY, canvas.width, canvas.height)
  handleShopHover(e.clientX, e.clientY, canvas.width, canvas.height)
  challengeCanvasMouseMove?.(e.clientX, e.clientY)
})

canvas.addEventListener('wheel', e => {
  if (isRunComplete()) {
    scrollVictoryLeaderboard(e.deltaY * 0.5)
    e.preventDefault()
  }
}, { passive: false })

// ── Start game loop ──
start(update, render)

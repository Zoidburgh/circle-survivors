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
import { handleChallengeSelectClick, handleChallengeSelectHover, getNameEntryText, setNameEntryText, resetNameEntry, scrollVictoryLeaderboard, handleVictoryScrollDragStart, handleVictoryScrollDrag, handleVictoryScrollDragEnd, setLastSubmittedName, setLastSubmittedTime, startVolumeDrag, updateVolumeDrag, stopVolumeDrag, showControlsHint, updatePauseMouse, screenToCanvas, dismissAddToHomeMessage, touchScrollStart, touchScrollMove, touchScrollEnd } from './render/Renderer.ts'
import { setVolume } from './audio/AudioEngine.ts'
import { submitScore, isNameClean, fetchOnlineScores } from './game/HighScores.ts'
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

// ── Fullscreen helper — works on desktop, shows guidance on iOS ──
function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {
      Renderer.showAddToHomeMessage()
    })
  } else {
    Renderer.showAddToHomeMessage()
  }
}

// ── Init ──
const canvas = document.getElementById('game') as HTMLCanvasElement
const nameInput = document.getElementById('name-input') as HTMLInputElement
Input.init(canvas)
Renderer.init(canvas)

// Hidden input for mobile keyboard — sync with game name entry
let wasEnteringName = false
function submitNameEntry(): void {
  if (getPhase() !== 'entering_name') return
  const text = getNameEntryText() || nameInput.value
  const name = (text.trim() || 'Player').slice(0, 16)
  if (!isNameClean(name)) {
    nameInput.value = ''
    setNameEntryText('')
    return
  }
  const ch = getActiveChallenge()
  const scoreTime = Math.ceil(getRunFinalTime())
  if (ch) submitScore(ch.name, scoreTime, name)
  setLastSubmittedName(name)
  setLastSubmittedTime(scoreTime)
  resetNameEntry()
  nameInput.blur()
  nameInput.style.pointerEvents = 'none'
  nameInput.value = ''
  setPhase('playing')
}

nameInput.addEventListener('input', () => {
  setNameEntryText(nameInput.value.slice(0, 16))
})
nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault()
    submitNameEntry()
  }
})
import { loadScores, setLeaderboardUrl } from './game/HighScores.ts'
initHitDetection()
initDesigner()
loadScores()
setLeaderboardUrl('https://beatback-leaderboard.pohling777.workers.dev')

let lastChallenge: Challenge | null = null

import { setActiveChallenge, getActiveChallenge, getChallenges } from './game/ChallengeBuilder.ts'

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
  showControlsHint()
  Audio.startShieldFuseBurn(getPlayer().shieldRechargeTime)
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
  showControlsHint()
  Audio.startShieldFuseBurn(getPlayer().shieldRechargeTime)
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
  showControlsHint()
  Audio.startShieldFuseBurn(getPlayer().shieldRechargeTime)
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
  // Fetch global scores for all challenges
  for (const ch of getChallenges()) fetchOnlineScores(ch.name)
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
    Input.clearKeys()
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
    toggleFullscreen()
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

canvas.addEventListener('pointerdown', e => {
  const p = screenToCanvas(e.clientX, e.clientY)
  if (e.pointerType === 'touch') Input.notifyTouchInput()
  dismissAddToHomeMessage()
  if (isRunComplete()) {
    handleVictoryScrollDragStart(p.x, p.y)
    if (e.pointerType === 'touch') touchScrollStart(p.y)
  }
  if (getPhase() === 'title' || getPhase() === 'paused') startVolumeDrag(p.x, p.y)

  // Touch tap handling — fires for all phases on touch devices
  if (e.pointerType === 'touch') {
    if (getPhase() === 'playing' && !isRunComplete()) {
      // Touch pause button — top-left 78x78
      if (p.x <= 95 && p.y <= 95) {
        Input.clearKeys()
        setPhase('paused')
        return
      }
      if (Input.getJoystickState().active) {
        Input.triggerTouchDash()
      } else {
        canvas.setPointerCapture(e.pointerId)
        Input.touchJoystickStart(e.pointerId, p.x, p.y)
      }
    } else {
      // Name entry — focus hidden input on tap to trigger mobile keyboard
      if (getPhase() === 'entering_name') {
        nameInput.value = getNameEntryText()
        nameInput.style.pointerEvents = 'auto'
        nameInput.focus()
      }
      // Non-playing phases — simulate click for menu buttons
      canvas.dispatchEvent(new MouseEvent('click', { clientX: e.clientX, clientY: e.clientY }))
    }
  }
})
canvas.addEventListener('pointerup', e => {
  handleVictoryScrollDragEnd()
  stopVolumeDrag()
  if (e.pointerId === Input.getJoystickPointerId()) {
    Input.touchJoystickEnd()
    canvas.releasePointerCapture(e.pointerId)
  }
  touchScrollEnd()
})
canvas.addEventListener('pointercancel', e => {
  if (e.pointerId === Input.getJoystickPointerId()) {
    Input.touchJoystickEnd()
  }
  touchScrollEnd()
})

canvas.addEventListener('click', e => {
  const c = screenToCanvas(e.clientX, e.clientY)
  // Name entry submit button — handles both compact and full layout
  if (getPhase() === 'entering_name') {
    const ncx = canvas.width / 2
    const compact = canvas.height < 800
    let subW: number, subH: number, subX: number, subY: number
    if (compact) {
      // Compact: VICTORY(40) + time(40) + label(20) + box(48+12) = cy starts at 40+40+40+20=140, box ends 140+48=188, sub at 200
      subW = 160; subH = 42
      subX = ncx - subW / 2
      subY = 200
    } else {
      const ncy = canvas.height * 0.2
      const boxY = ncy + 245
      subW = 200; subH = 50
      subX = ncx - subW / 2
      subY = boxY + 60 + 16
    }
    if (c.x >= subX && c.x <= subX + subW && c.y >= subY && c.y <= subY + subH) {
      submitNameEntry()
    }
    return
  }
  // Victory buttons
  if (isRunComplete() && getPhase() === 'playing') {
    const vBtnW = 180, vBtnH = 44, vBtnGap = 14
    const vBtnY = canvas.height - 80
    const retryX = canvas.width / 2 - vBtnW - vBtnGap / 2
    const menuX = canvas.width / 2 + vBtnGap / 2
    if (c.y >= vBtnY && c.y <= vBtnY + vBtnH) {
      if (c.x >= retryX && c.x <= retryX + vBtnW) {
        restartChallenge()
      } else if (c.x >= menuX && c.x <= menuX + vBtnW) {
        resetGameState()
        setPhase('challenge_select')
      }
    }
    return
  }
  if (getPhase() === 'paused') {
    const pcx = canvas.width / 2
    const btnW = 280, btnH = 64, btnGap = 18
    const titleH = 60, volH = 60, panelPad = 30
    const panelContentH = titleH + (btnH + btnGap) * 4 + volH + panelPad
    const panelY = (canvas.height - panelContentH) / 2
    const titleY = panelY + 45
    const resumeY = titleY + 30
    const restartBtnY = resumeY + btnH + btnGap
    const menuBtnY = restartBtnY + btnH + btnGap
    const fsBtnY = menuBtnY + btnH + btnGap
    if (c.x >= pcx - btnW / 2 && c.x <= pcx + btnW / 2) {
      if (c.y >= resumeY && c.y <= resumeY + btnH) {
        setPhase('playing')
      } else if (c.y >= restartBtnY && c.y <= restartBtnY + btnH) {
        restartChallenge()
      } else if (c.y >= menuBtnY && c.y <= menuBtnY + btnH) {
        resetGameState()
        setPhase('challenge_select')
      } else if (c.y >= fsBtnY && c.y <= fsBtnY + btnH) {
        toggleFullscreen()
      }
    }
    return
  }
  if (getPhase() === 'challenge_select') {
    // Back button — top-left
    if (c.x <= 180 && c.y <= 74) {
      setPhase('title')
      return
    }
    const ch = handleChallengeSelectClick(c.x, c.y)
    if (ch) launchChallenge(ch)
    return
  }
  if (getPhase() === 'dead') {
    const dcx = canvas.width / 2
    const btnW = 220, btnH = 52, btnGap = 16
    const btnBaseY = canvas.height - 180
    const retryX = dcx - btnW - btnGap / 2
    const menuX = dcx + btnGap / 2
    if (c.y >= btnBaseY && c.y <= btnBaseY + btnH) {
      if (c.x >= retryX && c.x <= retryX + btnW) {
        restartChallenge()
      } else if (c.x >= menuX && c.x <= menuX + btnW) {
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
    const btnW = 200, btnH = 50
    const btnX = canvas.width / 2 - btnW / 2
    const btnY = canvas.height * 0.52
    if (c.x >= btnX && c.x <= btnX + btnW && c.y >= btnY && c.y <= btnY + btnH) {
      startGame()
    }
    const fsW = 240, fsH = 50
    const fsY = btnY + btnH + 160
    const fsX = canvas.width / 2 - fsW / 2
    if (c.x >= fsX && c.x <= fsX + fsW && c.y >= fsY && c.y <= fsY + fsH) {
      toggleFullscreen()
    }
    return
  }
  if (getPhase() === 'shopping') {
    handleShopClick(c.x, c.y, canvas.width, canvas.height)
    return
  }
  if (getPhase() === 'upgrading') {
    handleUpgradeClick(c.x, c.y, canvas.width, canvas.height)
    return
  }
  if (__DEV__) {
    if (challengeCanvasClick?.(c.x, c.y)) return
    const idx = getSpawnPanelClick(c.x, c.y)
    if (idx >= 0 && idx < ENEMY_TYPES.length) {
      spawnEnemy(ENEMY_TYPES[idx]!)
    }
  }
})

canvas.addEventListener('pointermove', e => {
  const p = screenToCanvas(e.clientX, e.clientY)
  if (e.pointerId === Input.getJoystickPointerId()) {
    Input.touchJoystickMove(p.x, p.y)
  }
  updatePauseMouse(p.x, p.y)
  handleVictoryScrollDrag(p.y)
  touchScrollMove(p.y)
  const vol = updateVolumeDrag(p.x)
  if (vol !== null) setVolume(vol)
  if (getPhase() === 'challenge_select') {
    handleChallengeSelectHover(p.x, p.y)
    return
  }
  handleUpgradeHover(p.x, p.y, canvas.width, canvas.height)
  handleShopHover(p.x, p.y, canvas.width, canvas.height)
  challengeCanvasMouseMove?.(p.x, p.y)
})

canvas.addEventListener('wheel', e => {
  if (isRunComplete()) {
    scrollVictoryLeaderboard(e.deltaY * 0.5)
    e.preventDefault()
  }
}, { passive: false })

// Auto-pause on focus loss — prevents AudioContext desync
window.addEventListener('blur', () => {
  if (getPhase() === 'playing') {
    Input.clearKeys()
    setPhase('paused')
  }
})
window.addEventListener('focus', () => {
  // Resume AudioContext if it was suspended
  Audio.ensureAudioContext()
})

// Auto-pause when exiting fullscreen during gameplay
function onFullscreenExit(): void {
  if (!document.fullscreenElement && getPhase() === 'playing') {
    Input.clearKeys()
    setPhase('paused')
  }
}
document.addEventListener('fullscreenchange', onFullscreenExit)
document.addEventListener('webkitfullscreenchange', onFullscreenExit)
// Fallback: detect resize that looks like a fullscreen exit (itch.io iframe)
let wasFullscreenSize = false
window.addEventListener('resize', () => {
  const isFullSize = window.innerWidth === screen.width && window.innerHeight === screen.height
  if (wasFullscreenSize && !isFullSize && getPhase() === 'playing') {
    Input.clearKeys()
    setPhase('paused')
  }
  wasFullscreenSize = isFullSize
})

// ── Name entry input focus management ──
function checkNameInput(): void {
  const entering = getPhase() === 'entering_name'
  if (entering && !wasEnteringName) {
    nameInput.value = getNameEntryText()
    nameInput.style.pointerEvents = 'auto'
    nameInput.focus()
  } else if (!entering && wasEnteringName) {
    nameInput.blur()
    nameInput.style.pointerEvents = 'none'
    nameInput.value = ''
  } else if (entering) {
    // Keep synced — keyboard handler may have changed it
    if (nameInput.value !== getNameEntryText()) {
      nameInput.value = getNameEntryText()
    }
  }
  wasEnteringName = entering
  requestAnimationFrame(checkNameInput)
}
requestAnimationFrame(checkNameInput)

// ── Start game loop ──
start(update, render)

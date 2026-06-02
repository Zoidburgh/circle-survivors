import { start } from './core/GameLoop.ts'
import * as Input from './game/InputManager.ts'
import * as Renderer from './render/Renderer.ts'
import { getSpawnPanelClick } from './render/Renderer.ts'
import * as Audio from './audio/AudioEngine.ts'
import { createEnemy } from './entities/Enemy.ts'
import { ENEMY_TYPES } from './entities/EnemyTypes.ts'
import { getPlayer, getEnemies, getPhase, setPhase, isRunComplete, resetGameState, getRunFinalTime, enterDesigner, exitDesigner, getDesignerReturnPhase, setDesignerPrevArenaShape, getDesignerPrevArenaShape, setInDesignerTestPlay, isInDesignerTestPlay, getCamera, getPausedReturnPhase, setPausedReturnPhase } from './core/GameState.ts'
import { update, render, clearDesignerEphemerals } from './core/GameManager.ts'
import { initHitDetection } from './game/HitDetection.ts'
import { initDesigner, challengeCanvasClick, challengeCanvasMouseMove, challengeCanvasMouseDown, challengeCanvasMouseUp, onStartChallenge, onTestPlay } from './game/EnemyDesigner.ts'
import { handleChallengeSelectClick, handleChallengeSelectHover, getNameEntryText, setNameEntryText, resetNameEntry, scrollVictoryLeaderboard, handleVictoryScrollDragStart, handleVictoryScrollDrag, handleVictoryScrollDragEnd, setLastSubmittedName, setLastSubmittedTime, startVolumeDrag, updateVolumeDrag, stopVolumeDrag, startZoomDrag, updateZoomDrag, stopZoomDrag, setCameraZoom, showControlsHint, updatePauseMouse, screenToCanvas, dismissAddToHomeMessage, touchScrollStart, touchScrollMove, touchScrollEnd, startIrisTransition, startIrisOpen, isIrisActive, cycleProTip, getCsSelectedIndex, setCsSelectedIndex, navigateChallenge, showToast, isPortalClick, resetVictoryScroll } from './render/Renderer.ts'
import { setVolume } from './audio/AudioEngine.ts'
import { submitScore, isNameClean, fetchOnlineScores } from './game/HighScores.ts'
import type { Challenge } from './game/ChallengeBuilder.ts'
import { setArenaShape, getArenaShape, clampToArena, setWalls } from './game/Arena.ts'
import type { ArenaShape } from './game/Arena.ts'
import { setPattern, getPattern } from './audio/PatternClock.ts'
import { SONG_DEFAULT } from './audio/SongPatterns.ts'
import { getSpawnPos, getPerimeterSpawnPos, findClearSpawnPos } from './game/Arena.ts'
import { spawnOrb } from './entities/XPOrb.ts'
import { handleUpgradeClick, handleUpgradeHover } from './game/UpgradeScreen.ts'
import { handleShopClick, handleShopHover, closeShop } from './game/ShopScreen.ts'
import { createNodeGroup, resetRitualNodes } from './game/RitualNodes.ts'
import { ARENA_W, ARENA_H } from './game/Arena.ts'

let debugNodeType = 0  // 0 = triangle shop, 1 = pentagon star

// ── Fullscreen helper — works on desktop, shows guidance on iOS ──
function toggleFullscreen(): void {
  Audio.playUIClick()
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
  if (!text.trim()) return  // must enter a name
  const name = text.trim().slice(0, 16)
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

import { setActiveChallenge, getActiveChallenge, getChallenges, getChallengeArena } from './game/ChallengeBuilder.ts'
import * as ChallengeBuilderMod from './game/ChallengeBuilder.ts'

function launchTestPlay(): void {
  setInDesignerTestPlay(true)
  clearDesignerEphemerals()
  ChallengeBuilderMod.exitPlaceMode()
  ChallengeBuilderMod.clearSelection()
  const placements = ChallengeBuilderMod.getPlacingEnemies()
  const arena = getChallengeArena()
  ensureAudio()
  resetGameState('playing')
  setArenaShape(arena as ArenaShape)
  for (const ce of placements) {
    const type = ENEMY_TYPES.find(t => t.name === ce.typeName)
    if (type) getEnemies().push(createEnemy(ce.x, ce.y, type))
  }
  Audio.startShieldFuseBurn(getPlayer().shieldRechargeTime)
}

function returnFromRun(): void {
  if (isInDesignerTestPlay()) {
    setInDesignerTestPlay(false)
    clearDesignerEphemerals()
    const prevReturn = getDesignerReturnPhase()
    resetGameState('designer')
    enterDesigner(prevReturn)
    setActiveChallenge(null)   // designer doesn't run a challenge — clear so toasts don't fire
    setArenaShape(getChallengeArena() as ArenaShape)
    const p = getPlayer()
    const c = clampToArena(p.x, p.y, p.hitRadius)
    p.x = c.x; p.y = c.y
  } else {
    resetGameState()
    setPhase('challenge_select')
  }
}

function launchChallenge(ch: Challenge): void {
  if (lastChallenge?.name !== ch.name) challengeRetries = 0
  lastChallenge = ch
  setActiveChallenge(ch)
  ensureAudio()
  Audio.switchBeat(0)
  resetGameState()
  resetVictoryScroll()
  setArenaShape(ch.arenaShape as any)
  setWalls((ch.walls ?? []).map(w => ({ ...w })))
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
  showControlsHint(getActiveChallenge()?.name === 'Beginner Challenge')
  Audio.startShieldFuseBurn(getPlayer().shieldRechargeTime)
  // Challenge-specific intro toast
  if (ch.name === 'Beginner Challenge') {
    setTimeout(() => showToast("Welcome :) Don't die immediately.", { duration: 2.5, y: 0.14, size: 42, style: 'glow', glowWords: ['die'], glowColor: [255, 50, 50] }), 500)
  } else if (ch.name === 'Challenge 1') {
    setTimeout(() => showToast('You can figure this out.', { duration: 2.5, y: 0.14 }), 500)
  } else if (ch.name === 'Challenge 2') {
    setTimeout(() => showToast("This one's kinda tough.", { duration: 2.5, y: 0.14 }), 500)
  }
}

let beginnerRetries = 0
let nameEntryGrace = 0
let challengeRetries = 0

function restartChallenge(): void {
  if (!lastChallenge) return
  challengeRetries++
  resetGameState()
  setArenaShape(lastChallenge.arenaShape as any)
  setWalls((lastChallenge.walls ?? []).map(w => ({ ...w })))
  for (const ce of lastChallenge.enemies) {
    const type = ENEMY_TYPES.find(t => t.name === ce.typeName)
    if (type) getEnemies().push(createEnemy(ce.x, ce.y, type))
  }
  setPhase('playing')
  showControlsHint(getActiveChallenge()?.name === 'Beginner Challenge')
  startIrisOpen()
  Audio.playIrisOpen()
  Audio.startShieldFuseBurn(getPlayer().shieldRechargeTime)
  if (lastChallenge.name === 'Beginner Challenge') {
    beginnerRetries++
    if (beginnerRetries === 1) {
      setTimeout(() => showToast('This time do better.', { duration: 2, y: 0.14 }), 500)
    }
  }
  if (challengeRetries === 3) {
    setTimeout(() => showToast('Persistence is key. Apparently.', { duration: 2.5, y: 0.14 }), 500)
  }
}

// Challenge start handler
onTestPlay(() => launchTestPlay())

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
  showControlsHint(getActiveChallenge()?.name === 'Beginner Challenge')
  Audio.startShieldFuseBurn(getPlayer().shieldRechargeTime)
})

// ── Spawn enemies ──
function spawnEnemy(type: typeof ENEMY_TYPES[number]): void {
  const player = getPlayer()
  // Moderate ring spawn 500-700px from player (matches the workshop "Spawn-Test" strip).
  // Comfortable middle distance — not on top of the player, not all the way to the edge.
  const angle = Math.random() * Math.PI * 2
  const dist = 500 + Math.random() * 200
  const sx = player.x + Math.cos(angle) * dist
  const sy = player.y + Math.sin(angle) * dist
  const radius = (type as any).radius ?? 40
  const pos = findClearSpawnPos(sx, sy, radius, getEnemies(), player)
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
  Audio.playUIClick()
  Audio.switchBeat(0)
  setPhase('challenge_select')
  // Fetch global scores for all challenges
  for (const ch of getChallenges()) fetchOnlineScores(ch.name)
}

window.addEventListener('keydown', e => {
  // Designer scene toggle (L). Tab still toggles the panel UI separately.
  if (e.key === 'l' || e.key === 'L') {
    if (getPhase() === 'designer') {
      clearDesignerEphemerals()
      const prev = getDesignerPrevArenaShape()
      if (prev) setArenaShape(prev as ArenaShape)
      setDesignerPrevArenaShape(null)
      const p = getPlayer()
      const c = clampToArena(p.x, p.y, p.hitRadius)
      p.x = c.x; p.y = c.y
      const back = getDesignerReturnPhase()
      exitDesigner()
      setPhase(back)
      return
    }
    if (getPhase() !== 'playing' && getPhase() !== 'entering_name') {
      if (!audioStarted) { ensureAudio(); Audio.switchBeat(0) }
      setDesignerPrevArenaShape(getArenaShape())
      setArenaShape(getChallengeArena() as ArenaShape)
      const p = getPlayer()
      const c = clampToArena(p.x, p.y, p.hitRadius)
      p.x = c.x; p.y = c.y
      enterDesigner(getPhase())
      setActiveChallenge(null)   // designer doesn't run a challenge — clear so toasts don't fire
      return
    }
  }
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
    // Ignore keys briefly after entering name screen (prevents held WASD from spamming)
    if (nameEntryGrace > 0) { e.preventDefault(); return }
    // Ignore movement keys
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Tab'].includes(e.key)) {
      e.preventDefault()
      return
    }
    if (e.key === 'Enter') {
      submitNameEntry()
    } else if (e.key === 'Backspace') {
      setNameEntryText(getNameEntryText().slice(0, -1))
    } else if (e.key === 'Escape') {
      // skip — don't type it
    } else if (e.key.length === 1 && getNameEntryText().length < 16) {
      setNameEntryText(getNameEntryText() + e.key)
    }
    e.preventDefault()
    return
  }
  // Designer: Escape first clears any active placement/selection state. If nothing to
  // clear, falls through to the pause-toggle handler below so designer can open the pause
  // menu (volume/zoom sliders, fullscreen, menu).
  if (getPhase() === 'designer' && e.key === 'Escape') {
    let handled = false
    if (ChallengeBuilderMod.getSelectedPlacement() >= 0) {
      ChallengeBuilderMod.clearSelection()
      handled = true
    }
    if (ChallengeBuilderMod.isPlaceMode()) {
      ChallengeBuilderMod.exitPlaceMode()
      handled = true
    }
    if (handled) return
    // Otherwise fall through to pause-toggle
  }
  // Test Play: Escape cancels back to designer (skips pause)
  if (isInDesignerTestPlay() && getPhase() === 'playing' && e.key === 'Escape') {
    returnFromRun()
    return
  }
  // Pause toggle — from playing or designer. Records where to return on resume.
  if (getPhase() === 'playing' && e.key === 'Escape') {
    Input.clearKeys()
    setPausedReturnPhase('playing')
    setPhase('paused')
    return
  }
  if (getPhase() === 'designer' && e.key === 'Escape') {
    Input.clearKeys()
    setPausedReturnPhase('designer')
    setPhase('paused')
    return
  }
  if (getPhase() === 'paused') {
    if (e.key === 'Escape' || e.key === ' ') {
      Audio.ensureAudioContext()
      setPhase(getPausedReturnPhase())
    } else if (e.key === 'r' || e.key === 'R') {
      // Restart only makes sense from in-run pause; ignore in designer pause
      if (getPausedReturnPhase() === 'playing') restartChallenge()
    }
    return
  }
  // Challenge select — back to title
  if (getPhase() === 'challenge_select') {
    if (e.key === 'Escape') {
      setPhase('title')
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      const challenges = getChallenges()
      const ch = challenges[getCsSelectedIndex()]
      if (ch && !isIrisActive()) {
        Audio.playIrisClose()
        startIrisTransition(canvas.width / 2, canvas.height / 2, () => launchChallenge(ch))
      }
      return
    }
    if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') {
      if (navigateChallenge(-1)) Audio.playUIClick()
      return
    }
    if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') {
      if (navigateChallenge(1)) Audio.playUIClick()
      return
    }
    return
  }
  // Victory — but not if we just submitted name entry this frame
  if (isRunComplete() && getPhase() === 'playing') {
    if (e.key === 'r' || e.key === 'R') {
      restartChallenge()
    } else if (e.key === 'Escape') {
      returnFromRun()
    }
    // Don't let Space/Enter skip the victory leaderboard immediately
    return
  }
  // Death screen — no Space (too easy to accidentally press while dashing)
  if (getPhase() === 'dead') {
    if (e.key === 'r' || e.key === 'R') {
      restartChallenge()
    } else if (e.key === 'Escape') {
      returnFromRun()
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
  if (e.key === '`' || e.key === '~') {
    Renderer.toggleSpawnPanel()
    return
  }
  if (e.key === '\\') {
    Renderer.toggleDebugOverlay()
    return
  }
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
    const pos = getPerimeterSpawnPos(player.x, player.y, 300)
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
  // Designer wall drag: starts on pointer-down (not click) since walls are click-drag-release.
  // If the wall tool starts a drag here, suppress dash so the click doesn't double up.
  if (getPhase() === 'designer' && e.button === 0 && challengeCanvasMouseDown?.(p.x, p.y, e.shiftKey)) {
    Input.suppressLeftClick()
  }
  // Designer: suppress dash if this click is for placement/selection (so player still dashes
  // when clicking empty arena to test interactions with spawn-test enemies).
  if (getPhase() === 'designer' && e.button === 0) {
    if (ChallengeBuilderMod.isPlaceMode() || ChallengeBuilderMod.getSelectedPlacement() >= 0) {
      Input.suppressLeftClick()
    } else {
      // Hit test placements: if clicking on an existing ghost, suppress dash too
      const placements = ChallengeBuilderMod.getPlacingEnemies()
      const cam = getCamera()
      const wx = p.x + cam.x - canvas.width / 2
      const wy = p.y + cam.y - canvas.height / 2
      for (const pl of placements) {
        const type = ENEMY_TYPES.find(t => t.name === pl.typeName)
        const r = type?.radius ?? 40
        const dx = wx - pl.x
        const dy = wy - pl.y
        if (dx * dx + dy * dy < r * r) {
          Input.suppressLeftClick()
          break
        }
      }
    }
  }
  if (isRunComplete()) {
    handleVictoryScrollDragStart(p.x, p.y)
    if (e.pointerType === 'touch') touchScrollStart(p.y)
  }
  if (getPhase() === 'title' || getPhase() === 'paused' || getPhase() === 'challenge_select') {
    startVolumeDrag(p.x, p.y)
    startZoomDrag(p.x, p.y)
  }

  // Touch tap handling — fires for all phases on touch devices
  if (e.pointerType === 'touch') {
    if (getPhase() === 'playing' && !isRunComplete()) {
      // Touch pause button — top-left 78x78
      if (p.x <= 95 && p.y <= 95) {
        Input.clearKeys()
        setPausedReturnPhase('playing')
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
  stopZoomDrag()
  if (e.pointerId === Input.getJoystickPointerId()) {
    Input.touchJoystickEnd()
    canvas.releasePointerCapture(e.pointerId)
  }
  touchScrollEnd()
  // Designer wall drag — commit the in-progress wall (if any) regardless of where the
  // mouse-up landed, including outside the canvas.
  if (getPhase() === 'designer' && e.button === 0) challengeCanvasMouseUp?.()
})

// Designer: right-click on the canvas removes whichever item the cursor is over — enemy
// ghost first, then wall. Prevents the default browser context menu.
canvas.addEventListener('contextmenu', e => {
  if (getPhase() !== 'designer') return
  e.preventDefault()
  const p = screenToCanvas(e.clientX, e.clientY)
  ChallengeBuilderMod.deleteAtScreen(p.x, p.y)
})
canvas.addEventListener('pointercancel', e => {
  if (e.pointerId === Input.getJoystickPointerId()) {
    Input.touchJoystickEnd()
  }
  touchScrollEnd()
})

canvas.addEventListener('click', e => {
  const c = screenToCanvas(e.clientX, e.clientY)
  // Portal button — works on all screens
  if (isPortalClick(c.x, c.y)) {
    goToPortal()
    return
  }
  // Name entry submit button — handles both compact and full layout
  if (getPhase() === 'entering_name') {
    const ncx = canvas.width / 2
    const compact = canvas.height < 500  // match renderer
    let subW: number, subH: number, subX: number, subY: number
    if (compact) {
      // Compact: VICTORY(40) + time(40) + label(20) + box(48+12) = cy starts at 40+40+40+20=140, box ends 140+48=188, sub at 200
      subW = 160; subH = 42
      subX = ncx - subW / 2
      subY = 200
    } else {
      const ncy = canvas.height * 0.2
      const boxY = ncy + 200
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
    const vBtnW = 270, vBtnH = 66, vBtnGap = 20
    const vBtnY = canvas.height - 130
    const retryX = canvas.width / 2 - vBtnW - vBtnGap / 2
    const menuX = canvas.width / 2 + vBtnGap / 2
    if (c.y >= vBtnY && c.y <= vBtnY + vBtnH) {
      if (c.x >= retryX && c.x <= retryX + vBtnW) {
        Audio.playUIClick()
        restartChallenge()
      } else if (c.x >= menuX && c.x <= menuX + vBtnW) {
        Audio.playUIClick()
        returnFromRun()
      }
    }
    // Next challenge arrow — right side
    const challenges = getChallenges()
    const curIdx = challenges.findIndex(ch => ch.name === getActiveChallenge()?.name)
    if (curIdx >= 0 && curIdx < challenges.length - 1) {
      const arrowX = canvas.width - 300
      const arrowCY = canvas.height / 2 + 115
      if (c.x >= arrowX - 30 && c.x <= arrowX + 120 && c.y >= arrowCY - 100 && c.y <= arrowCY + 130) {
        Audio.playUIClick()
        const nextCh = challenges[curIdx + 1]!
        setCsSelectedIndex(curIdx + 1)  // update carousel position immediately
        resetGameState()
        launchChallenge(nextCh)
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
        Audio.playUIClick()
        Audio.ensureAudioContext()
        // Resume back to whichever phase opened the pause menu (playing or designer).
        setPhase(getPausedReturnPhase())
      } else if (c.y >= restartBtnY && c.y <= restartBtnY + btnH) {
        Audio.playUIClick()
        // Restart only meaningful from in-run pause. From designer pause, just resume.
        if (getPausedReturnPhase() === 'playing') restartChallenge()
        else setPhase(getPausedReturnPhase())
      } else if (c.y >= menuBtnY && c.y <= menuBtnY + btnH) {
        Audio.playUIClick()
        returnFromRun()
      } else if (c.y >= fsBtnY && c.y <= fsBtnY + btnH) {
        toggleFullscreen()
      }
    }
    return
  }
  if (getPhase() === 'challenge_select') {
    if (isIrisActive()) return  // block clicks during iris transition
    // Back button — top-left (260x72)
    if (c.x >= 20 && c.x <= 280 && c.y >= 18 && c.y <= 90) {
      Audio.playUIClick()
      setPhase('title')
      return
    }
    // Fullscreen toggle — under back button (260x52)
    if (c.x >= 20 && c.x <= 280 && c.y >= 102 && c.y <= 154) {
      Audio.playUIClick()
      toggleFullscreen()
      return
    }
    const ch = handleChallengeSelectClick(c.x, c.y)
    if (ch) {
      Audio.playIrisClose()
      startIrisTransition(c.x, c.y, () => launchChallenge(ch))
    }
    return
  }
  if (getPhase() === 'dead') {
    const dcx = canvas.width / 2
    const btnW = 220, btnH = 52, btnGap = 16
    const btnBaseY = canvas.height - 190
    const retryX = dcx - btnW - btnGap / 2
    const menuX = dcx + btnGap / 2
    if (c.y >= btnBaseY && c.y <= btnBaseY + btnH) {
      if (c.x >= retryX && c.x <= retryX + btnW) {
        Audio.playUIClick()
        restartChallenge()
      } else if (c.x >= menuX && c.x <= menuX + btnW) {
        Audio.playUIClick()
        returnFromRun()
      }
    }
    // Pro tip arrows — flanking the "PRO TIP:" heading
    const tipY = canvas.height - 238
    const headingY = tipY - 22
    const arrowSize = 43
    const headingHalfW = 110
    const leftArrowX = dcx - headingHalfW - arrowSize - 8
    const rightArrowX = dcx + headingHalfW + 8
    if (c.y >= headingY - 18 && c.y <= headingY + 10) {
      if (c.x >= leftArrowX && c.x <= leftArrowX + arrowSize) {
        Audio.playUIClick()
        cycleProTip(-1)
      } else if (c.x >= rightArrowX && c.x <= rightArrowX + arrowSize) {
        Audio.playUIClick()
        cycleProTip(1)
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
    const btnW = 230, btnH = 58
    const btnX = canvas.width / 2 - btnW / 2
    const btnY = canvas.height * 0.52 - 60
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
  const zoom = updateZoomDrag(p.x)
  if (zoom !== null) setCameraZoom(zoom)
  if (getPhase() === 'challenge_select') {
    handleChallengeSelectHover(p.x, p.y)
    return
  }
  handleUpgradeHover(p.x, p.y, canvas.width, canvas.height)
  handleShopHover(p.x, p.y, canvas.width, canvas.height)
  challengeCanvasMouseMove?.(p.x, p.y, e.shiftKey)
})

canvas.addEventListener('wheel', e => {
  if (isRunComplete()) {
    scrollVictoryLeaderboard(e.deltaY * 0.5)
    e.preventDefault()
  }
  // Designer: scroll-wheel rotates the prefab being placed OR the currently-selected
  // wall group around its bbox center. 5°/tick by default, Shift+scroll = 45°/tick.
  // Prefab takes priority since it's the more transient state.
  if (getPhase() === 'designer') {
    const step = (e.shiftKey ? Math.PI / 4 : Math.PI / 36) * Math.sign(e.deltaY)
    if (ChallengeBuilderMod.getPlacingPrefab()) {
      ChallengeBuilderMod.rotatePrefab(step)
      e.preventDefault()
    } else if (ChallengeBuilderMod.getSelectedWallIdx() >= 0) {
      ChallengeBuilderMod.rotateSelectedGroup(step)
      e.preventDefault()
    }
  }
}, { passive: false })

// Auto-pause on focus loss — prevents AudioContext desync
window.addEventListener('blur', () => {
  if (getPhase() === 'playing') {
    Input.clearKeys()
    setPausedReturnPhase('playing')
    setPhase('paused')
  }
})
window.addEventListener('focus', () => {
  Audio.ensureAudioContext()
})
// Mobile: visibilitychange is more reliable than blur/focus
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (getPhase() === 'playing') {
      Input.clearKeys()
      setPausedReturnPhase('playing')
      setPhase('paused')
    }
  } else {
    Audio.ensureAudioContext()
  }
})

// Auto-pause when exiting fullscreen during gameplay
function onFullscreenExit(): void {
  if (!document.fullscreenElement && getPhase() === 'playing') {
    Input.clearKeys()
    setPausedReturnPhase('playing')
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
    setPausedReturnPhase('playing')
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
    nameEntryGrace = 0.8  // 0.8s grace to ignore held keys
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
  if (nameEntryGrace > 0) nameEntryGrace -= 1 / 60  // approx 60fps
  wasEnteringName = entering
  requestAnimationFrame(checkNameInput)
}
requestAnimationFrame(checkNameInput)

// ── Portal — passive exit button always available ──
const urlParams = new URLSearchParams(window.location.search)
const isPortalEntry = urlParams.get('portal') === 'true'
const portalRef = urlParams.get('ref') || ''

export function goToPortal(): void {
  const name = encodeURIComponent(getNameEntryText() || 'Player')
  window.location.href = `https://vibejam.cc/portal/2026?username=${name}&ref=beatbackgame.com`
}

// ── Portal entry — drop straight into Beginner Challenge ──
if (isPortalEntry) {
  const challenges = getChallenges()
  const beginner = challenges.find(c => c.name === 'Beginner Challenge')
  if (beginner) {
    setTimeout(() => {
      ensureAudio()
      Audio.switchBeat(0)
      launchChallenge(beginner)
    }, 100)
  }
}

// ── Start game loop ──
start(update, render)

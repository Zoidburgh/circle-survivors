// Upgrade selection screen — freezes game, shows 3 choices

import { getPlayer, setPhase, checkLevelUp } from '../core/GameState.ts'
import { pickRandomUpgrades } from './UpgradeDefinitions.ts'
import type { UpgradeDef } from './UpgradeDefinitions.ts'
import { addUpgrade, applyModifiers } from './UpgradeManager.ts'

type ScreenState = 'hidden' | 'entering' | 'choosing' | 'selected' | 'exiting'

let state: ScreenState = 'hidden'
let stateTimer = 0
let choices: UpgradeDef[] = []
let hoveredIndex = -1
let selectedIndex = -1

// Entrance/exit timing
const ENTER_TIME = 0.4
const SELECT_HOLD = 0.4
const EXIT_TIME = 0.3

export function getUpgradeScreenState(): ScreenState { return state }

export function tryTriggerUpgrade(): void {
  if (state !== 'hidden') return
  if (checkLevelUp()) {
    choices = pickRandomUpgrades(3)
    hoveredIndex = -1
    selectedIndex = -1
    stateTimer = 0
    state = 'entering'
    setPhase('upgrading')
  }
}

export function updateUpgradeScreen(dt: number): void {
  if (state === 'hidden') return

  stateTimer += dt

  if (state === 'entering' && stateTimer >= ENTER_TIME) {
    state = 'choosing'
    stateTimer = 0
  }

  if (state === 'selected' && stateTimer >= SELECT_HOLD) {
    state = 'exiting'
    stateTimer = 0
  }

  if (state === 'exiting' && stateTimer >= EXIT_TIME) {
    state = 'hidden'
    stateTimer = 0
    setPhase('playing')
  }
}

export function handleUpgradeClick(mx: number, my: number, screenW: number, screenH: number): boolean {
  if (state !== 'choosing') return false

  const cardW = 160
  const cardH = 200
  const gap = 30
  const totalW = cardW * 3 + gap * 2
  const startX = (screenW - totalW) / 2
  const startY = screenH / 2 - cardH / 2

  for (let i = 0; i < 3; i++) {
    const cx = startX + i * (cardW + gap)
    if (mx >= cx && mx <= cx + cardW && my >= startY && my <= startY + cardH) {
      selectUpgrade(i)
      return true
    }
  }
  return false
}

export function handleUpgradeHover(mx: number, my: number, screenW: number, screenH: number): void {
  if (state !== 'choosing') { hoveredIndex = -1; return }

  const cardW = 160
  const cardH = 200
  const gap = 30
  const totalW = cardW * 3 + gap * 2
  const startX = (screenW - totalW) / 2
  const startY = screenH / 2 - cardH / 2

  hoveredIndex = -1
  for (let i = 0; i < 3; i++) {
    const cx = startX + i * (cardW + gap)
    if (mx >= cx && mx <= cx + cardW && my >= startY && my <= startY + cardH) {
      hoveredIndex = i
    }
  }
}

function selectUpgrade(index: number): void {
  if (index < 0 || index >= choices.length) return
  selectedIndex = index
  const choice = choices[index]!

  addUpgrade({
    id: choice.id + '_' + Date.now(),
    name: choice.name,
    description: choice.description,
    bonus: choice.bonus,
  })
  applyModifiers(getPlayer())

  state = 'selected'
  stateTimer = 0
}

export function drawUpgradeScreen(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
  if (state === 'hidden') return

  // Overlay alpha
  let overlayAlpha = 0.7
  if (state === 'entering') overlayAlpha = 0.7 * (stateTimer / ENTER_TIME)
  if (state === 'exiting') overlayAlpha = 0.7 * (1 - stateTimer / EXIT_TIME)

  // Dark overlay
  ctx.fillStyle = `rgba(0, 0, 0, ${overlayAlpha})`
  ctx.fillRect(0, 0, screenW, screenH)

  // Cards
  const cardW = 160
  const cardH = 200
  const gap = 30
  const totalW = cardW * 3 + gap * 2
  const startX = (screenW - totalW) / 2
  const baseY = screenH / 2 - cardH / 2

  // Title
  if (state !== 'exiting') {
    let titleAlpha = 1
    if (state === 'entering') titleAlpha = Math.min(stateTimer / (ENTER_TIME * 0.5), 1)
    ctx.globalAlpha = titleAlpha
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 28px monospace'
    ctx.textAlign = 'center'
    ctx.fillText('LEVEL UP', screenW / 2, baseY - 40)
    ctx.font = '14px monospace'
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillText('Choose an upgrade', screenW / 2, baseY - 15)
    ctx.textAlign = 'left'
    ctx.globalAlpha = 1
  }

  for (let i = 0; i < choices.length; i++) {
    const choice = choices[i]!
    const cx = startX + i * (cardW + gap)

    // Card entrance animation — stagger from bottom
    let cardY = baseY
    let cardAlpha = 1
    if (state === 'entering') {
      const delay = i * 0.08
      const t = Math.max(0, (stateTimer - delay) / (ENTER_TIME - delay))
      const ease = t < 1 ? 1 - Math.pow(1 - t, 3) : 1
      cardY = baseY + 80 * (1 - ease)
      cardAlpha = ease
    }
    if (state === 'exiting') {
      cardAlpha = 1 - stateTimer / EXIT_TIME
    }

    // Selected state
    if (state === 'selected' || state === 'exiting') {
      if (i !== selectedIndex) {
        cardAlpha *= 0.2
      }
    }

    const isHovered = hoveredIndex === i && state === 'choosing'
    const isSelected = selectedIndex === i

    ctx.globalAlpha = cardAlpha

    // Card background
    const scale = isHovered ? 1.05 : 1
    const scaledW = cardW * scale
    const scaledH = cardH * scale
    const scaledX = cx + (cardW - scaledW) / 2
    const scaledY = cardY + (cardH - scaledH) / 2

    // Glow behind card
    if (isHovered || isSelected) {
      const hr = parseInt(choice.color.slice(1, 3), 16)
      const hg = parseInt(choice.color.slice(3, 5), 16)
      const hb = parseInt(choice.color.slice(5, 7), 16)
      ctx.fillStyle = `rgba(${hr}, ${hg}, ${hb}, 0.15)`
      ctx.beginPath()
      ctx.arc(cx + cardW / 2, cardY + cardH / 2, cardW * 0.7, 0, Math.PI * 2)
      ctx.fill()
    }

    // Card body
    ctx.fillStyle = 'rgba(20, 15, 40, 0.9)'
    ctx.beginPath()
    roundRect(ctx, scaledX, scaledY, scaledW, scaledH, 12)
    ctx.fill()

    // Card border
    ctx.strokeStyle = isHovered || isSelected ? choice.color : 'rgba(255,255,255,0.15)'
    ctx.lineWidth = isHovered || isSelected ? 2 : 1
    ctx.beginPath()
    roundRect(ctx, scaledX, scaledY, scaledW, scaledH, 12)
    ctx.stroke()

    // Color circle at top
    const circleY = scaledY + 50
    ctx.beginPath()
    ctx.arc(cx + cardW / 2, circleY, 25, 0, Math.PI * 2)
    ctx.fillStyle = choice.color
    ctx.globalAlpha = cardAlpha * 0.3
    ctx.fill()
    ctx.globalAlpha = cardAlpha
    ctx.strokeStyle = choice.color
    ctx.lineWidth = 2
    ctx.stroke()

    // Name
    ctx.fillStyle = '#FFFFFF'
    ctx.font = 'bold 15px monospace'
    ctx.textAlign = 'center'
    ctx.fillText(choice.name, cx + cardW / 2, circleY + 45)

    // Stat
    ctx.fillStyle = choice.color
    ctx.font = 'bold 13px monospace'
    ctx.fillText(choice.description, cx + cardW / 2, circleY + 65)

    ctx.textAlign = 'left'
    ctx.globalAlpha = 1
  }
}

// XP bar at bottom of screen
export function drawXPBar(ctx: CanvasRenderingContext2D, screenW: number, screenH: number, currentXP: number, needed: number): void {
  const barH = 6
  const barW = screenW * 0.4
  const barX = (screenW - barW) / 2
  const barY = screenH - 20

  const fill = Math.min(currentXP / needed, 1)

  // Background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.fillRect(barX, barY, barW, barH)

  // Fill — color shifts as it fills
  const r = Math.floor(255 * (1 - fill) + 100 * fill)
  const g = Math.floor(255 * fill)
  const b = Math.floor(200 * (1 - fill) + 120 * fill)
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.7)`
  ctx.fillRect(barX, barY, barW * fill, barH)

  // Border
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)'
  ctx.lineWidth = 1
  ctx.strokeRect(barX, barY, barW, barH)
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
}

// Shop screen — browse and buy upgrades with XP

import { getPlayer, setPhase } from '../core/GameState.ts'
import { UPGRADE_POOL } from './UpgradeDefinitions.ts'
import type { UpgradeDef } from './UpgradeDefinitions.ts'
import { addUpgrade, applyModifiers, getUpgradeCount } from './UpgradeManager.ts'
import { SHOP_UPGRADE_COST } from '../utils/constants.ts'

type ShopState = 'hidden' | 'entering' | 'browsing' | 'exiting'

let state: ShopState = 'hidden'
let stateTimer = 0
let hoveredIndex = -1
let scrollOffset = 0

const ENTER_TIME = 0.3
const EXIT_TIME = 0.25

export function getShopState(): ShopState { return state }

export function openShop(): void {
  if (state !== 'hidden') return
  state = 'entering'
  stateTimer = 0
  hoveredIndex = -1
  scrollOffset = 0
  setPhase('shopping')
}

export function closeShop(): void {
  if (state === 'hidden' || state === 'exiting') return
  state = 'exiting'
  stateTimer = 0
}

export function updateShopScreen(dt: number): void {
  if (state === 'hidden') return
  stateTimer += dt

  if (state === 'entering' && stateTimer >= ENTER_TIME) {
    state = 'browsing'
    stateTimer = 0
  }

  if (state === 'exiting' && stateTimer >= EXIT_TIME) {
    state = 'hidden'
    stateTimer = 0
    setPhase('playing')
  }
}

function getAvailableUpgrades(): UpgradeDef[] {
  return UPGRADE_POOL.filter(def => {
    if (def.maxStacks == null) return true
    return getUpgradeCount(def.id) < def.maxStacks
  })
}

function buyUpgrade(def: UpgradeDef): void {
  const player = getPlayer()
  if (player.xp < SHOP_UPGRADE_COST) return
  if (def.maxStacks != null && getUpgradeCount(def.id) >= def.maxStacks) return

  player.xp -= SHOP_UPGRADE_COST
  addUpgrade({
    id: def.id,
    name: def.name,
    description: def.description,
    bonus: def.bonus,
  })
  applyModifiers(player)
}

// Layout constants
const CARD_W = 180
const CARD_H = 70
const GAP = 8
const COLS = 3
const MARGIN = 40

export function handleShopClick(mx: number, my: number, screenW: number, screenH: number): boolean {
  if (state !== 'browsing') return false

  // Close button
  const closeBtnX = screenW / 2 - 60
  const closeBtnY = screenH - MARGIN - 35
  if (mx >= closeBtnX && mx <= closeBtnX + 120 && my >= closeBtnY && my <= closeBtnY + 30) {
    closeShop()
    return true
  }

  // Upgrade cards
  const items = getAvailableUpgrades()
  const totalW = COLS * CARD_W + (COLS - 1) * GAP
  const startX = (screenW - totalW) / 2
  const startY = MARGIN + 60

  for (let i = 0; i < items.length; i++) {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const cx = startX + col * (CARD_W + GAP)
    const cy = startY + row * (CARD_H + GAP) - scrollOffset
    if (mx >= cx && mx <= cx + CARD_W && my >= cy && my <= cy + CARD_H) {
      buyUpgrade(items[i]!)
      return true
    }
  }
  return false
}

export function handleShopHover(mx: number, my: number, screenW: number, screenH: number): void {
  if (state !== 'browsing') { hoveredIndex = -1; return }

  const items = getAvailableUpgrades()
  const totalW = COLS * CARD_W + (COLS - 1) * GAP
  const startX = (screenW - totalW) / 2
  const startY = MARGIN + 60

  hoveredIndex = -1
  for (let i = 0; i < items.length; i++) {
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const cx = startX + col * (CARD_W + GAP)
    const cy = startY + row * (CARD_H + GAP) - scrollOffset
    if (mx >= cx && mx <= cx + CARD_W && my >= cy && my <= cy + CARD_H) {
      hoveredIndex = i
    }
  }
}

export function drawShopScreen(ctx: CanvasRenderingContext2D, screenW: number, screenH: number): void {
  if (state === 'hidden') return

  const player = getPlayer()
  const items = getAvailableUpgrades()

  // Overlay alpha
  let overlayAlpha = 0.75
  if (state === 'entering') overlayAlpha = 0.75 * (stateTimer / ENTER_TIME)
  if (state === 'exiting') overlayAlpha = 0.75 * (1 - stateTimer / EXIT_TIME)

  ctx.fillStyle = `rgba(0, 0, 0, ${overlayAlpha})`
  ctx.fillRect(0, 0, screenW, screenH)

  let contentAlpha = 1
  if (state === 'entering') contentAlpha = Math.min(stateTimer / ENTER_TIME, 1)
  if (state === 'exiting') contentAlpha = 1 - stateTimer / EXIT_TIME
  ctx.globalAlpha = contentAlpha

  // Title + XP display
  ctx.fillStyle = '#FFD740'
  ctx.font = 'bold 24px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('SHOP', screenW / 2, MARGIN + 20)
  ctx.font = '14px monospace'
  ctx.fillStyle = '#FFFFFF'
  ctx.fillText(`XP: ${Math.floor(player.xp)}`, screenW / 2, MARGIN + 42)
  ctx.textAlign = 'left'

  // Upgrade cards
  const totalW = COLS * CARD_W + (COLS - 1) * GAP
  const startX = (screenW - totalW) / 2
  const startY = MARGIN + 60

  for (let i = 0; i < items.length; i++) {
    const def = items[i]!
    const col = i % COLS
    const row = Math.floor(i / COLS)
    const cx = startX + col * (CARD_W + GAP)
    const cy = startY + row * (CARD_H + GAP) - scrollOffset

    const isHovered = hoveredIndex === i
    const canAfford = player.xp >= SHOP_UPGRADE_COST
    const stacks = getUpgradeCount(def.id)
    const maxed = def.maxStacks != null && stacks >= def.maxStacks

    // Card bg
    const bgAlpha = isHovered ? 0.25 : 0.15
    ctx.fillStyle = maxed
      ? `rgba(80, 80, 80, ${bgAlpha})`
      : `rgba(${parseInt(def.color.slice(1, 3), 16)}, ${parseInt(def.color.slice(3, 5), 16)}, ${parseInt(def.color.slice(5, 7), 16)}, ${bgAlpha})`
    ctx.fillRect(cx, cy, CARD_W, CARD_H)

    // Border
    const borderAlpha = isHovered ? 0.6 : 0.25
    ctx.strokeStyle = maxed
      ? `rgba(80, 80, 80, ${borderAlpha})`
      : canAfford
        ? `rgba(${parseInt(def.color.slice(1, 3), 16)}, ${parseInt(def.color.slice(3, 5), 16)}, ${parseInt(def.color.slice(5, 7), 16)}, ${borderAlpha})`
        : `rgba(120, 120, 120, ${borderAlpha})`
    ctx.lineWidth = isHovered ? 2 : 1
    ctx.strokeRect(cx, cy, CARD_W, CARD_H)

    // Name
    ctx.fillStyle = canAfford && !maxed ? '#FFFFFF' : 'rgba(255,255,255,0.4)'
    ctx.font = 'bold 12px monospace'
    ctx.fillText(def.name, cx + 8, cy + 18)

    // Description
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.font = '10px monospace'
    ctx.fillText(def.description, cx + 8, cy + 34)

    // Cost + stacks
    ctx.font = '11px monospace'
    if (maxed) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.fillText('MAXED', cx + 8, cy + 54)
    } else {
      ctx.fillStyle = canAfford ? '#FFD740' : 'rgba(255,100,100,0.6)'
      ctx.fillText(`Cost: ${SHOP_UPGRADE_COST} XP`, cx + 8, cy + 54)
    }

    if (def.maxStacks != null) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.textAlign = 'right'
      ctx.fillText(`${stacks}/${def.maxStacks}`, cx + CARD_W - 8, cy + 54)
      ctx.textAlign = 'left'
    }
  }

  // Close button
  const closeBtnX = screenW / 2 - 60
  const closeBtnY = screenH - MARGIN - 35
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)'
  ctx.fillRect(closeBtnX, closeBtnY, 120, 30)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
  ctx.lineWidth = 1
  ctx.strokeRect(closeBtnX, closeBtnY, 120, 30)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = '13px monospace'
  ctx.textAlign = 'center'
  ctx.fillText('CLOSE', screenW / 2, closeBtnY + 20)
  ctx.textAlign = 'left'

  ctx.globalAlpha = 1
}

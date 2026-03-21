import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_TOTAL_TIME, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { shouldFire } from '../audio/PatternClock.ts'
import * as Input from '../game/InputManager.ts'
import { emit } from '../core/EventBus.ts'
import { playDash, playWindup } from '../audio/AudioEngine.ts'
import { clampToArena } from '../game/Arena.ts'
import {
  PLAYER_SPEED,
  PLAYER_TEMPO,
  PLAYER_RADIUS,
  MAX_RING_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_BASE_DAMAGE,
} from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import { COLOR_PLAYER } from '../utils/constants.ts'

const DASH_DISTANCE = 260
const DASH_DURATION = 0.5
export const DASH_CHARGE_TIME = 3.0  // seconds to regen one charge
export const DASH_MAX_CHARGES = 2

export interface Player {
  x: number
  y: number
  ring: Ring
  hp: number
  maxHp: number
  displayHp: number
  damage: number
  facingAngle: number
  attackTimer: number
  hitFlash: number
  dashTimer: number
  dashDirX: number
  dashDirY: number
  dashCharges: number       // current available charges
  dashMaxCharges: number    // max (upgradeable later)
  dashRechargeTimer: number // time until next charge gained
  trail: { x: number; y: number }[]
  trailTimer: number
}

export function createPlayer(x: number, y: number): Player {
  return {
    x,
    y,
    ring: createRing(MAX_RING_RADIUS, PLAYER_TEMPO, hexToRgba(COLOR_PLAYER), 'player'),
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    displayHp: PLAYER_MAX_HP,
    damage: PLAYER_BASE_DAMAGE,
    facingAngle: 0,
    attackTimer: -1,
    hitFlash: 0,
    dashTimer: -1,
    dashDirX: 0,
    dashDirY: 0,
    dashCharges: DASH_MAX_CHARGES,
    dashMaxCharges: DASH_MAX_CHARGES,
    dashRechargeTimer: 0,
    trail: [],
    trailTimer: 0,
  }
}

export function getEffectiveRadius(player: Player): number {
  return player.ring.radius
}

export function updatePlayer(player: Player, dt: number): void {
  if (player.hitFlash > 0) player.hitFlash -= dt

  // Smooth HP display
  if (player.displayHp > player.hp) {
    player.displayHp -= (player.displayHp - player.hp) * 8 * dt
    if (player.displayHp - player.hp < 0.01) player.displayHp = player.hp
  }

  // Dash charge regen
  if (player.dashCharges < player.dashMaxCharges) {
    player.dashRechargeTimer += dt
    if (player.dashRechargeTimer >= DASH_CHARGE_TIME) {
      player.dashCharges++
      player.dashRechargeTimer = 0
    }
  }

  // Movement trail
  player.trailTimer -= dt
  if (player.trailTimer <= 0) {
    player.trail.push({ x: player.x, y: player.y })
    if (player.trail.length > 8) player.trail.shift()
    player.trailTimer = 0.03
  }

  // Dash movement
  if (player.dashTimer >= 0) {
    player.dashTimer -= dt
    const progress = 1 - (Math.max(0, player.dashTimer) / DASH_DURATION)
    const speed = Math.sin(progress * Math.PI) * (DASH_DISTANCE / DASH_DURATION) * 1.6
    player.x += player.dashDirX * speed * dt
    player.y += player.dashDirY * speed * dt
  } else {
    const dir = Input.getMovementDir()
    if (dir.x !== 0 || dir.y !== 0) {
      player.x += dir.x * PLAYER_SPEED * dt
      player.y += dir.y * PLAYER_SPEED * dt
      player.facingAngle = Math.atan2(dir.y, dir.x)
    }
  }

  // Clamp to arena
  const clamped = clampToArena(player.x, player.y, PLAYER_RADIUS)
  player.x = clamped.x
  player.y = clamped.y

  // Beat detection — pattern driven
  if (player.attackTimer < 0 && shouldFire('Player')) {
    player.attackTimer = 0
    playWindup(ATTACK_EXPAND_TIME, true)
  }

  // Attack animation
  if (player.attackTimer >= 0) {
    player.attackTimer += dt
    if (player.attackTimer >= ATTACK_EXPAND_TIME && player.attackTimer - dt < ATTACK_EXPAND_TIME) {
      emit('player:beat', player)
    }
    if (player.attackTimer > ATTACK_TOTAL_TIME) {
      player.attackTimer = -1
    }
  }

  // Dash input — need a charge AND not mid-dash
  if (Input.consumeLeftClick() || Input.consumeSpace()) {
    if (player.dashCharges > 0) {
      const dir = Input.getMovementDir()
      if (dir.x !== 0 || dir.y !== 0) {
        player.dashDirX = dir.x
        player.dashDirY = dir.y
        player.facingAngle = Math.atan2(dir.y, dir.x)
      } else {
        player.dashDirX = Math.cos(player.facingAngle)
        player.dashDirY = Math.sin(player.facingAngle)
      }
      player.dashTimer = DASH_DURATION
      player.dashCharges--
      playDash()
    }
  }
  Input.consumeRightClick()
}

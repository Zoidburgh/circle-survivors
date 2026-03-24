import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_TOTAL_TIME, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { shouldFire } from '../audio/PatternClock.ts'
import * as Input from '../game/InputManager.ts'
import { emit } from '../core/EventBus.ts'
import { playDash, playWindup } from '../audio/AudioEngine.ts'
import { clampToArena, ARENA_W, ARENA_H } from '../game/Arena.ts'
import {
  PLAYER_SPEED,
  PLAYER_TEMPO,
  PLAYER_RADIUS,
  MAX_RING_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_BASE_DAMAGE,
  HP_DRAIN_SPEED,
} from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import { COLOR_PLAYER } from '../utils/constants.ts'

const DASH_DISTANCE = 260
const DASH_DURATION = 0.5
export const DASH_CHARGE_TIME = 3.0  // seconds to regen one charge
export const DASH_MAX_CHARGES = 2

export interface PlayerModifiers {
  speedMult: number
  damageMult: number
  hpMult: number
  ringRadiusMult: number
  dashDistanceMult: number
  dashChargeMult: number
  xpMult: number
}

export function createDefaultModifiers(): PlayerModifiers {
  return {
    speedMult: 1.0,
    damageMult: 1.0,
    hpMult: 1.0,
    ringRadiusMult: 1.0,
    dashDistanceMult: 1.0,
    dashChargeMult: 1.0,
    xpMult: 1.0,
  }
}

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
  dashMaxCharges: number
  dashSlots: number[]  // per-slot timer: 0 = ready, >0 = charging (counts down)
  trail: { x: number; y: number }[]
  trailTimer: number
  prevX: number
  prevY: number
  dashStartX: number  // position when dash began — for sweep hit detection
  dashStartY: number
  hitRadius: number
  xp: number
  speed: number
  // Extra rings from upgrades — separate from base attack
  extraRingTimers: number[]  // attackTimer per extra ring, -1 = idle
  extraRingCount: number     // how many extra ring slots active (0-4)
  dashDuration: number
  dashChargeTime: number
  dashDistance: number
  modifiers: PlayerModifiers
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
    dashMaxCharges: DASH_MAX_CHARGES,
    dashSlots: Array(DASH_MAX_CHARGES).fill(0),
    trail: [],
    trailTimer: 0,
    prevX: ARENA_W / 2,
    prevY: ARENA_H / 2,
    dashStartX: ARENA_W / 2,
    dashStartY: ARENA_H / 2,
    hitRadius: PLAYER_RADIUS,
    xp: 0,
    speed: PLAYER_SPEED,
    extraRingTimers: [-1, -1, -1, -1],
    extraRingCount: 0,
    dashDuration: DASH_DURATION,
    dashChargeTime: DASH_CHARGE_TIME,
    dashDistance: DASH_DISTANCE,
    modifiers: createDefaultModifiers(),
  }
}

export function getEffectiveRadius(player: Player): number {
  return player.ring.radius * player.modifiers.ringRadiusMult
}

export function updatePlayer(player: Player, dt: number): void {
  if (player.hitFlash > 0) player.hitFlash -= dt

  // Smooth HP display
  if (player.displayHp > player.hp) {
    player.displayHp -= (player.displayHp - player.hp) * HP_DRAIN_SPEED * dt
    if (player.displayHp - player.hp < 0.01) player.displayHp = player.hp
  }

  // Dash charge regen — each slot charges independently
  for (let i = 0; i < player.dashSlots.length; i++) {
    if (player.dashSlots[i]! > 0) {
      player.dashSlots[i]! -= dt
      if (player.dashSlots[i]! <= 0) player.dashSlots[i] = 0
    }
  }

  // Movement trail
  player.trailTimer -= dt
  if (player.trailTimer <= 0) {
    player.trail.push({ x: player.x, y: player.y })
    if (player.trail.length > 8) player.trail.shift()
    player.trailTimer = 0.03
  }

  // Store previous position for sweep hit detection
  player.prevX = player.x
  player.prevY = player.y

  // Dash movement
  if (player.dashTimer >= 0) {
    player.dashTimer -= dt
    const progress = 1 - (Math.max(0, player.dashTimer) / player.dashDuration)
    const speed = Math.sin(progress * Math.PI) * (player.dashDistance * player.modifiers.dashDistanceMult * player.modifiers.speedMult / player.dashDuration) * 1.6
    player.x += player.dashDirX * speed * dt
    player.y += player.dashDirY * speed * dt
  } else {
    const dir = Input.getMovementDir()
    if (dir.x !== 0 || dir.y !== 0) {
      player.x += dir.x * player.speed * player.modifiers.speedMult * dt
      player.y += dir.y * player.speed * player.modifiers.speedMult * dt
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
  }

  // Attack animation
  if (player.attackTimer >= 0) {
    player.attackTimer += dt
    if (player.attackTimer >= ATTACK_EXPAND_TIME && player.attackTimer - dt < ATTACK_EXPAND_TIME) {
      emit('player:beat', player) // damage fires at ring peak
    }
    if (player.attackTimer > ATTACK_TOTAL_TIME) {
      player.attackTimer = -1
    }
  }

  // Extra ring attacks — separate from base, added by upgrades
  for (let i = 0; i < player.extraRingCount; i++) {
    const patternName = `PlayerExtra${i}`
    if (player.extraRingTimers[i]! < 0 && shouldFire(patternName)) {
      player.extraRingTimers[i] = 0
    }
    if (player.extraRingTimers[i]! >= 0) {
      player.extraRingTimers[i]! += dt
      if (player.extraRingTimers[i]! >= ATTACK_EXPAND_TIME && player.extraRingTimers[i]! - dt < ATTACK_EXPAND_TIME) {
        emit('player:beat', player)
      }
      if (player.extraRingTimers[i]! > ATTACK_TOTAL_TIME) {
        player.extraRingTimers[i] = -1
      }
    }
  }

  // Dash input — need a charge AND not mid-dash
  if (Input.consumeLeftClick() || Input.consumeSpace()) {
    const readySlot = player.dashSlots.findIndex(t => t <= 0)
    if (readySlot >= 0) {
      const dir = Input.getMovementDir()
      if (dir.x !== 0 || dir.y !== 0) {
        player.dashDirX = dir.x
        player.dashDirY = dir.y
        player.facingAngle = Math.atan2(dir.y, dir.x)
      } else {
        player.dashDirX = Math.cos(player.facingAngle)
        player.dashDirY = Math.sin(player.facingAngle)
      }
      player.dashStartX = player.x
      player.dashStartY = player.y
      player.dashTimer = player.dashDuration
      player.dashSlots[readySlot] = player.dashChargeTime * player.modifiers.dashChargeMult
      playDash()
    }
  }
  Input.consumeRightClick()
}

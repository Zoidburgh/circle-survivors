import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_TOTAL_TIME, ATTACK_EXPAND_TIME } from '../core/PhaseSystem.ts'
import { shouldFire } from '../audio/PatternClock.ts'
import * as Input from '../game/InputManager.ts'
import { emit } from '../core/EventBus.ts'
import { playDash, playWindup } from '../audio/AudioEngine.ts'
import { showToast, triggerDashFailFlash } from '../render/Renderer.ts'

let dashCDToastFired = false
let dashCDBeginner = false
export function resetDashCDToast(beginner = false): void { dashCDToastFired = false; dashCDBeginner = beginner }
import { clampToArena, ARENA_W, ARENA_H, getArenaShape, ARENA_CX, ARENA_CY, ARENA_RADIUS } from '../game/Arena.ts'
import { applyDashMotion } from './DashMotion.ts'
import {
  PLAYER_SPEED,
  PLAYER_TEMPO,
  PLAYER_RADIUS,
  MAX_RING_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_BASE_DAMAGE,
  HP_DRAIN_SPEED,
  HIT_FLASH_DURATION,
  SHIELD_MAX_CHARGES,
  SHIELD_RECHARGE_TIME,
  SHIELD_BREAK_FLASH,
} from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import { COLOR_PLAYER } from '../utils/constants.ts'

const DASH_DISTANCE = 413
const DASH_DURATION = 0.6
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
  shieldRechargeMult: number
  sizeMult: number
  beatBlastMult: number
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
    shieldRechargeMult: 1.0,
    sizeMult: 1.0,
    beatBlastMult: 1.0,
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
  dashStartX: number  // position when dash began
  dashStartY: number
  dashPath: { x: number; y: number }[]  // recorded positions along curved dash
  hitRadius: number
  xp: number
  speed: number
  // Extra rings from upgrades — separate from base attack
  extraRingTimers: number[]  // attackTimer per extra ring, -1 = idle
  extraRingCount: number     // how many extra ring slots active (0-4)
  dashDuration: number
  dashChargeTime: number
  dashDistance: number
  damageCooldown: number  // immunity window after taking a hit
  shieldCharges: number
  shieldMaxCharges: number
  shieldRechargeTimer: number  // counts down to 0; -1 = fully charged
  shieldBreakFlash: number
  shieldRechargeTime: number   // base 5s, modified by upgrades
  modifiers: PlayerModifiers
  dashJustReady: boolean[]     // flags set when a slot finishes charging
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
    dashPath: [],
    hitRadius: PLAYER_RADIUS,
    xp: 0,
    speed: PLAYER_SPEED,
    extraRingTimers: [-1, -1, -1, -1],
    extraRingCount: 0,
    dashDuration: DASH_DURATION,
    dashChargeTime: DASH_CHARGE_TIME,
    dashDistance: DASH_DISTANCE,
    damageCooldown: 0,
    shieldCharges: SHIELD_MAX_CHARGES,
    shieldMaxCharges: SHIELD_MAX_CHARGES,
    shieldRechargeTimer: -1,
    shieldBreakFlash: 0,
    shieldRechargeTime: SHIELD_RECHARGE_TIME,
    modifiers: createDefaultModifiers(),
    dashJustReady: Array(DASH_MAX_CHARGES).fill(false),
  }
}

/** Reset player to initial state — call on run restart */
export function resetPlayer(player: Player): void {
  player.x = ARENA_W / 2
  player.y = ARENA_H / 2
  player.hp = PLAYER_MAX_HP
  player.maxHp = PLAYER_MAX_HP
  player.displayHp = PLAYER_MAX_HP
  player.damage = PLAYER_BASE_DAMAGE
  player.facingAngle = 0
  player.attackTimer = -1
  player.hitFlash = 0
  player.dashTimer = -1
  player.dashDirX = 0
  player.dashDirY = 0
  player.dashMaxCharges = DASH_MAX_CHARGES
  player.dashSlots = Array(DASH_MAX_CHARGES).fill(0)
  player.trail = []
  player.trailTimer = 0
  player.prevX = ARENA_W / 2
  player.prevY = ARENA_H / 2
  player.dashStartX = ARENA_W / 2
  player.dashStartY = ARENA_H / 2
  player.dashPath = []
  player.xp = 0
  player.extraRingTimers = [-1, -1, -1, -1]
  player.extraRingCount = 0
  player.damageCooldown = 0
  player.shieldCharges = 0
  player.shieldMaxCharges = SHIELD_MAX_CHARGES
  player.shieldRechargeTimer = SHIELD_RECHARGE_TIME
  player.shieldBreakFlash = 0
  player.shieldRechargeTime = SHIELD_RECHARGE_TIME
  player.modifiers = createDefaultModifiers()
  player.dashJustReady = Array(DASH_MAX_CHARGES).fill(false)
}

export function getEffectiveRadius(player: Player): number {
  return player.ring.radius * player.modifiers.ringRadiusMult
}

export function getBodyRadius(player: Player): number {
  return PLAYER_RADIUS * player.modifiers.sizeMult
}

const DAMAGE_COOLDOWN = 0.1  // seconds of immunity after taking a hit

/** Try to deal damage to the player. Returns true if a hit was registered. */
export function hurtPlayer(player: Player, amount: number): boolean {
  if (player.damageCooldown > 0) return false

  // Shield absorb — no HP loss
  if (player.shieldCharges > 0) {
    player.shieldCharges--
    player.shieldBreakFlash = SHIELD_BREAK_FLASH
    player.hitFlash = HIT_FLASH_DURATION
    player.shieldRechargeTimer = player.shieldRechargeTime
    player.damageCooldown = DAMAGE_COOLDOWN
    emit('player:shieldBreak', player)
    return true
  }

  // No shield — take HP damage
  player.hp -= amount
  if (player.hp <= 0) player.hp = 0
  player.hitFlash = HIT_FLASH_DURATION
  player.damageCooldown = DAMAGE_COOLDOWN

  // Restart shield recharge when taking HP damage
  if (player.shieldRechargeTimer > 0) {
    player.shieldRechargeTimer = player.shieldRechargeTime
    emit('player:shieldRechargeReset', player)
  }

  return true
}

export function updatePlayer(player: Player, dt: number): void {
  if (player.hitFlash > 0) player.hitFlash -= dt
  if (player.damageCooldown > 0) player.damageCooldown -= dt
  if (player.shieldBreakFlash > 0) player.shieldBreakFlash -= dt

  // Shield recharge
  if (player.shieldRechargeTimer > 0) {
    player.shieldRechargeTimer -= dt
    if (player.shieldRechargeTimer <= 0) {
      player.shieldRechargeTimer = -1
      player.shieldCharges = Math.min(player.shieldCharges + 1, player.shieldMaxCharges)
      emit('player:shieldRestore', player)
    }
  }

  // Smooth HP display — drain slow (so the red wedge is readable as damage feedback), fill smooth
  if (player.displayHp > player.hp) {
    player.displayHp -= (player.displayHp - player.hp) * (HP_DRAIN_SPEED * 0.65) * dt
    if (player.displayHp - player.hp < 0.01) player.displayHp = player.hp
  } else if (player.displayHp < player.hp) {
    player.displayHp += (player.hp - player.displayHp) * 6 * dt
    if (player.hp - player.displayHp < 0.01) player.displayHp = player.hp
  }

  // Dash charge regen — each slot charges independently
  for (let i = 0; i < player.dashSlots.length; i++) {
    if (player.dashSlots[i]! > 0) {
      player.dashSlots[i]! -= dt
      if (player.dashSlots[i]! <= 0) {
        player.dashSlots[i] = 0
        player.dashJustReady[i] = true
      }
    }
  }

  // Store previous position for sweep hit detection
  player.prevX = player.x
  player.prevY = player.y

  // Dash movement
  if (player.dashTimer >= 0) {
    applyDashMotion(player, dt, {
      steerInput: Input.getMovementDir(),
      distanceMult: player.modifiers.dashDistanceMult,
      speedMult: player.modifiers.speedMult,
    })
  } else {
    const dir = Input.getMovementDir()
    if (dir.x !== 0 || dir.y !== 0) {
      player.x += dir.x * player.speed * player.modifiers.speedMult * dt
      player.y += dir.y * player.speed * player.modifiers.speedMult * dt
      player.facingAngle = Math.atan2(dir.y, dir.x)
    }
  }

  // Clamp to arena — wall slide preserves tangential movement
  const bodyR = PLAYER_RADIUS * player.modifiers.sizeMult
  player.hitRadius = bodyR
  if (getArenaShape() === 'circle') {
    const dx = player.x - ARENA_CX
    const dy = player.y - ARENA_CY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const maxDist = ARENA_RADIUS - bodyR
    if (dist > maxDist && dist > 0.1) {
      // How far past the wall
      const overshoot = dist - maxDist
      const nx = dx / dist
      const ny = dy / dist
      // Tangent direction (perpendicular to normal, CCW)
      const tx = -ny
      const ty = nx
      // Project overshoot onto tangent — this is the wall-slide distance
      // Use the pre-clamp movement direction for the projection
      const moveX = player.x - player.prevX
      const moveY = player.y - player.prevY
      const tangentDot = moveX * tx + moveY * ty
      // Clamp to wall
      player.x = ARENA_CX + nx * maxDist
      player.y = ARENA_CY + ny * maxDist
      // Slide along wall
      player.x += tx * tangentDot * 0.8
      player.y += ty * tangentDot * 0.8
      // Re-clamp in case slide pushed past
      const dx2 = player.x - ARENA_CX
      const dy2 = player.y - ARENA_CY
      const dist2 = Math.sqrt(dx2 * dx2 + dy2 * dy2)
      if (dist2 > maxDist) {
        player.x = ARENA_CX + (dx2 / dist2) * maxDist
        player.y = ARENA_CY + (dy2 / dist2) * maxDist
      }
    }
  } else {
    const clamped = clampToArena(player.x, player.y, bodyR)
    player.x = clamped.x
    player.y = clamped.y
  }

  // Movement trail — distance-based, collapses when stationary
  const dir = Input.getMovementDir()
  const isMoving = dir.x !== 0 || dir.y !== 0 || player.dashTimer >= 0
  const lastTrail = player.trail[player.trail.length - 1]
  const trailDx = lastTrail ? player.x - lastTrail.x : 999
  const trailDy = lastTrail ? player.y - lastTrail.y : 999
  const trailDist = Math.sqrt(trailDx * trailDx + trailDy * trailDy)
  if (trailDist > 12) {
    player.trail.push({ x: player.x, y: player.y })
    if (player.trail.length > 8) player.trail.shift()
    player.trailTimer = 0.04
  } else if (isMoving && player.trail.length < 8) {
    // Seed trail quickly when starting to move
    player.trailTimer -= dt
    if (player.trailTimer <= 0) {
      player.trail.push({ x: player.x, y: player.y })
      player.trailTimer = 0.03
    }
  } else if (!isMoving) {
    // Collapse when stationary
    player.trailTimer -= dt
    if (player.trailTimer <= 0 && player.trail.length > 0) {
      player.trail.shift()
      player.trailTimer = 0.04
    }
  }

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

  // Track last non-zero movement direction for dash buffering
  {
    const dir = Input.getMovementDir()
    if (dir.x !== 0 || dir.y !== 0) {
      player.facingAngle = Math.atan2(dir.y, dir.x)
    }
  }

  // Dash input — need a charge AND not mid-dash
  if (Input.consumeLeftClick() || Input.consumeSpace()) {
    const readySlot = player.dashSlots.findIndex(t => t <= 0)
    if (readySlot < 0) {
      // No dash available — flash the pies red as visual feedback
      triggerDashFailFlash()
      // Notify on beginner only
      if (!dashCDToastFired && dashCDBeginner) {
        dashCDToastFired = true
        showToast('DASH on CD!', { y: 0.14, duration: 1.5, size: 42, id: 'dash_cd', color: [0, 200, 255], style: 'glow', glowWords: ['DASH', 'CD!'], glowColor: [100, 255, 120] })
      }
    }
    if (readySlot >= 0) {
      // Check if dash is on-beat (ring is near peak)
      const nearPeak = player.attackTimer >= 0 && Math.abs(player.attackTimer - ATTACK_EXPAND_TIME) < 0.15
      // Also check extra ring timers
      let extraNearPeak = false
      for (let i = 0; i < player.extraRingCount; i++) {
        if (player.extraRingTimers[i]! >= 0 && Math.abs(player.extraRingTimers[i]! - ATTACK_EXPAND_TIME) < 0.15) {
          extraNearPeak = true
        }
      }
      const onBeatDash = nearPeak || extraNearPeak

      player.dashDirX = Math.cos(player.facingAngle)
      player.dashDirY = Math.sin(player.facingAngle)
      player.dashPath = [{ x: player.x, y: player.y }]
      player.dashStartX = player.x
      player.dashStartY = player.y
      player.dashTimer = player.dashDuration
      player.dashSlots[readySlot] = player.dashChargeTime * player.modifiers.dashChargeMult
      playDash()

      // On-beat dash — emit shockwave event
      if (onBeatDash) {
        emit('player:beatDash', player)
      }
    }
  }
  Input.consumeRightClick()
}

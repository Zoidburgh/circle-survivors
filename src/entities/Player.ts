import type { Ring } from './Ring.ts'
import { createRing } from './Ring.ts'
import { ATTACK_TOTAL_TIME, ATTACK_EXPAND_TIME, RING_FIRE_LEAD_SEC } from '../core/PhaseSystem.ts'
import { shouldFire } from '../audio/PatternClock.ts'
import { probe } from '../audio/TimingProbe.ts'
import * as Input from '../game/InputManager.ts'
import { emit } from '../core/EventBus.ts'
import { playDash, playWindup, playChargeReady, playDashSweep } from '../audio/AudioEngine.ts'
import { showToast, triggerDashFailFlash } from '../render/Renderer.ts'

let dashCDToastFired = false
let dashCDBeginner = false
export function resetDashCDToast(beginner = false): void { dashCDToastFired = false; dashCDBeginner = beginner }
import { clampToArena, resolveWallCollision, clearPlayerWalls, appendPlayerWall, ARENA_W, ARENA_H, getArenaShape, ARENA_CX, ARENA_CY, ARENA_RADIUS } from '../game/Arena.ts'
import { applyDashMotion } from './DashMotion.ts'
import { hasBonus } from '../game/UpgradeManager.ts'
import {
  PLAYER_SPEED,
  PLAYER_TEMPO,
  PLAYER_RADIUS,
  MAX_RING_RADIUS,
  PLAYER_MAX_HP,
  PLAYER_BASE_DAMAGE,
  HP_DRAIN_SPEED,
  HIT_FLASH_DURATION,
  BEAT_DASH_RETRIGGER_CD,
  SHIELD_MAX_CHARGES,
  SHIELD_RECHARGE_TIME,
  SHIELD_BREAK_FLASH,
  BEAT_SEC,
} from '../utils/constants.ts'
import { hexToRgba } from '../utils/math.ts'
import { COLOR_PLAYER } from '../utils/constants.ts'

const DASH_DISTANCE = 413
const DASH_DURATION = 0.6
export const DASH_CHARGE_TIME = 2.8  // seconds to regen one charge
export const DASH_MAX_CHARGES = 2
// Echo Step (anchor-recall) — half-beat ghost-traversal back to the previously dropped anchor.
// Tuned to half a beat so the recall lands on the half-subdivision after the dash beat,
// keeping the rhythm grid clean (dash on beat → arrive on the off-beat).
export const RECALL_DURATION = BEAT_SEC * 0.5

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
  pendingHeal: number   // HP gained this frame (accumulated across sim ticks) — renderer fires the
  pendingHurt: number   // gold heal pulse / red hurt pulse from these, so a same-frame heal+hit STACK
                        // both visuals instead of cancelling on net HP (which is what they'd do if
                        // the renderer diffed hp). Reset to 0 by the renderer after each frame.
  overheal: number      // temporary extra HP from a heal that overflowed maxHp — soaks incoming damage
  overhealTimer: number // for a brief window then decays. Lets a heal fully absorb a same-beat hit at
                        // full HP (net 0) instead of being wasted.
  speedBoostTimer: number // seconds left on the heal-at-full SPEED BURST (decays to 0 over 2s).
  speedBoostCount: number // overheal hearts banked in the active window (1–3); resets when it decays.
  speedBoostPeak: number  // peak move-speed bonus for this burst: 1.0/1.5/2.0 (= +100/150/200%), which
                          // the timer decays from. Drives the gold afterimage trail + scales the visual.
  dashTimer: number
  dashDirX: number
  dashDirY: number
  // Wall-spring launch impulse — added to position each frame during launchTimer, decays
  // exponentially. Bypasses normal movement gates so springs can shove the player even mid-dash.
  launchVx: number; launchVy: number; launchTimer: number
  dashChainBoost: number  // per-dash distance multiplier (1.0 normal, 2.0 when chained with Slipstream)
                          // — set on dash start, applied multiplicatively on top of modifiers.dashDistanceMult
  // Echo Step state — beat-dash leapfrog mechanic. Anchor is the last spot the player beat-dashed
  // from; the NEXT beat-dash consumes it (ghost-traverse back) and drops a new anchor at the
  // new beat-dash spot. recallTimer >= 0 means a traversal is in progress (invuln + locked input).
  anchorX: number
  anchorY: number
  anchorActive: boolean
  recallTimer: number          // -1 = not recalling, else counts down from RECALL_DURATION
  recallFromX: number
  recallFromY: number
  recallToX: number
  recallToY: number
  dashMaxCharges: number
  dashSlots: number[]  // per-slot timer: 0 = ready, >0 = charging (counts down)
  trail: { x: number; y: number }[]
  trailTimer: number
  prevX: number
  prevY: number
  dashStartX: number  // position when dash began
  dashStartY: number
  dashPath: { x: number; y: number }[]  // recorded positions along curved dash
  // Preserved dash trail for a PENDING ring peak. When a new dash starts (e.g. a beat-dash) while the
  // ring is still expanding, the outgoing trail is frozen here so the peak's back-smear survives the
  // dashPath reset instead of collapsing to a tiny front smear. Consumed at the peak. See HitDetection.
  pendingSmearPath: { x: number; y: number }[] | null
  hitRadius: number
  xp: number
  speed: number
  // Extra rings from upgrades — separate from base attack
  extraRingTimers: number[]  // attackTimer per extra ring, -1 = idle
  extraRingCount: number     // how many extra ring slots active (0-4)
  // Beat-dash late-grace tracking — seconds since each ring last crossed ATTACK_EXPAND_TIME.
  // Decoupled from attackTimer so the on-beat dash window can extend PAST the ring's visual death
  // (ATTACK_TOTAL_TIME=0.50s caps the visible linger to 0.05s, but we want 0.10s of late grace).
  // Initialized to a large value so no false trigger before the first peak.
  mainRingPeakAge: number
  extraRingPeakAges: number[]
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
  // Quiet Storm — stand still for CHARGE_DURATION seconds → next beat-dash gets 2× distance
  // and 2× AOE radius. Visual: a loading ring at 2× the beat-dash AOE radius fills as the
  // charge builds. Resets the moment the player moves.
  chargeTimer: number             // seconds the player has been stationary (0..CHARGE_DURATION)
  chargeReady: boolean            // true when chargeTimer >= CHARGE_DURATION
  chargedDashActive: boolean      // set when a dash consumes the charge — read by beat-dash AOE handler
  chargeReadyToastFired: boolean  // one-shot "ding" SFX flag so it only plays once per fill
  // Trailblaze — active wall-drawing state during a chain-dash. While drawingWall is true,
  // each frame appends a new thin wall segment from drawLastX/Y to the current position so
  // the trail follows the dash's actual curve (not a straight start→end line).
  drawingWall: boolean
  drawLastX: number
  drawLastY: number
  // Dash input buffer — if dash is pressed while all slots are on CD, queue the press for a
  // tiny grace window. If a slot recharges within that window the dash fires retroactively;
  // otherwise the fail flash + toast fire on expiration. Forgives the player for pressing dash
  // ~1-2 frames before a slot recharges. dashBufferOnBeat captures whether the original press
  // was on-beat so the retroactive dash honors player intent — without it, the buffered fire
  // would re-check on-beat at fire time and could miss the window the player actually hit.
  dashBufferTimer: number
  dashBufferOnBeat: boolean
  beatDashCdTimer: number  // retrigger cooldown — blocks a 2nd beat-dash AOE within one beat window
}
export const CHARGE_DURATION = 3
export const TRAILBLAZE_SEGMENT_LEN = 22   // px between segments — smaller = smoother curve, more walls
export const DASH_BUFFER_DURATION = 0.05  // 50ms — small input grace window

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
    pendingHeal: 0,
    pendingHurt: 0,
    overheal: 0,
    overhealTimer: 0,
    speedBoostTimer: 0,
    speedBoostCount: 0,
    speedBoostPeak: 0,
    dashTimer: -1,
    dashDirX: 0,
    dashDirY: 0,
    launchVx: 0, launchVy: 0, launchTimer: 0,
    dashChainBoost: 1.0,
    anchorX: 0, anchorY: 0, anchorActive: false,
    recallTimer: -1, recallFromX: 0, recallFromY: 0, recallToX: 0, recallToY: 0,
    dashMaxCharges: DASH_MAX_CHARGES,
    dashSlots: Array(DASH_MAX_CHARGES).fill(0),
    trail: [],
    trailTimer: 0,
    prevX: ARENA_W / 2,
    prevY: ARENA_H / 2,
    dashStartX: ARENA_W / 2,
    dashStartY: ARENA_H / 2,
    dashPath: [],
    pendingSmearPath: null,
    hitRadius: PLAYER_RADIUS,
    xp: 0,
    speed: PLAYER_SPEED,
    extraRingTimers: [-1, -1, -1, -1],
    extraRingCount: 0,
    mainRingPeakAge: 999,
    extraRingPeakAges: [999, 999, 999, 999],
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
    chargeTimer: 0,
    chargeReady: false,
    chargedDashActive: false,
    chargeReadyToastFired: false,
    drawingWall: false,
    drawLastX: 0,
    drawLastY: 0,
    dashBufferTimer: 0,
    dashBufferOnBeat: false,
    beatDashCdTimer: 0,
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
  player.overheal = 0; player.overhealTimer = 0
  player.speedBoostTimer = 0; player.speedBoostCount = 0; player.speedBoostPeak = 0
  player.dashTimer = -1
  player.dashDirX = 0
  player.dashDirY = 0
  player.launchVx = 0; player.launchVy = 0; player.launchTimer = 0
  player.dashChainBoost = 1.0
  player.chargeTimer = 0
  player.chargeReady = false
  player.chargedDashActive = false
  player.chargeReadyToastFired = false
  player.drawingWall = false
  player.drawLastX = 0
  player.drawLastY = 0
  player.dashBufferTimer = 0
  player.beatDashCdTimer = 0
  player.dashBufferOnBeat = false
  clearPlayerWalls()
  player.anchorActive = false
  player.recallTimer = -1
  player.dashMaxCharges = DASH_MAX_CHARGES
  player.dashSlots = Array(DASH_MAX_CHARGES).fill(0)
  player.trail = []
  player.trailTimer = 0
  player.prevX = ARENA_W / 2
  player.prevY = ARENA_H / 2
  player.dashStartX = ARENA_W / 2
  player.dashStartY = ARENA_H / 2
  player.dashPath = []
  player.pendingSmearPath = null
  player.xp = 0
  player.extraRingTimers = [-1, -1, -1, -1]
  player.extraRingCount = 0
  player.mainRingPeakAge = 999
  player.extraRingPeakAges = [999, 999, 999, 999]
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
// Overheal — temporary HP from a heal that overflowed max HP; soaks incoming damage for a short
// window then decays. Small cap + short window so it mainly cancels same-beat heal/damage, not a
// lasting shield.
const OVERHEAL_MAX = 2
const OVERHEAL_WINDOW = 0.1   // seconds

// Heal-at-full SPEED BOOST — collecting overheal hearts grants a BURST of move speed that decays to
// 0 over 2s. Each overheal heart collected within the active window adds to a count (at-once OR
// chained): 1 → +100%, 2 → +150%, 3+ → +200% (max). The count resets when the boost fully decays.
export const SPEED_BOOST_DURATION = 2.0   // seconds
export const SPEED_BOOST_BASE = 0.9        // +90% for the first overheal
export const SPEED_BOOST_PER_EXTRA = 0.25  // +25% per extra overheal → tiers +90 / +115 / +140%
export const SPEED_BOOST_MAX_COUNT = 3    // cap → max +200%

export function hurtPlayer(player: Player, amount: number): boolean {
  if (player.damageCooldown > 0) return false
  // Echo Step recall traversal — player is mid-warp, completely invulnerable. Mirrors
  // ghost-dash's gate but unconditional (the upgrade IS the invuln window).
  if (player.recallTimer >= 0) return false
  probe('player-hit')   // every applied hit (shield or HP) — the hit-sound fires this same frame

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

  // Overheal buffer — temporary points from a recent heal soak the hit FIRST (no HP loss). Brief
  // flash so the soaked hit still reads, but no red burst. Fully soaked → done (net 0 damage).
  if (player.overheal > 0) {
    const absorbed = Math.min(player.overheal, amount)
    player.overheal -= absorbed
    amount -= absorbed
    player.hitFlash = HIT_FLASH_DURATION
    player.damageCooldown = DAMAGE_COOLDOWN
    if (amount <= 0) return true
  }

  // No shield — take HP damage.
  const before = player.hp
  player.hp -= amount
  if (player.hp <= 0) player.hp = 0
  player.pendingHurt += before - player.hp   // event-driven hurt pulse (stacks with same-frame heal)
  player.hitFlash = HIT_FLASH_DURATION
  player.damageCooldown = DAMAGE_COOLDOWN

  // Restart shield recharge when taking HP damage
  if (player.shieldRechargeTimer > 0) {
    player.shieldRechargeTimer = player.shieldRechargeTime
    emit('player:shieldRechargeReset', player)
  }

  return true
}

// Heal the player by `amount` (clamped to maxHp) and record the actual gain so the renderer fires
// the gold heal pulse from the EVENT — not a net-HP diff — so a heal lands its visual even when a
// hit cancels it on the same frame. Returns HP actually gained.
export function healPlayer(player: Player, amount: number): number {
  if (amount <= 0) return 0
  const before = player.hp
  player.hp = Math.min(player.hp + amount, player.maxHp)
  const gained = player.hp - before
  // Any part of the heal that overflowed max HP becomes a brief temporary OVERHEAL buffer (capped)
  // that soaks an incoming hit within a short window — so a heal at full HP isn't wasted: a same-beat
  // damage gets absorbed (net 0) instead of landing.
  const overflow = amount - gained
  if (overflow > 0) {
    player.overheal = Math.min(player.overheal + overflow, OVERHEAL_MAX)
    player.overhealTimer = OVERHEAL_WINDOW
    // Overheal → grow the speed-burst count (only ever rises within a window; resets after it decays
    // in updatePlayer), recompute the peak, and refresh the timer. Counting overflow (not hearts)
    // means a partly-healing grab only counts the part that overflowed. Same path for at-once (several
    // healPlayer calls one frame) and chaining (more collected before the boost fades).
    player.speedBoostCount = Math.min(SPEED_BOOST_MAX_COUNT, player.speedBoostCount + overflow)
    player.speedBoostPeak = SPEED_BOOST_BASE + SPEED_BOOST_PER_EXTRA * (player.speedBoostCount - 1)
    player.speedBoostTimer = SPEED_BOOST_DURATION
  }
  player.pendingHeal += gained   // normal heal pulse only for HP actually restored (0 at full → none)
  return gained
}

export function updatePlayer(player: Player, dt: number): void {
  if (player.hitFlash > 0) player.hitFlash -= dt
  if (player.overhealTimer > 0) {
    player.overhealTimer -= dt
    if (player.overhealTimer <= 0) { player.overhealTimer = 0; player.overheal = 0 }
  }
  if (player.speedBoostTimer > 0) {
    player.speedBoostTimer -= dt
    if (player.speedBoostTimer <= 0) { player.speedBoostTimer = 0; player.speedBoostCount = 0; player.speedBoostPeak = 0 }
  }
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

  // Smooth HP display — drain slowed further (0.65 → 0.4) so the red drain wedge stays
  // visible for a beat or two before settling. Still fast — half-life ~0.22s — just no
  // longer near-instant.
  if (player.displayHp > player.hp) {
    player.displayHp -= (player.displayHp - player.hp) * (HP_DRAIN_SPEED * 0.4) * dt
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

  // Echo Step recall traversal — supersedes dash motion + normal movement input. Ease-out
  // lerp so the player decelerates into the anchor, and damage is gated off via hurtPlayer.
  if (player.recallTimer >= 0) {
    player.recallTimer -= dt
    if (player.recallTimer <= 0) {
      player.x = player.recallToX
      player.y = player.recallToY
      player.recallTimer = -1
    } else {
      const t = 1 - player.recallTimer / RECALL_DURATION  // 0 → 1
      const eased = 1 - (1 - t) * (1 - t)
      player.x = player.recallFromX + (player.recallToX - player.recallFromX) * eased
      player.y = player.recallFromY + (player.recallToY - player.recallFromY) * eased
    }
  } else if (player.dashTimer >= 0) {
    // Substep the dash motion into 4 mini-steps and resolve walls after each. Stops the
    // dash from tunneling through thin walls when distance-per-frame exceeds wall thickness
    // (e.g. Slipstream-boosted dashes can move 20+ px/frame; default walls are ~36 px thick
    // including player radius, so single-step would still resolve, but with thinner walls or
    // future +dash-speed upgrades this future-proofs it cheaply).
    const SUBSTEPS = 4
    const subDt = dt / SUBSTEPS
    const playerBodyR = PLAYER_RADIUS * player.modifiers.sizeMult
    for (let s = 0; s < SUBSTEPS; s++) {
      if (player.dashTimer < 0) break  // dash ended mid-substep
      applyDashMotion(player, subDt, {
        steerInput: Input.getMovementDir(),
        // Multiplicative stacking: Long Dash and any other future +dashDistanceMult upgrades
        // live in modifiers.dashDistanceMult; Slipstream's chain bonus sits in dashChainBoost.
        // Compounding them means each upgrade keeps its full proportional effect on the others.
        distanceMult: player.modifiers.dashDistanceMult * player.dashChainBoost,
        // Move-speed bonuses (Swift + the heal-at-full burst) apply at HALF strength to the dash, so
        // the dash extends but not as dramatically as walking. Half of each BONUS (the part above 1×),
        // multiplied together; Long Dash (distanceMult) is separate and unaffected.
        speedMult: (1 + (player.modifiers.speedMult - 1) * 0.5)
                   * (1 + player.speedBoostPeak * (player.speedBoostTimer / SPEED_BOOST_DURATION) * 0.5),
        // Pivot — aggressive mid-dash steering so the dash can carve curves instead of
        // committing to a straight lunge. 12× steers ~96% toward input per frame at 60fps (4
        // substeps × 55% each), so direction snaps to WASD nearly instantly. useAngleSteer
        // switches to atan2-based interpolation so axis-aligned 180° flips actually work (the
        // component lerp + normalize path has a symmetry trap there that stalls progress). Off
        // by default keeps non-Pivot dash feel identical.
        steerStrengthMult: hasBonus('pivot') ? 12 : 1,
        useAngleSteer: hasBonus('pivot'),
      })
      const wr = resolveWallCollision(player.x, player.y, playerBodyR, true)
      player.x = wr.x
      player.y = wr.y
    }
  } else {
    const dir = Input.getMovementDir()
    if (dir.x !== 0 || dir.y !== 0) {
      // Heal-at-full speed boost — a burst that decays with the timer from its peak (+100/150/200%),
      // multiplicative on top of speed upgrades so it stacks naturally.
      const boostMult = 1 + player.speedBoostPeak * (player.speedBoostTimer / SPEED_BOOST_DURATION)
      player.x += dir.x * player.speed * player.modifiers.speedMult * boostMult * dt
      player.y += dir.y * player.speed * player.modifiers.speedMult * boostMult * dt
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
  // Wall-spring launch — peak velocity at fire, exponential decay, smooth fade-out tail.
  // Directional Influence (DI): input vector accelerates the launch velocity directly so
  // the player can bend the trajectory mid-bounce, not just shuffle on top of it. Without
  // DI, launch (~500 px/s) outguns input (280 px/s) until decay knocks it below ~280, by
  // which point the bounce is mostly over and you never felt in control.
  if (player.launchTimer > 0) {
    player.launchTimer -= dt
    const steer = Input.getMovementDir()
    if (steer.x !== 0 || steer.y !== 0) {
      const STEER_ACCEL = 8500   // px/s² peak steering authority
      // Asymmetric DI: input is split into a parallel-to-launch component and a perpendicular
      // component. Perpendicular steering always has full authority (curves the arc freely).
      // The PARALLEL component is full-authority when it's WITH the launch (boost), but the
      // OPPOSING parallel component is gated by an early-launch lockout window AND CAPPED to
      // a max so the player can NEVER fully cancel an outward push — they can slow it down
      // but the launch will always carry some distance.
      // Window (elapsed = LAUNCH_DURATION - launchTimer, LAUNCH_DURATION = 0.28s):
      //   0.00s → 0.16s : 100% opposition lockout (you cannot fight back at all)
      //   0.16s → 0.28s : opposition authority ramps 0% → OPP_MAX
      //   0.28s+        : OPP_MAX opposition authority (capped, never 100%)
      // Tuned so the bounce always commits — you can steer perpendicular (curve the arc)
      // or boost in the launch direction at full authority, but resisting against the push
      // is heavily gated and capped.
      const OPP_MAX = 0.20     // hard cap on opposition authority — push is mostly uncancellable
      const lsp2 = player.launchVx * player.launchVx + player.launchVy * player.launchVy
      if (lsp2 > 1) {
        const lsp = Math.sqrt(lsp2)
        const lnx = player.launchVx / lsp
        const lny = player.launchVy / lsp
        const along = steer.x * lnx + steer.y * lny    // >0 with launch, <0 opposing
        const parX = along * lnx, parY = along * lny
        const perpX = steer.x - parX, perpY = steer.y - parY
        const elapsed = 0.28 - player.launchTimer
        const oppMult = along < 0
          ? Math.max(0, Math.min(OPP_MAX, (elapsed - 0.16) / 0.12 * OPP_MAX))
          : 1
        player.launchVx += (parX * oppMult + perpX) * STEER_ACCEL * dt
        player.launchVy += (parY * oppMult + perpY) * STEER_ACCEL * dt
      } else {
        // Launch already drained — restore full steering
        player.launchVx += steer.x * STEER_ACCEL * dt
        player.launchVy += steer.y * STEER_ACCEL * dt
      }
    }
    const decay = Math.pow(0.03, dt)   // snappier — drops velocity faster (was 0.06)
    player.launchVx *= decay
    player.launchVy *= decay
    const LAUNCH_FADE_TAIL = 0.10
    const fadeMult = player.launchTimer < LAUNCH_FADE_TAIL
      ? Math.max(0, player.launchTimer / LAUNCH_FADE_TAIL)
      : 1
    player.x += player.launchVx * fadeMult * dt
    player.y += player.launchVy * fadeMult * dt
    if (player.launchTimer <= 0) {
      player.launchVx = 0; player.launchVy = 0; player.launchTimer = 0
    }
  }
  // Wall collision — runs after arena clamp so walls inside the arena push out of any
  // overlap. Skipped during the Echo Step recall (intentionally phases through walls — it's
  // a teleport, not a movement). Dash motion already resolved walls per-substep above; this
  // catches WASD movement, post-clamp wall overlap, and dash-end positions.
  if (player.recallTimer < 0) {
    const wr = resolveWallCollision(player.x, player.y, bodyR, true)
    player.x = wr.x
    player.y = wr.y
  }

  // Post-dash tick — keep dashTimer counting down briefly past zero so visual lingers
  // (Slipstream braid) can actually expire. applyDashMotion freezes the timer at ~-0.001
  // the moment it crosses below zero, so without this the braid renders forever.
  if (player.dashTimer < 0 && player.dashTimer > -1) {
    player.dashTimer -= dt
  }

  // Trailblaze — drop wall segments along the dash path while drawing. Each segment connects
  // the previous sample point to the current position. When the player has moved at least
  // TRAILBLAZE_SEGMENT_LEN px from the last sample, commit a segment and advance the sample.
  // Drawing ends when the dash does (dashTimer < 0) — the trail freezes in place.
  if (player.drawingWall) {
    if (player.dashTimer < 0) {
      // Dash ended — commit one final segment to the current position if we still owe one,
      // then stop drawing.
      const dxF = player.x - player.drawLastX
      const dyF = player.y - player.drawLastY
      if (dxF * dxF + dyF * dyF >= 25) {
        appendPlayerWall(player.drawLastX, player.drawLastY, player.x, player.y)
      }
      player.drawingWall = false
    } else {
      const dxL = player.x - player.drawLastX
      const dyL = player.y - player.drawLastY
      if (dxL * dxL + dyL * dyL >= TRAILBLAZE_SEGMENT_LEN * TRAILBLAZE_SEGMENT_LEN) {
        appendPlayerWall(player.drawLastX, player.drawLastY, player.x, player.y)
        player.drawLastX = player.x
        player.drawLastY = player.y
      }
    }
  }

  // Quiet Storm charge — gated on the upgrade. Accumulates while truly stationary; once
  // full, the charge STAYS READY (follows the player around) until consumed by the next
  // on-beat dash. Moving while filling resets the timer; moving while already-ready does
  // NOT cancel the readiness. Only an on-beat dash consumes it.
  if (hasBonus('quietStorm')) {
    if (!player.chargeReady) {
      const moved = Math.abs(player.x - player.prevX) > 0.5 || Math.abs(player.y - player.prevY) > 0.5
      const dashing = player.dashTimer >= 0
      const recalling = player.recallTimer >= 0
      const launched = player.launchTimer > 0
      const inputActive = (Input.getMovementDir().x !== 0 || Input.getMovementDir().y !== 0)
      const canCharge = !moved && !dashing && !recalling && !launched && !inputActive
      if (canCharge) {
        player.chargeTimer += dt
        if (player.chargeTimer >= CHARGE_DURATION) {
          player.chargeTimer = CHARGE_DURATION
          player.chargeReady = true
          if (!player.chargeReadyToastFired) {
            player.chargeReadyToastFired = true
            playChargeReady()
          }
        }
      } else {
        player.chargeTimer = 0
      }
    }
    // chargeReady: persists across movement until consumed by on-beat dash (see dash-init).
  } else {
    // Upgrade not active — make sure no stale state lingers (e.g. upgrade was lost).
    if (player.chargeTimer !== 0) player.chargeTimer = 0
    if (player.chargeReady) player.chargeReady = false
    if (player.chargeReadyToastFired) player.chargeReadyToastFired = false
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

  // Beat detection — pattern driven. Uses RING_FIRE_LEAD_SEC so the ring starts its visible
  // expansion ahead of the actual beat — hit still lands on-beat because ATTACK_EXPAND_TIME
  // was bumped by the same delta.
  if (player.attackTimer < 0 && shouldFire('Player', RING_FIRE_LEAD_SEC)) {
    player.attackTimer = 0
  }

  // Attack animation
  if (player.attackTimer >= 0) {
    player.attackTimer += dt
    if (player.attackTimer >= ATTACK_EXPAND_TIME && player.attackTimer - dt < ATTACK_EXPAND_TIME) {
      emit('player:beat', player) // damage fires at ring peak
      player.mainRingPeakAge = 0  // reset late-grace window on every peak crossing
    }
    if (player.attackTimer > ATTACK_TOTAL_TIME) {
      player.attackTimer = -1
      player.pendingSmearPath = null   // safety: a preserved trail never outlives its ring (normally consumed at the peak)
    }
  }
  // Always tick mainRingPeakAge — independent of ring life so late grace can extend past linger death
  player.mainRingPeakAge += dt
  if (player.beatDashCdTimer > 0) player.beatDashCdTimer -= dt   // beat-dash AOE retrigger cooldown

  // Extra ring attacks — separate from base, added by upgrades
  for (let i = 0; i < player.extraRingCount; i++) {
    const patternName = `PlayerExtra${i}`
    if (player.extraRingTimers[i]! < 0 && shouldFire(patternName, RING_FIRE_LEAD_SEC)) {
      player.extraRingTimers[i] = 0
    }
    if (player.extraRingTimers[i]! >= 0) {
      player.extraRingTimers[i]! += dt
      if (player.extraRingTimers[i]! >= ATTACK_EXPAND_TIME && player.extraRingTimers[i]! - dt < ATTACK_EXPAND_TIME) {
        emit('player:beat', player)
        player.extraRingPeakAges[i] = 0
      }
      if (player.extraRingTimers[i]! > ATTACK_TOTAL_TIME) {
        player.extraRingTimers[i] = -1
      }
    }
    player.extraRingPeakAges[i]! += dt
  }

  // Track last non-zero movement direction for dash buffering
  {
    const dir = Input.getMovementDir()
    if (dir.x !== 0 || dir.y !== 0) {
      player.facingAngle = Math.atan2(dir.y, dir.x)
    }
  }

  // Compute whether the current moment is in the on-beat dash window. Asymmetric grace,
  // late side decoupled from ring lifecycle. Used at press time so a buffered dash can honor
  // the player's actual intent (the window they pressed in) instead of re-checking at the
  // later fire moment when the window may have just closed.
  const computeOnBeat = (): boolean => {
    const earlyGrace = player.attackTimer >= 0
      && player.attackTimer >= ATTACK_EXPAND_TIME - 0.12
      && player.attackTimer < ATTACK_EXPAND_TIME
    const lateGrace = player.mainRingPeakAge < 0.10
    if (earlyGrace || lateGrace) return true
    for (let i = 0; i < player.extraRingCount; i++) {
      const t = player.extraRingTimers[i]!
      const eEarly = t >= 0 && t >= ATTACK_EXPAND_TIME - 0.12 && t < ATTACK_EXPAND_TIME
      const eLate = player.extraRingPeakAges[i]! < 0.10
      if (eEarly || eLate) return true
    }
    return false
  }

  // ── Dash fire helper — encapsulates the full dash-start sequence so live input and buffered
  // input both go through the same code path. `onBeatDash` is captured at press time and
  // passed in, so a buffered dash that fires a few ms later still counts as on-beat if the
  // press itself was on-beat.
  const fireDash = (readySlot: number, onBeatDash: boolean): void => {

    // Beat-dash AOE fires only if on-beat AND the retrigger cooldown is clear — so two dashes in one
    // beat's on-beat window (an early + a late press) can't stack two blasts. The dash itself still
    // happens; the second just doesn't detonate. First on-beat press in the window wins.
    const doBeatDash = onBeatDash && player.beatDashCdTimer <= 0

    // Slipstream chain boost — read BEFORE we overwrite dashTimer below. A new dash
    // initiated while the previous one is still active "drafts" off it for +100% distance.
    const isChainingDash = player.dashTimer >= 0
    player.dashChainBoost = (isChainingDash && hasBonus('chainDash')) ? 2.0 : 1.0

    // Trailblaze — chain-dash starts ACTIVELY DRAWING a wall trail along the new dash path
    if (isChainingDash && hasBonus('drawWall')) {
      clearPlayerWalls()
      player.drawingWall = true
      player.drawLastX = player.x
      player.drawLastY = player.y
    }

    // Quiet Storm — only consumed on a BEAT DASH that actually detonates.
    if (player.chargeReady && doBeatDash) {
      player.dashChainBoost *= 2.0
      player.chargedDashActive = true
      player.chargeReady = false
      player.chargeTimer = 0
      player.chargeReadyToastFired = false
    } else {
      player.chargedDashActive = false
    }

    player.dashDirX = Math.cos(player.facingAngle)
    player.dashDirY = Math.sin(player.facingAngle)
    // If a ring peak is still PENDING (ring expanding, not yet peaked) AND the interrupted dash is
    // STILL ACTIVE (dashTimer >= 0 — the two dashes actually overlap; no post-dash grace tail),
    // preserve it so the peak's smear fires behind you instead of collapsing to a tiny front smear
    // when the reset below wipes the path. The active gate is critical: it rejects the STALE trail
    // still sitting in dashPath from a past chain (a stale/ended dash sits at dashTimer < 0), so a
    // LONE dash on a later beat can't snapshot an old location. Reference-freeze (reset gives a new array).
    if (player.dashTimer >= 0 && player.attackTimer >= 0 && player.attackTimer < ATTACK_EXPAND_TIME && player.dashPath.length > 1) {
      player.pendingSmearPath = player.dashPath
    }
    // Beat-dash SLICE sound — fire it HERE (at the dash), not only at the ring peak, for the cases
    // the peak-fired smear MISSES entirely: a beat-dash pressed ON or AFTER the peak (same-frame
    // input runs after the peak emit; or the late-grace window fires beats after it). In those cases
    // pendingSmearPath/isDashing aren't set when player:beat emits, so the smear would render but stay
    // SILENT. We only fire here when the peak is NOT still upcoming (else the peak handles it — firing
    // both would double). Reads the outgoing trail BEFORE the reset below, so the tier still scales
    // with the smear length. Freshness gate (dashTimer > -0.15) = a real chain, not a stale path.
    const peakUpcoming = player.attackTimer >= 0 && player.attackTimer < ATTACK_EXPAND_TIME
    if (doBeatDash && !peakUpcoming && player.dashTimer > -0.15 && player.dashPath.length > 1) {
      const path = player.dashPath
      const startIdx = Math.floor(path.length * 0.7)   // last 30% — matches the smear's DASH_SWEEP_CAP
      let smearLen = 0
      for (let i = startIdx + 1; i < path.length; i++) {
        smearLen += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y)
      }
      if (smearLen > 1) playDashSweep(smearLen / 124)
    }
    player.dashPath = [{ x: player.x, y: player.y }]
    player.dashStartX = player.x
    player.dashStartY = player.y
    player.dashTimer = player.dashDuration
    player.dashSlots[readySlot] = player.dashChargeTime * player.modifiers.dashChargeMult
    playDash()

    if (doBeatDash) {
      player.beatDashCdTimer = BEAT_DASH_RETRIGGER_CD   // start the retrigger lock so no 2nd blast this beat
      emit('player:beatDash', player)
    }
  }

  // Recall (Echo Step) clears any pending buffered dash — the warp is locked input and we
  // don't want a stale buffer firing on exit.
  if (player.recallTimer >= 0) player.dashBufferTimer = 0

  // Dash input — need a charge AND not mid-recall
  if (Input.consumeLeftClick() || Input.consumeSpace()) {
    // Echo Step: ignore dash input mid-recall; the player is in a locked warp.
    if (player.recallTimer >= 0) {
      Input.consumeRightClick()
      return
    }
    const readySlot = player.dashSlots.findIndex(t => t <= 0)
    // Capture on-beat at THE MOMENT OF THE PRESS. Used by both immediate fire and (if buffered)
    // the retroactive fire when a slot recharges within the grace window.
    const onBeatAtPress = computeOnBeat()
    if (readySlot >= 0) {
      // Live input + slot ready → fire immediately. Clear any in-flight buffer.
      player.dashBufferTimer = 0
      fireDash(readySlot, onBeatAtPress)
    } else {
      // No slot ready → buffer the press + the on-beat state for a tiny grace window.
      player.dashBufferTimer = DASH_BUFFER_DURATION
      player.dashBufferOnBeat = onBeatAtPress
    }
  }

  // Buffer service — runs every frame whether input was pressed or not. If a slot became
  // ready while the buffer is alive, fire the dash retroactively using the on-beat state we
  // captured at press time (player.dashBufferOnBeat). Otherwise tick the timer and fire the
  // deferred fail feedback when it expires.
  if (player.dashBufferTimer > 0 && player.recallTimer < 0) {
    const readySlot = player.dashSlots.findIndex(t => t <= 0)
    if (readySlot >= 0) {
      const bufferedOnBeat = player.dashBufferOnBeat
      player.dashBufferTimer = 0
      player.dashBufferOnBeat = false
      fireDash(readySlot, bufferedOnBeat)
    } else {
      player.dashBufferTimer -= dt
      if (player.dashBufferTimer <= 0) {
        // Grace expired with no slot — NOW deliver the fail feedback that we held back.
        player.dashBufferTimer = 0
        triggerDashFailFlash()
        if (!dashCDToastFired && dashCDBeginner) {
          dashCDToastFired = true
          showToast('DASH on CD!', { y: 0.14, duration: 1.5, size: 42, id: 'dash_cd', color: [0, 200, 255], style: 'glow', glowWords: ['DASH', 'CD!'], glowColor: [100, 255, 120] })
        }
      }
    }
  }

  Input.consumeRightClick()
}

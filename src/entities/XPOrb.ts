import { PLAYER_RADIUS, SPAWN_ANIM_DURATION } from '../utils/constants.ts'

export type OrbType = 'xp' | 'hp'

export interface XPOrb {
  x: number
  y: number
  radius: number
  baseRadius: number
  value: number
  orbType: OrbType
  alive: boolean
  spawnTimer: number   // 0→1 grow-in
  dying: boolean
  deathTimer: number
  consumedBy: 'player' | 'enemy' | null
  // Wall-spring launch impulse (px/s) — added to position each frame during launchTimer
  launchVx: number; launchVy: number; launchTimer: number
}

const ORB_RADIUS = PLAYER_RADIUS * 0.575
const DEATH_DUR = 0.2
const MAX_ORBS = 150

// ── Tuning — easy to modify for upgrades ──
export const ORB_HP_HEAL = 1         // HP restored per health orb
export const ORB_HP_DROP_CHANCE = 0.5 // 50% chance to drop HP orb instead of XP

const orbs: XPOrb[] = []

export function spawnOrb(x: number, y: number, value = 1, type: OrbType = 'xp'): void {
  if (orbs.length >= MAX_ORBS) return
  orbs.push({
    x, y,
    radius: 1,
    baseRadius: ORB_RADIUS,
    value,
    orbType: type,
    alive: true,
    spawnTimer: 0,
    dying: false,
    deathTimer: -1,
    consumedBy: null,
    launchVx: 0, launchVy: 0, launchTimer: 0,
  })
}

export function getOrbs(): XPOrb[] {
  return orbs
}

export function collectOrb(orb: XPOrb, source: 'player' | 'enemy' = 'player'): void {
  orb.dying = true
  orb.consumedBy = source
  orb.deathTimer = 0
}

export function updateOrbs(dt: number): void {
  for (const orb of orbs) {
    // Death animation
    if (orb.dying) {
      orb.deathTimer += dt
      if (orb.deathTimer >= DEATH_DUR) {
        orb.alive = false
      }
      continue
    }

    if (!orb.alive) continue

    // Grow-in
    if (orb.spawnTimer < 1) {
      orb.spawnTimer += dt / SPAWN_ANIM_DURATION
      if (orb.spawnTimer > 1) orb.spawnTimer = 1
      const t = 1 - (1 - orb.spawnTimer) * (1 - orb.spawnTimer)
      orb.radius = orb.baseRadius * t
    }
    // Wall-spring launch — additive position change, decays exponentially
    if (orb.launchTimer > 0) {
      orb.launchTimer -= dt
      const decay = Math.pow(0.03, dt)   // snappier — matches Player
      orb.launchVx *= decay
      orb.launchVy *= decay
      const LAUNCH_FADE_TAIL = 0.10   // smooth fade — no abrupt snap (matches Player)
      const fadeMult = orb.launchTimer < LAUNCH_FADE_TAIL
        ? Math.max(0, orb.launchTimer / LAUNCH_FADE_TAIL)
        : 1
      orb.x += orb.launchVx * fadeMult * dt
      orb.y += orb.launchVy * fadeMult * dt
      if (orb.launchTimer <= 0) {
        orb.launchVx = 0; orb.launchVy = 0; orb.launchTimer = 0
      }
    }
  }
}

export function cleanupOrbs(): void {
  for (let i = orbs.length - 1; i >= 0; i--) {
    if (!orbs[i]!.alive) {
      orbs[i] = orbs[orbs.length - 1]!
      orbs.pop()
    }
  }
}

/** Clear all orbs — call on run restart */
export function resetOrbs(): void {
  orbs.length = 0
}

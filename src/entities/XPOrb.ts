import { PLAYER_RADIUS, SPAWN_ANIM_DURATION } from '../utils/constants.ts'

export interface XPOrb {
  x: number
  y: number
  radius: number
  baseRadius: number
  value: number
  alive: boolean
  spawnTimer: number   // 0→1 grow-in
  dying: boolean
  deathTimer: number
}

const ORB_RADIUS = PLAYER_RADIUS * 0.5
const DEATH_DUR = 0.2
const MAX_ORBS = 150

const orbs: XPOrb[] = []

export function spawnOrb(x: number, y: number, value = 1): void {
  if (orbs.length >= MAX_ORBS) return
  orbs.push({
    x, y,
    radius: 1,
    baseRadius: ORB_RADIUS,
    value,
    alive: true,
    spawnTimer: 0,
    dying: false,
    deathTimer: -1,
  })
}

export function getOrbs(): XPOrb[] {
  return orbs
}

export function collectOrb(orb: XPOrb): void {
  orb.dying = true
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

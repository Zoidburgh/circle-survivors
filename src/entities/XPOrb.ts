import { PLAYER_RADIUS, SPAWN_ANIM_DURATION } from '../utils/constants.ts'
import { clampToArena } from '../game/Arena.ts'

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

const orbs: XPOrb[] = []

export function spawnOrb(x: number, y: number, value = 1): void {
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

export function updateOrbs(dt: number, playerX: number, playerY: number, enemies: { x: number; y: number; radius: number; alive: boolean; dying: boolean }[]): void {
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

    // Push by player
    const pdx = orb.x - playerX
    const pdy = orb.y - playerY
    const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
    const pMin = orb.radius + PLAYER_RADIUS
    if (pDist < pMin && pDist > 0.1) {
      const overlap = pMin - pDist
      orb.x += (pdx / pDist) * overlap
      orb.y += (pdy / pDist) * overlap
    }

    // Push by enemies
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying) continue
      const edx = orb.x - enemy.x
      const edy = orb.y - enemy.y
      const eDist = Math.sqrt(edx * edx + edy * edy)
      const eMin = orb.radius + enemy.radius
      if (eDist < eMin && eDist > 0.1) {
        const overlap = eMin - eDist
        orb.x += (edx / eDist) * overlap
        orb.y += (edy / eDist) * overlap
      }
    }

    // Push by other orbs
    for (const other of orbs) {
      if (other === orb || !other.alive || other.dying) continue
      const odx = orb.x - other.x
      const ody = orb.y - other.y
      const oDist = Math.sqrt(odx * odx + ody * ody)
      const oMin = orb.radius + other.radius
      if (oDist < oMin && oDist > 0.1) {
        const overlap = oMin - oDist
        orb.x += (odx / oDist) * overlap * 0.5
        orb.y += (ody / oDist) * overlap * 0.5
      }
    }

    const clamped = clampToArena(orb.x, orb.y, orb.radius)
    orb.x = clamped.x
    orb.y = clamped.y
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

// Arena — fixed rectangular play area with Brotato-style camera

import { ARENA_BUFFER, CAMERA_LEAD_AMOUNT } from '../utils/constants.ts'

export const ARENA_W = 1700
export const ARENA_H = 1100

export interface Camera {
  x: number  // world position of camera center
  y: number
  targetX: number
  targetY: number
}

export function createCamera(): Camera {
  return { x: ARENA_W / 2, y: ARENA_H / 2, targetX: ARENA_W / 2, targetY: ARENA_H / 2 }
}

export function updateCamera(
  cam: Camera,
  playerX: number,
  playerY: number,
  moveX: number,
  moveY: number,
  screenW: number,
  screenH: number,
  dt: number
): void {
  // Lead ahead — offset toward movement direction
  const leadAmount = CAMERA_LEAD_AMOUNT
  const leadX = playerX + moveX * leadAmount
  const leadY = playerY + moveY * leadAmount

  // Smooth follow
  cam.targetX = leadX
  cam.targetY = leadY
  const smoothing = 6
  cam.x += (cam.targetX - cam.x) * smoothing * dt
  cam.y += (cam.targetY - cam.y) * smoothing * dt

  // Clamp camera — allow seeing the buffer zone but not beyond
  const halfW = screenW / 2
  const halfH = screenH / 2
  cam.x = Math.max(halfW - ARENA_BUFFER, Math.min(ARENA_W + ARENA_BUFFER - halfW, cam.x))
  cam.y = Math.max(halfH - ARENA_BUFFER, Math.min(ARENA_H + ARENA_BUFFER - halfH, cam.y))
}

/** Clamp a position inside the arena */
export function clampToArena(x: number, y: number, radius: number): { x: number; y: number } {
  return {
    x: Math.max(radius, Math.min(ARENA_W - radius, x)),
    y: Math.max(radius, Math.min(ARENA_H - radius, y)),
  }
}

/** Get a random spawn position inside the arena, min distance from player */
export function getSpawnPos(playerX: number, playerY: number, minDist = 250): { x: number; y: number } {
  const margin = 80
  for (let attempt = 0; attempt < 20; attempt++) {
    const x = margin + Math.random() * (ARENA_W - margin * 2)
    const y = margin + Math.random() * (ARENA_H - margin * 2)
    const dx = x - playerX
    const dy = y - playerY
    if (dx * dx + dy * dy > minDist * minDist) {
      return { x, y }
    }
  }
  // Fallback: just pick a spot near the edge
  return { x: margin + Math.random() * 100, y: margin + Math.random() * 100 }
}


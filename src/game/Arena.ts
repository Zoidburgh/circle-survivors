// Arena — fixed play area with Brotato-style camera
// Supports rectangle and circle shapes

import { ARENA_BUFFER, CAMERA_LEAD_AMOUNT } from '../utils/constants.ts'

export type ArenaShape = 'rect' | 'circle'

// ── Configuration ──
let arenaShape: ArenaShape = 'rect'
export const ARENA_W = 1700
export const ARENA_H = 1100
export const ARENA_RADIUS = 1000  // for circle mode
export const ARENA_CX = ARENA_W / 2  // center X (used by both modes)
export const ARENA_CY = ARENA_H / 2  // center Y (used by both modes)

export function getArenaShape(): ArenaShape { return arenaShape }
export function setArenaShape(shape: ArenaShape): void { arenaShape = shape }

export interface Camera {
  x: number  // world position of camera center
  y: number
  targetX: number
  targetY: number
}

export function createCamera(): Camera {
  return { x: ARENA_CX, y: ARENA_CY, targetX: ARENA_CX, targetY: ARENA_CY }
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
  const leadX = playerX + moveX * CAMERA_LEAD_AMOUNT
  const leadY = playerY + moveY * CAMERA_LEAD_AMOUNT

  // Smooth follow
  cam.targetX = leadX
  cam.targetY = leadY
  const smoothing = 6
  cam.x += (cam.targetX - cam.x) * smoothing * dt
  cam.y += (cam.targetY - cam.y) * smoothing * dt

  // Clamp camera
  const halfW = screenW / 2
  const halfH = screenH / 2

  if (arenaShape === 'circle') {
    // Clamp camera center so it doesn't show too far beyond arena edge
    const dx = cam.x - ARENA_CX
    const dy = cam.y - ARENA_CY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const maxDist = Math.max(0, ARENA_RADIUS + ARENA_BUFFER - Math.min(halfW, halfH))
    if (dist > maxDist && dist > 0.1) {
      cam.x = ARENA_CX + (dx / dist) * maxDist
      cam.y = ARENA_CY + (dy / dist) * maxDist
    }
  } else {
    cam.x = Math.max(halfW - ARENA_BUFFER, Math.min(ARENA_W + ARENA_BUFFER - halfW, cam.x))
    cam.y = Math.max(halfH - ARENA_BUFFER, Math.min(ARENA_H + ARENA_BUFFER - halfH, cam.y))
  }
}

/** Clamp a position inside the arena */
export function clampToArena(x: number, y: number, radius: number): { x: number; y: number } {
  if (arenaShape === 'circle') {
    const dx = x - ARENA_CX
    const dy = y - ARENA_CY
    const dist = Math.sqrt(dx * dx + dy * dy)
    const maxDist = ARENA_RADIUS - radius
    if (dist > maxDist && dist > 0.1) {
      return {
        x: ARENA_CX + (dx / dist) * maxDist,
        y: ARENA_CY + (dy / dist) * maxDist,
      }
    }
    return { x, y }
  }
  return {
    x: Math.max(radius, Math.min(ARENA_W - radius, x)),
    y: Math.max(radius, Math.min(ARENA_H - radius, y)),
  }
}

/** Get a random spawn position inside the arena, min distance from player */
export function getSpawnPos(playerX: number, playerY: number, minDist = 250): { x: number; y: number } {
  for (let attempt = 0; attempt < 20; attempt++) {
    let x: number, y: number
    if (arenaShape === 'circle') {
      const angle = Math.random() * Math.PI * 2
      const dist = Math.random() * (ARENA_RADIUS - 80)
      x = ARENA_CX + Math.cos(angle) * dist
      y = ARENA_CY + Math.sin(angle) * dist
    } else {
      const margin = 80
      x = margin + Math.random() * (ARENA_W - margin * 2)
      y = margin + Math.random() * (ARENA_H - margin * 2)
    }
    const dx = x - playerX
    const dy = y - playerY
    if (dx * dx + dy * dy > minDist * minDist) {
      return { x, y }
    }
  }
  // Fallback
  if (arenaShape === 'circle') {
    const angle = Math.random() * Math.PI * 2
    return { x: ARENA_CX + Math.cos(angle) * ARENA_RADIUS * 0.7, y: ARENA_CY + Math.sin(angle) * ARENA_RADIUS * 0.7 }
  }
  return { x: 80 + Math.random() * 100, y: 80 + Math.random() * 100 }
}

/** Check if a point is inside the arena */
export function isInArena(x: number, y: number): boolean {
  if (arenaShape === 'circle') {
    const dx = x - ARENA_CX
    const dy = y - ARENA_CY
    return dx * dx + dy * dy <= ARENA_RADIUS * ARENA_RADIUS
  }
  return x >= 0 && x <= ARENA_W && y >= 0 && y <= ARENA_H
}

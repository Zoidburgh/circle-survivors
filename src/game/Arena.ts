// Arena — fixed play area with Brotato-style camera
// Supports rectangle and circle shapes

import { ARENA_BUFFER, CAMERA_LEAD_AMOUNT } from '../utils/constants.ts'

export type ArenaShape = 'rect' | 'circle' | 'hex' | 'pill' | 'cross'

// ── Configuration ──
let arenaShape: ArenaShape = 'rect'
export const ARENA_W = 1700
export const ARENA_H = 1100
export const ARENA_RADIUS = 1000  // for circle mode
export const ARENA_CX = ARENA_W / 2  // center X (used by both modes)
export const ARENA_CY = ARENA_H / 2  // center Y (used by both modes)

// ── Pill geometry ──
// Horizontal stadium: two semicircles (radius PILL_R) connected by straight top/bottom edges
export const PILL_R = 550       // cap radius
export const PILL_HALF_W = 500  // half-length of straight section
// Total width = PILL_HALF_W * 2 + PILL_R * 2 = 2100, height = PILL_R * 2 = 1100

// ── Cross geometry ──
// Plus/cross shape: two overlapping rectangles centered on ARENA_CX/CY
export const CROSS_HW = 350   // half-width of each arm
export const CROSS_HE = 1000  // half-extent from center to arm tip
// Total: 2000x2000, arm width 700px

/** Get the 12 vertices of the cross outline (clockwise) */
export function getCrossVertices(cx: number, cy: number): { x: number; y: number }[] {
  const hw = CROSS_HW, he = CROSS_HE
  return [
    { x: cx - hw, y: cy - he },  // top arm, top-left
    { x: cx + hw, y: cy - he },  // top arm, top-right
    { x: cx + hw, y: cy - hw },  // inner corner, top-right
    { x: cx + he, y: cy - hw },  // right arm, top
    { x: cx + he, y: cy + hw },  // right arm, bottom
    { x: cx + hw, y: cy + hw },  // inner corner, bottom-right
    { x: cx + hw, y: cy + he },  // bottom arm, bottom-right
    { x: cx - hw, y: cy + he },  // bottom arm, bottom-left
    { x: cx - hw, y: cy + hw },  // inner corner, bottom-left
    { x: cx - he, y: cy + hw },  // left arm, bottom
    { x: cx - he, y: cy - hw },  // left arm, top
    { x: cx - hw, y: cy - hw },  // inner corner, top-left
  ]
}

function isInCross(x: number, y: number): boolean {
  const rx = Math.abs(x - ARENA_CX)
  const ry = Math.abs(y - ARENA_CY)
  // In horizontal arm OR vertical arm
  return (rx <= CROSS_HE && ry <= CROSS_HW) || (rx <= CROSS_HW && ry <= CROSS_HE)
}

function clampToCross(x: number, y: number, entityRadius: number): { x: number; y: number } {
  const hw = CROSS_HW - entityRadius
  const he = CROSS_HE - entityRadius
  const rx = x - ARENA_CX
  const ry = y - ARENA_CY

  // Check if already inside
  const inH = Math.abs(rx) <= he && Math.abs(ry) <= hw  // horizontal arm
  const inV = Math.abs(rx) <= hw && Math.abs(ry) <= he  // vertical arm
  if (inH || inV) return { x, y }

  // Outside: find closest point in the cross
  // Clamp to horizontal arm
  const hx = Math.max(-he, Math.min(he, rx))
  const hy = Math.max(-hw, Math.min(hw, ry))
  const hDist = (rx - hx) * (rx - hx) + (ry - hy) * (ry - hy)

  // Clamp to vertical arm
  const vx = Math.max(-hw, Math.min(hw, rx))
  const vy = Math.max(-he, Math.min(he, ry))
  const vDist = (rx - vx) * (rx - vx) + (ry - vy) * (ry - vy)

  if (hDist <= vDist) {
    return { x: ARENA_CX + hx, y: ARENA_CY + hy }
  }
  return { x: ARENA_CX + vx, y: ARENA_CY + vy }
}

export function getArenaShape(): ArenaShape { return arenaShape }
export function setArenaShape(shape: ArenaShape): void { arenaShape = shape }

// ── Hex geometry ──
// Regular hexagon with flat top/bottom, circumradius = ARENA_RADIUS
// Width = 2R, Height = R√3 ≈ 1.73R — wider than tall for landscape screens
const HEX_AXES = [
  { nx: 0, ny: 1 },                                                    // top/bottom flat edges
  { nx: Math.sin(Math.PI / 3), ny: Math.cos(Math.PI / 3) },            // upper-right/lower-left edges
  { nx: -Math.sin(Math.PI / 3), ny: Math.cos(Math.PI / 3) },           // upper-left/lower-right edges
]
const HEX_INRADIUS_FACTOR = Math.cos(Math.PI / 6)  // √3/2 ≈ 0.866

/** Get hex vertices for rendering (flat-top orientation) */
export function getHexVertices(cx: number, cy: number, r: number): { x: number; y: number }[] {
  const verts: { x: number; y: number }[] = []
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3  // flat-top: vertices at 0°, 60°, 120°...
    verts.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r })
  }
  return verts
}

/** Clamp point to inside hex. Returns clamped position. */
function clampToHex(x: number, y: number, entityRadius: number): { x: number; y: number } {
  let rx = x - ARENA_CX
  let ry = y - ARENA_CY
  const inradius = ARENA_RADIUS * HEX_INRADIUS_FACTOR - entityRadius
  for (const axis of HEX_AXES) {
    const dot = rx * axis.nx + ry * axis.ny
    if (dot > inradius) {
      rx -= (dot - inradius) * axis.nx
      ry -= (dot - inradius) * axis.ny
    } else if (dot < -inradius) {
      rx -= (dot + inradius) * axis.nx
      ry -= (dot + inradius) * axis.ny
    }
  }
  return { x: ARENA_CX + rx, y: ARENA_CY + ry }
}

/** Check if point is inside hex */
function isInHex(x: number, y: number): boolean {
  const rx = x - ARENA_CX
  const ry = y - ARENA_CY
  const inradius = ARENA_RADIUS * HEX_INRADIUS_FACTOR
  for (const axis of HEX_AXES) {
    const dot = rx * axis.nx + ry * axis.ny
    if (Math.abs(dot) > inradius) return false
  }
  return true
}

// ── Pill geometry helpers ──
/** Clamp to pill (stadium) shape — straight section + semicircle caps */
function clampToPill(x: number, y: number, entityRadius: number): { x: number; y: number } {
  const rx = x - ARENA_CX
  const ry = y - ARENA_CY
  const maxR = PILL_R - entityRadius
  // Clamp x to within the total pill width
  const clampedRx = Math.max(-PILL_HALF_W - maxR, Math.min(PILL_HALF_W + maxR, rx))
  if (Math.abs(clampedRx) <= PILL_HALF_W) {
    // In the straight section — just clamp y
    const clampedRy = Math.max(-maxR, Math.min(maxR, ry))
    return { x: ARENA_CX + clampedRx, y: ARENA_CY + clampedRy }
  }
  // In a cap — clamp to semicircle
  const capCx = clampedRx > 0 ? PILL_HALF_W : -PILL_HALF_W
  const dx = clampedRx - capCx
  const dy = ry
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist > maxR && dist > 0.1) {
    return {
      x: ARENA_CX + capCx + (dx / dist) * maxR,
      y: ARENA_CY + (dy / dist) * maxR,
    }
  }
  return { x: ARENA_CX + clampedRx, y: ARENA_CY + ry }
}

function isInPill(x: number, y: number): boolean {
  const rx = x - ARENA_CX
  const ry = y - ARENA_CY
  if (Math.abs(rx) <= PILL_HALF_W) {
    return Math.abs(ry) <= PILL_R
  }
  const capCx = rx > 0 ? PILL_HALF_W : -PILL_HALF_W
  const dx = rx - capCx
  return dx * dx + ry * ry <= PILL_R * PILL_R
}

export interface Camera {
  x: number  // world position of camera center
  y: number
  targetX: number
  targetY: number
  smoothLeadX: number
  smoothLeadY: number
}

export function createCamera(): Camera {
  return { x: ARENA_CX, y: ARENA_CY, targetX: ARENA_CX, targetY: ARENA_CY, smoothLeadX: 0, smoothLeadY: 0 }
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
  // Lead ahead — smooth ramp toward movement direction
  const targetLeadX = moveX * CAMERA_LEAD_AMOUNT
  const targetLeadY = moveY * CAMERA_LEAD_AMOUNT
  const leadSpeed = 4  // how fast the lead ramps up/down
  cam.smoothLeadX += (targetLeadX - cam.smoothLeadX) * leadSpeed * dt
  cam.smoothLeadY += (targetLeadY - cam.smoothLeadY) * leadSpeed * dt

  // Smooth follow — boost when player is far from camera (fast dash)
  cam.targetX = playerX + cam.smoothLeadX
  cam.targetY = playerY + cam.smoothLeadY
  const dx = cam.targetX - cam.x
  const dy = cam.targetY - cam.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  const smoothing = dist > 80 ? 6 + (dist - 80) * 0.08 : 6
  const step = Math.min(smoothing * dt, 1)  // never overshoot
  cam.x += dx * step
  cam.y += dy * step

  // Clamp camera
  const halfW = screenW / 2
  const halfH = screenH / 2

  if (arenaShape === 'cross') {
    cam.x = Math.max(ARENA_CX - CROSS_HE + halfW - ARENA_BUFFER, Math.min(ARENA_CX + CROSS_HE - halfW + ARENA_BUFFER, cam.x))
    cam.y = Math.max(ARENA_CY - CROSS_HE + halfH - ARENA_BUFFER, Math.min(ARENA_CY + CROSS_HE - halfH + ARENA_BUFFER, cam.y))
  } else if (arenaShape === 'pill') {
    const pillLeft = ARENA_CX - PILL_HALF_W - PILL_R
    const pillRight = ARENA_CX + PILL_HALF_W + PILL_R
    const pillTop = ARENA_CY - PILL_R
    const pillBot = ARENA_CY + PILL_R
    cam.x = Math.max(pillLeft + halfW - ARENA_BUFFER, Math.min(pillRight - halfW + ARENA_BUFFER, cam.x))
    cam.y = Math.max(pillTop + halfH - ARENA_BUFFER, Math.min(pillBot - halfH + ARENA_BUFFER, cam.y))
  } else if (arenaShape === 'hex') {
    // Hex: width = 2R, height = R*√3 — clamp independently
    const hexHalfW = ARENA_RADIUS
    const hexHalfH = ARENA_RADIUS * Math.cos(Math.PI / 6)
    cam.x = Math.max(ARENA_CX - hexHalfW + halfW - ARENA_BUFFER, Math.min(ARENA_CX + hexHalfW - halfW + ARENA_BUFFER, cam.x))
    cam.y = Math.max(ARENA_CY - hexHalfH + halfH - ARENA_BUFFER, Math.min(ARENA_CY + hexHalfH - halfH + ARENA_BUFFER, cam.y))
  } else if (arenaShape === 'circle') {
    cam.x = Math.max(ARENA_CX - ARENA_RADIUS + halfW - ARENA_BUFFER, Math.min(ARENA_CX + ARENA_RADIUS - halfW + ARENA_BUFFER, cam.x))
    cam.y = Math.max(ARENA_CY - ARENA_RADIUS + halfH - ARENA_BUFFER, Math.min(ARENA_CY + ARENA_RADIUS - halfH + ARENA_BUFFER, cam.y))
  } else {
    cam.x = Math.max(halfW - ARENA_BUFFER, Math.min(ARENA_W + ARENA_BUFFER - halfW, cam.x))
    cam.y = Math.max(halfH - ARENA_BUFFER, Math.min(ARENA_H + ARENA_BUFFER - halfH, cam.y))
  }
}

/** Clamp a position inside the arena */
export function clampToArena(x: number, y: number, radius: number): { x: number; y: number } {
  if (arenaShape === 'cross') {
    return clampToCross(x, y, radius)
  }
  if (arenaShape === 'pill') {
    return clampToPill(x, y, radius)
  }
  if (arenaShape === 'hex') {
    return clampToHex(x, y, radius)
  }
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
    if (arenaShape === 'cross') {
      // Random point in one of the two arms
      if (Math.random() < 0.5) {
        // Horizontal arm
        x = ARENA_CX + (Math.random() - 0.5) * 2 * (CROSS_HE - 40)
        y = ARENA_CY + (Math.random() - 0.5) * 2 * (CROSS_HW - 40)
      } else {
        // Vertical arm
        x = ARENA_CX + (Math.random() - 0.5) * 2 * (CROSS_HW - 40)
        y = ARENA_CY + (Math.random() - 0.5) * 2 * (CROSS_HE - 40)
      }
    } else if (arenaShape === 'pill') {
      // Random point in pill shape
      const rx = (Math.random() - 0.5) * 2 * (PILL_HALF_W + PILL_R * 0.7)
      const ry = (Math.random() - 0.5) * 2 * PILL_R * 0.7
      const c = clampToPill(ARENA_CX + rx, ARENA_CY + ry, 40)
      x = c.x; y = c.y
    } else if (arenaShape === 'circle' || arenaShape === 'hex') {
      const angle = Math.random() * Math.PI * 2
      const dist = Math.random() * (ARENA_RADIUS * 0.8)
      x = ARENA_CX + Math.cos(angle) * dist
      y = ARENA_CY + Math.sin(angle) * dist
      // For hex, clamp inside
      if (arenaShape === 'hex') {
        const c = clampToHex(x, y, 40)
        x = c.x; y = c.y
      }
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
  if (arenaShape === 'cross') {
    return { x: ARENA_CX, y: ARENA_CY }
  }
  if (arenaShape === 'pill') {
    return { x: ARENA_CX, y: ARENA_CY + (Math.random() - 0.5) * PILL_R }
  }
  if (arenaShape === 'circle' || arenaShape === 'hex') {
    const angle = Math.random() * Math.PI * 2
    return { x: ARENA_CX + Math.cos(angle) * ARENA_RADIUS * 0.5, y: ARENA_CY + Math.sin(angle) * ARENA_RADIUS * 0.5 }
  }
  return { x: 80 + Math.random() * 100, y: 80 + Math.random() * 100 }
}

/** Check if a point is inside the arena */
export function isInArena(x: number, y: number): boolean {
  if (arenaShape === 'cross') return isInCross(x, y)
  if (arenaShape === 'pill') return isInPill(x, y)
  if (arenaShape === 'hex') return isInHex(x, y)
  if (arenaShape === 'circle') {
    const dx = x - ARENA_CX
    const dy = y - ARENA_CY
    return dx * dx + dy * dy <= ARENA_RADIUS * ARENA_RADIUS
  }
  return x >= 0 && x <= ARENA_W && y >= 0 && y <= ARENA_H
}

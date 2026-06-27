// Arena — fixed play area with Brotato-style camera
// Supports rectangle and circle shapes

import { ARENA_BUFFER, CAMERA_LEAD_AMOUNT, CAMERA_LEAD_GATE_K, CAMERA_LEAD_GATE_LO, CAMERA_LEAD_GATE_HI, CAMERA_LEAD_SMOOTH_K, CAMERA_FOLLOW_DEADZONE, PLAYER_RADIUS, PLAYER_SPEED } from '../utils/constants.ts'
import type { Enemy } from '../entities/Enemy.ts'

export type ArenaShape = 'rect' | 'circle' | 'hex' | 'pill' | 'cross' | 'polygon'

// ── Configuration ──
let arenaShape: ArenaShape = 'rect'
// Regular N-gon side count for the 'polygon' shape (triangle..dodecagon). circumradius = ARENA_RADIUS.
let polygonSides = 8
export function getPolygonSides(): number { return polygonSides }
export function setPolygonSides(n: number): void { polygonSides = Math.max(3, Math.min(12, Math.round(n))) }
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

// ── Regular N-gon geometry ──
// Circumradius = ARENA_RADIUS. Edge outward-normals sit at angles (π/2 + k·2π/N) — i.e. one edge
// is flat at the bottom (normal pointing +y). Vertices bisect adjacent normals (base = π/2 + π/N).
// At N=6 this reproduces the existing hex outline, so it's a clean generalization.
export function getPolygonVertices(cx: number, cy: number, r: number, sides: number): { x: number; y: number }[] {
  const verts: { x: number; y: number }[] = []
  const base = Math.PI / 2 + Math.PI / sides
  const stepA = (Math.PI * 2) / sides
  for (let i = 0; i < sides; i++) {
    const a = base + i * stepA
    verts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r })
  }
  return verts
}

/** Clamp a point inside the regular N-gon (single half-plane pass, mirrors clampToHex). */
function clampToPolygon(x: number, y: number, entityRadius: number): { x: number; y: number } {
  let rx = x - ARENA_CX
  let ry = y - ARENA_CY
  const sides = polygonSides
  const apothem = ARENA_RADIUS * Math.cos(Math.PI / sides) - entityRadius
  const stepA = (Math.PI * 2) / sides
  for (let k = 0; k < sides; k++) {
    const a = Math.PI / 2 + k * stepA
    const nx = Math.cos(a), ny = Math.sin(a)
    const dot = rx * nx + ry * ny
    if (dot > apothem) { rx -= (dot - apothem) * nx; ry -= (dot - apothem) * ny }
  }
  return { x: ARENA_CX + rx, y: ARENA_CY + ry }
}

function isInPolygon(x: number, y: number): boolean {
  const rx = x - ARENA_CX, ry = y - ARENA_CY
  const sides = polygonSides
  const apothem = ARENA_RADIUS * Math.cos(Math.PI / sides)
  const stepA = (Math.PI * 2) / sides
  for (let k = 0; k < sides; k++) {
    const a = Math.PI / 2 + k * stepA
    if (rx * Math.cos(a) + ry * Math.sin(a) > apothem) return false
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
  lastPlayerX: number  // for deriving actual player velocity (speed gate)
  lastPlayerY: number
  speedFrac: number    // low-passed fraction of full speed (0..1) — gates the lead
}

export function createCamera(): Camera {
  return { x: ARENA_CX, y: ARENA_CY, targetX: ARENA_CX, targetY: ARENA_CY, smoothLeadX: 0, smoothLeadY: 0, lastPlayerX: ARENA_CX, lastPlayerY: ARENA_CY, speedFrac: 0 }
}

export function updateCamera(
  cam: Camera,
  playerX: number,
  playerY: number,
  moveX: number,
  moveY: number,
  screenW: number,
  screenH: number,
  dt: number,
  zoom: number = 1
): void {
  // ── Speed gate ── derive the player's ACTUAL speed from frame-to-frame displacement (captures
  // dash, not just input) and low-pass it into speedFrac (0..1). A quick tap can't build speedFrac
  // up, so the lead stays suppressed on micro-movements (no forward-then-back bounce); sustained
  // running / dashing ramps it to full. (#1)
  const vx = dt > 0 ? (playerX - cam.lastPlayerX) / dt : 0
  const vy = dt > 0 ? (playerY - cam.lastPlayerY) / dt : 0
  cam.lastPlayerX = playerX
  cam.lastPlayerY = playerY
  // Target scales with ACTUAL speed and is allowed past 1 (cap 2.5) — a fast dash (≈2–3× walk speed)
  // drives the gate up quickly, while a same-direction tap (1× speed) stays well under LO, so dashes
  // get their lead but taps never do.
  const speedFracTarget = Math.min(2.5, Math.sqrt(vx * vx + vy * vy) / PLAYER_SPEED)
  cam.speedFrac += (speedFracTarget - cam.speedFrac) * (1 - Math.exp(-CAMERA_LEAD_GATE_K * dt))
  // Remap the gate so anything below LO produces ZERO lead (taps) and HI+ produces full lead.
  const gate = Math.max(0, Math.min(1, (cam.speedFrac - CAMERA_LEAD_GATE_LO) / (CAMERA_LEAD_GATE_HI - CAMERA_LEAD_GATE_LO)))

  // Lead — points along movement INPUT (stable intent), magnitude scaled by the gated speed.
  // Frame-rate-independent ramp via 1 - e^(-k·dt). (#3)
  const targetLeadX = moveX * CAMERA_LEAD_AMOUNT * gate
  const targetLeadY = moveY * CAMERA_LEAD_AMOUNT * gate
  const leadBlend = 1 - Math.exp(-CAMERA_LEAD_SMOOTH_K * dt)
  cam.smoothLeadX += (targetLeadX - cam.smoothLeadX) * leadBlend
  cam.smoothLeadY += (targetLeadY - cam.smoothLeadY) * leadBlend

  // ── Smooth follow with a small deadzone ── boost when far (fast dash). The deadzone makes the
  // camera hold perfectly still for sub-pixel/tiny movements (#2); the step is frame-rate-independent
  // and can never overshoot. (#3)
  cam.targetX = playerX + cam.smoothLeadX
  cam.targetY = playerY + cam.smoothLeadY
  const dx = cam.targetX - cam.x
  const dy = cam.targetY - cam.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist > CAMERA_FOLLOW_DEADZONE) {
    const smoothing = dist > 80 ? 6 + (dist - 80) * 0.08 : 6
    const step = 1 - Math.exp(-smoothing * dt)
    const reach = (dist - CAMERA_FOLLOW_DEADZONE) / dist  // close only the gap beyond the deadzone
    cam.x += dx * reach * step
    cam.y += dy * reach * step
  }

  // Clamp camera. Effective viewport in WORLD units = screen / zoom. With zoom < 1 the
  // viewport is wider in world units, so the camera can shift further from arena edges
  // without revealing void beyond the clamp range.
  const halfW = screenW / (2 * zoom)
  const halfH = screenH / (2 * zoom)

  // Per-axis bounds for the camera CENTER. When zoomed far out the viewport gets WIDER than the
  // arena on an axis, which makes lo > hi — clampAxis then centers on the arena midpoint instead
  // of snapping to a lopsided edge bound (the "off-center / askew" bug at near-max zoom-out).
  let loX: number, hiX: number, loY: number, hiY: number
  if (arenaShape === 'cross') {
    loX = ARENA_CX - CROSS_HE + halfW - ARENA_BUFFER; hiX = ARENA_CX + CROSS_HE - halfW + ARENA_BUFFER
    loY = ARENA_CY - CROSS_HE + halfH - ARENA_BUFFER; hiY = ARENA_CY + CROSS_HE - halfH + ARENA_BUFFER
  } else if (arenaShape === 'pill') {
    const pillLeft = ARENA_CX - PILL_HALF_W - PILL_R
    const pillRight = ARENA_CX + PILL_HALF_W + PILL_R
    const pillTop = ARENA_CY - PILL_R
    const pillBot = ARENA_CY + PILL_R
    loX = pillLeft + halfW - ARENA_BUFFER; hiX = pillRight - halfW + ARENA_BUFFER
    loY = pillTop + halfH - ARENA_BUFFER; hiY = pillBot - halfH + ARENA_BUFFER
  } else if (arenaShape === 'hex') {
    // Hex: width = 2R, height = R*√3 — clamp independently
    const hexHalfW = ARENA_RADIUS
    const hexHalfH = ARENA_RADIUS * Math.cos(Math.PI / 6)
    loX = ARENA_CX - hexHalfW + halfW - ARENA_BUFFER; hiX = ARENA_CX + hexHalfW - halfW + ARENA_BUFFER
    loY = ARENA_CY - hexHalfH + halfH - ARENA_BUFFER; hiY = ARENA_CY + hexHalfH - halfH + ARENA_BUFFER
  } else if (arenaShape === 'circle' || arenaShape === 'polygon') {
    // N-gon fits inside circumradius ARENA_RADIUS — bound the camera by that disc (conservative).
    loX = ARENA_CX - ARENA_RADIUS + halfW - ARENA_BUFFER; hiX = ARENA_CX + ARENA_RADIUS - halfW + ARENA_BUFFER
    loY = ARENA_CY - ARENA_RADIUS + halfH - ARENA_BUFFER; hiY = ARENA_CY + ARENA_RADIUS - halfH + ARENA_BUFFER
  } else {
    loX = halfW - ARENA_BUFFER; hiX = ARENA_W + ARENA_BUFFER - halfW
    loY = halfH - ARENA_BUFFER; hiY = ARENA_H + ARENA_BUFFER - halfH
  }
  cam.x = clampAxis(loX, hiX, cam.x)
  cam.y = clampAxis(loY, hiY, cam.y)
}

// Clamp v to [lo, hi]; but if the viewport is wider than the arena (lo > hi), center on the
// arena midpoint ((lo+hi)/2) rather than snapping to a lopsided edge.
function clampAxis(lo: number, hi: number, v: number): number {
  return lo <= hi ? Math.max(lo, Math.min(hi, v)) : (lo + hi) / 2
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
  if (arenaShape === 'polygon') {
    return clampToPolygon(x, y, radius)
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

/** Push a candidate spawn position away from immovable enemies and the player. */
export function findClearSpawnPos(x: number, y: number, radius: number, enemies: Enemy[], player: { x: number; y: number }): { x: number; y: number } {
  let sx = x, sy = y
  for (let pass = 0; pass < 3; pass++) {
    for (const enemy of enemies) {
      if (!enemy.alive || enemy.dying) continue
      if (!enemy.immovable) continue
      const dx = sx - enemy.x
      const dy = sy - enemy.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const minDist = radius + enemy.radius + 2
      if (dist < minDist && dist > 0.1) {
        const overlap = minDist - dist
        sx += (dx / dist) * overlap
        sy += (dy / dist) * overlap
      }
    }
    // Push out of walls too, with a small extra buffer so spawned entities don't immediately
    // overlap a wall surface.
    const wr = resolveWallCollision(sx, sy, radius + 2)
    sx = wr.x; sy = wr.y
    const pdx = sx - player.x
    const pdy = sy - player.y
    const pDist = Math.sqrt(pdx * pdx + pdy * pdy)
    const pMin = radius + PLAYER_RADIUS + 2
    if (pDist < pMin && pDist > 0.1) {
      const overlap = pMin - pDist
      sx += (pdx / pDist) * overlap
      sy += (pdy / pDist) * overlap
    }
  }
  return clampToArena(sx, sy, radius)
}

// ─────────────────────────────────────────────────────────────────────────────
// Walls — capsule colliders (line segment + radius) placed inside the arena.
// Single primitive covers lines, pillars (degenerate ax=bx,ay=by), and bent walls
// (multiple capsules sharing endpoints). Lives in the Arena module so movement code
// in Player/Enemy can resolve against them right next to clampToArena, and no part
// of the entity system needs to know walls exist.
// ─────────────────────────────────────────────────────────────────────────────
export interface Wall {
  ax: number; ay: number
  bx: number; by: number
  radius: number    // capsule thickness (half-width)
  bend?: number | undefined     // signed perpendicular bulge from chord midpoint; 0/undefined = straight
  motion?: WallMotion   // optional dynamic behavior; undefined = static wall
  translation?: WallTranslation   // optional path translation; stacks on top of motion rotation
  fade?: WallFade       // optional shrink/grow cycle; scales geometry per frame
  spring?: WallSpring   // optional rhythm spring; undefined = no launch impulse
  // Runtime fields — populated by setWalls on load, mutated by updateWalls each frame.
  // Persistence: when reading from JSON, only the authored fields above are present; the
  // runtime fields are derived and never saved. Designer always reads/writes the AUTHORED
  // (rest) fields directly so the user never sees an animated wall while editing.
  restAx?: number; restAy?: number; restBx?: number; restBy?: number; restBend?: number | undefined
  groupCenterX?: number; groupCenterY?: number
  // Group motion — propagated to every wall in the connected group from whichever wall in
  // the group has motion authored on it. Lets a single rotate config spin the whole shape
  // as a unit instead of one piece detaching and spinning alone.
  groupMotion?: WallMotion
  // Group translation — same propagation pattern as groupMotion. Lets a single translation
  // config move the whole connected shape along a path together.
  groupTranslation?: WallTranslation
  // Group fade — same propagation. Whole group shrinks/grows together.
  groupFade?: WallFade
  // Live fade scale 0..1 — computed each frame in updateWalls so the renderer + collision
  // helpers can multiply the wall's effective radius / endpoints without recomputing the
  // beat math. 1.0 if no fade config; 0 means wall is hidden.
  fadeSize?: number
  // Live fade phase — which segment of the fade cycle we're in this frame. Drives
  // collision-on/off: visible + grow → solid, shrink + hidden → intangible (so player can
  // walk through a vanishing wall at full speed, and gets pushed by a growing one).
  fadePhase?: 'visible' | 'shrink' | 'hidden' | 'grow'
  // Opt-out tag — when true, this wall is never grouped with neighbors (treated as a
  // singleton group regardless of proximity). Snap points are also suppressed so the
  // designer never snaps anything to/from this wall. Wall still functions normally as a
  // solid collider and runs its own motion / spring config.
  noClip?: boolean
  // Player-owned (Trailblaze) — wall drawn by the player at runtime. Once `playerGraceUntil`
  // passes, the wall is fully solid against the player (blocks like any other wall). Until
  // then, the player phases through it (prevents the wall from shoving the player forward
  // mid-dash since segments appear directly behind the player as they move).
  // Enemies and orbs always collide with it normally (grace doesn't apply to them).
  // Cleared on run restart. Replaced by next chain-dash's trail.
  playerOwned?: boolean
  playerGraceUntil?: number    // performance.now() timestamp; player phases through while < this
  dyingUntil?: number          // performance.now() timestamp; wall fades out + becomes permeable, then is culled (Trailblaze old-trail death)
  springLastFireBeat?: number          // absolute beat of most recent spring fire
  springJustFired?: boolean            // transient — set on fire frame, consumed by renderer for particle burst
  springScheduledAudioBeat?: number    // most recent beat we pre-scheduled audio for (avoid re-scheduling)
  zone?: WallZone                      // optional rhythm-locked damage/heal pulse out from the wall edge
  zoneLastFireBeat?: number            // absolute beat of most recent zone pulse (charge baseline)
  zoneJustFired?: boolean              // transient — set on fire frame, consumed by renderer for the burst flash
  zoneScheduledAudioBeat?: number      // most recent beat we pre-scheduled zone audio for
}

export interface WallMotion {
  type: 'rotate' | 'pendulum' | 'tick'   // continuous spin / smooth swing / discrete clock-tick
  beatsPerCycle?: number        // rotate = beats per revolution, pendulum = beats per A→B→A (default 4)
  direction?: 1 | -1            // rotate: CW vs CCW; pendulum: first swing direction; tick: step direction (default 1)
  phaseBeats?: number           // initial angle/phase offset in beats
  sweepDegrees?: number         // pendulum only — total swing range, swings ±sweepDegrees/2 around rest (default 90)
  // Pivot offset from the group's bbox center. (0,0) or undefined = rotate around bbox
  // center (default). Set to an offset (snapped to a wall snap point or free-placed) to
  // rotate around that point instead. Stored as offset-from-center so translation is free
  // (prefab drop, group move). Prefab rotation transforms this offset alongside wall coords.
  pivotOffsetX?: number
  pivotOffsetY?: number
  // Tick-only fields — discrete step rotation. Use beatsPerTick instead of beatsPerCycle.
  beatsPerTick?: number         // tick: how many beats between steps (default 1)
  degreesPerTick?: number       // tick: rotation per step in degrees (default 30 — clock second-hand)
  pauseFraction?: number        // tick: 0 = continuous motion within tick, 1 = instant snap (default 0.6)
  ticksBeforeReverse?: number   // tick: 0 = clock-rotates forever, N > 0 = reverses direction every N ticks
}

/** Translation motion — the entire wall (or group) moves along a path. Stacks on top of
 * any WallMotion rotation: rotation is applied first (around the rest pivot), then the
 * translation offset shifts the whole rotated shape. Both motions are beat-locked and
 * propagate to connected groups. */
export interface WallTranslation {
  type: 'horizontal' | 'vertical' | 'circle' | 'square'
  beatsPerCycle?: number   // beats per one full back-and-forth (linear) or orbit (circle/square) — default 4
  amplitude?: number        // linear: max distance from rest in either dir; circle: orbit radius; square: half-side (default 80)
  direction?: 1 | -1        // linear: which way first; circle/square: CW vs CCW (default 1)
  phaseBeats?: number       // start offset in beats
  ticked?: boolean          // false = smooth path, true = discrete tick stops (default false)
  pauseFraction?: number    // ticked only: fraction of each tick spent paused vs moving (default 0.6)
  // Ticked only — total stops per cycle. Linear: must be even (K/2 stops out + K/2 back, so
  // "stop 3 ticks before reversing" = tickCount 6). Circle/square: total stops around the loop.
  // Defaults: linear 2 (snap end-to-end), circle 4 (cardinal), square 4 (corners).
  tickCount?: number
}

/** Fade — wall periodically shrinks to nothing and grows back. Four independent timings
 * give full control over the rhythm. Cycle = visible + shrink + hidden + grow beats. While
 * shrinking/growing the wall's collision shape scales with the visual, so growing pushes
 * entities out of the expanding footprint via existing wall collision (no special logic). */
export interface WallFade {
  visibleBeats?: number    // time at full size (default 4)
  shrinkBeats?: number     // time spent shrinking from full to minSize (default 0.5)
  hiddenBeats?: number     // time at minSize (default 2) — name kept for save-compat; means "min-size dwell"
  growBeats?: number       // time spent growing from minSize back to full (default 0.5)
  phase?: number           // start offset in beats — lets multiple walls/groups desync
  // Minimum size the wall shrinks TO. 0 (default) = fully disappears. 0.3 = shrinks to 30%
  // of full size and stays there during the "hidden" phase, then grows back to 1.0.
  minSize?: number
  // Which dimensions of a capsule shrink. Pillars ignore (only the radius matters for them).
  //   'both' (default): endpoints collapse to midpoint AND radius shrinks — full disappear
  //   'width': only the radius shrinks; the spine stays full length (wall thins to a line)
  //   'length': only the endpoints collapse; the radius stays full (wall retracts to a pillar at midpoint)
  shrinkMode?: 'both' | 'width' | 'length'
}

/** Spring add-on — the wall fires a perpendicular launch impulse on a rhythm, shoving
 * anything in contact away from its surface. Same beat-cycle math as motion so two walls
 * can be synced or offset via the phase field. Strength is in px/s of launch velocity. */
export interface WallSpring {
  beatsPerCycle: number   // fires every N beats; fractional supported (0.5 = every off-beat at 2-beat cycle)
  phase: number           // beat offset, 0..beatsPerCycle (e.g. 0.5 with cycle=1 fires on every off-beat)
  strength: number        // launch impulse in px/s (200=gentle, 800=strong, 1500=catapult)
}

/** Zone add-on — the wall pulses a damage (or heal) band out from its surface on a rhythm.
 * The band is the wall's capsule grown outward by `range`; on each fire beat everything inside
 * takes 1 damage (or heals 1). Same beat-cycle math as spring/motion (sync or offset via phase).
 * Telegraph charges the band outward toward the edge over the cycle, bursting on the fire beat. */
export interface WallZone {
  mode: 'damage' | 'heal'  // damage = red band hurts; heal = gold band nourishes (player + enemies)
  range: number            // how far the band reaches OUT from the wall edge, in px
  beatsPerCycle: number    // pulses every N beats (fractional supported)
  phase: number            // beat offset, 0..beatsPerCycle
}

/** Arc geometry for a bent wall — center, radius, endpoint angles, and direction.
 * Returns null for straight walls (bend == 0) and degenerate pillars. */
export interface WallArc { cx: number; cy: number; r: number; aA: number; aB: number; antiClockwise: boolean }
export function computeWallArc(w: Wall): WallArc | null {
  const bend = w.bend ?? 0
  if (Math.abs(bend) < 0.5) return null
  const dx = w.bx - w.ax
  const dy = w.by - w.ay
  const L = Math.sqrt(dx * dx + dy * dy)
  if (L < 0.5) return null
  const mx = (w.ax + w.bx) / 2
  const my = (w.ay + w.by) / 2
  // Perpendicular (90° CCW in math coords; in canvas this points "down-ish" when chord is +x)
  const px = -dy / L
  const py = dx / L
  const sgn = bend >= 0 ? 1 : -1
  const absBend = Math.abs(bend)
  const half = L / 2
  const r = (absBend * absBend + half * half) / (2 * absBend)
  // h is signed: positive when arc is > semicircle (center on apex side), negative otherwise
  const h = (absBend * absBend - half * half) / (2 * absBend)
  const cx = mx + px * sgn * h
  const cy = my + py * sgn * h
  const aA = Math.atan2(w.ay - cy, w.ax - cx)
  const aB = Math.atan2(w.by - cy, w.bx - cx)
  // Pick the arc direction (A → B) that PASSES THROUGH THE APEX. Compute apex angle and
  // see which sweep direction covers it.
  const apexX = mx + px * bend
  const apexY = my + py * bend
  const apexAngle = Math.atan2(apexY - cy, apexX - cx)
  // Sweep from aA to aB going CCW (positive in math; canvas antiClockwise=true)
  let sweepCCW = aB - aA
  while (sweepCCW < 0) sweepCCW += 2 * Math.PI
  let sweepToApexCCW = apexAngle - aA
  while (sweepToApexCCW < 0) sweepToApexCCW += 2 * Math.PI
  // If apex sweep is within the CCW arc range from A to B, go CCW; else CW.
  const antiClockwise = sweepToApexCCW <= sweepCCW
  return { cx, cy, r, aA, aB, antiClockwise }
}

/** True if a given angle is on the arc (between aA and aB in the arc's direction). */
function angleOnArc(arc: WallArc, angle: number): boolean {
  // Sweep from aA toward aB in the arc's direction. Check if angle's sweep is within.
  let arcSweep: number
  let querySweep: number
  if (arc.antiClockwise) {
    // CCW: angles increase from aA to aB
    arcSweep = arc.aB - arc.aA
    while (arcSweep < 0) arcSweep += 2 * Math.PI
    querySweep = angle - arc.aA
    while (querySweep < 0) querySweep += 2 * Math.PI
  } else {
    // CW: angles decrease from aA to aB
    arcSweep = arc.aA - arc.aB
    while (arcSweep < 0) arcSweep += 2 * Math.PI
    querySweep = arc.aA - angle
    while (querySweep < 0) querySweep += 2 * Math.PI
  }
  return querySweep <= arcSweep
}

// Active wall list — populated from the active challenge (via setWalls) or empty by default.
// Designer authoring + per-challenge persistence is in ChallengeBuilder.
const walls: Wall[] = []

/** Player-drawn wall segments (Trailblaze upgrade). A chain-dash draws a sequence of thin
 * segments along the dash path (one per ~20px of motion) so the trail follows the actual
 * curve. The whole chain is cleared atomically when a new chain-dash starts. */
const playerWalls: Wall[] = []

/** Append a single thin wall segment for the active draw. Skip degenerate (too-short)
 * segments. Tagged playerOwned + noClip so the segment doesn't auto-group with neighbors
 * and doesn't expose snap points to the designer. */
export const TRAILBLAZE_PLAYER_GRACE_MS = 500
// Quick, quiet death animation for the OLD Trailblaze trail when a new chain-dash starts.
// Walls stop colliding immediately, fade alpha to 0 over this window, then get culled.
export const WALL_DEATH_DURATION_MS = 220
export function appendPlayerWall(ax: number, ay: number, bx: number, by: number, radius = 12): Wall | null {
  const dx = bx - ax, dy = by - ay
  if (dx * dx + dy * dy < 25) return null   // < 5px segment — not worth a wall
  const w: Wall = {
    ax, ay, bx, by, radius,
    restAx: ax, restAy: ay, restBx: bx, restBy: by,
    playerOwned: true,
    playerGraceUntil: performance.now() + TRAILBLAZE_PLAYER_GRACE_MS,
    noClip: true,
    fadeSize: 1,
  }
  walls.push(w)
  playerWalls.push(w)
  recomputeWallGroupCenters()
  return w
}

/** Clear ALL player-drawn wall segments. Called at the start of each new chain-dash and
 * on run restart / challenge load. Marks each wall as "dying" so it fades out gracefully
 * instead of popping — collision is disabled instantly, alpha fades over WALL_DEATH_DURATION_MS,
 * then updateWalls culls them. Stale references in playerWalls are dropped (the next chain-dash
 * starts a fresh trail). */
export function clearPlayerWalls(): void {
  if (playerWalls.length === 0) return
  const deathAt = performance.now() + WALL_DEATH_DURATION_MS
  for (const pw of playerWalls) {
    pw.dyingUntil = deathAt
  }
  playerWalls.length = 0
  recomputeWallGroupCenters()
}

export function getWalls(): readonly Wall[] { return walls }
export function setWalls(w: readonly Wall[]): void {
  // Deep copy so runtime motion updates don't pollute the designer's source data.
  walls.length = 0
  // setWalls replaces the entire walls array — any player-drawn segments are wiped along
  // with it. Clear the tracking array so future appendPlayerWall calls start fresh.
  playerWalls.length = 0
  for (const x of w) {
    const copy: Wall = {
      ax: x.ax, ay: x.ay, bx: x.bx, by: x.by, radius: x.radius,
      ...(x.bend != null ? { bend: x.bend } : {}),
      ...(x.motion ? { motion: { ...x.motion } } : {}),
      ...(x.translation ? { translation: { ...x.translation } } : {}),
      ...(x.fade ? { fade: { ...x.fade } } : {}),
      ...(x.spring ? { spring: { ...x.spring } } : {}),
      ...(x.zone ? { zone: { ...x.zone } } : {}),
      ...(x.noClip ? { noClip: true } : {}),
    }
    // Cache rest position so motion updates can rebuild live position from a known origin
    copy.restAx = copy.ax; copy.restAy = copy.ay
    copy.restBx = copy.bx; copy.restBy = copy.by
    copy.restBend = copy.bend ?? 0
    walls.push(copy)
  }
  // Precompute group centers — each connected component of walls shares a single pivot for
  // rotation (so an L-corner spins around its corner, not its individual midpoints).
  recomputeWallGroupCenters()
}

const JOIN_TOL_ARENA = 0.5
// Length threshold above which a capsule wall exposes 5 snap points (endpoints + quarter
// points + midpoint) instead of 3 (endpoints + midpoint). Below this length the quarter
// points would overlap with the endpoints visually so 3 is enough.
export const SNAP_POINT_5_THRESHOLD = 40
/** Compute the snap points along the wall's REST geometry. These are the positions where
 * other walls' snap points can connect to form a connected group, and where the designer
 * snaps cursor-to-existing during placement.
 *   - pillar (ax≈bx, ay≈by): 1 point at center
 *   - short capsule (len < threshold): 3 points along spine (0%, 50%, 100%)
 *   - long capsule (len ≥ threshold): 5 points (0%, 25%, 50%, 75%, 100%)
 *   - noClip wall: always [] (excluded from all connection logic) */
export function getWallSnapPoints(w: Wall): Array<{ x: number; y: number }> {
  if (w.noClip) return []
  const ax = w.restAx ?? w.ax, ay = w.restAy ?? w.ay
  const bx = w.restBx ?? w.bx, by = w.restBy ?? w.by
  const dx = bx - ax, dy = by - ay
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 0.5) return [{ x: ax, y: ay }]   // pillar
  if (len < SNAP_POINT_5_THRESHOLD) {
    return [
      { x: ax, y: ay },
      { x: ax + dx * 0.5, y: ay + dy * 0.5 },
      { x: bx, y: by },
    ]
  }
  return [
    { x: ax, y: ay },
    { x: ax + dx * 0.25, y: ay + dy * 0.25 },
    { x: ax + dx * 0.5,  y: ay + dy * 0.5  },
    { x: ax + dx * 0.75, y: ay + dy * 0.75 },
    { x: bx, y: by },
  ]
}

function recomputeWallGroupCenters(): void {
  const n = walls.length
  const groupOf = new Array<number>(n).fill(-1)
  let nextGroup = 0
  // Pre-compute snap points per wall (small alloc, but only on geometry changes — not
  // a per-frame thing). noClip walls get empty arrays so they never match anything.
  const snapPoints = walls.map(w => getWallSnapPoints(w))
  const tol2 = JOIN_TOL_ARENA * JOIN_TOL_ARENA
  for (let i = 0; i < n; i++) {
    if (groupOf[i] !== -1) continue
    groupOf[i] = nextGroup
    const stack: number[] = [i]
    while (stack.length > 0) {
      const cur = stack.pop()!
      const aPts = snapPoints[cur]!
      if (aPts.length === 0) continue   // noClip — isolated
      for (let j = 0; j < n; j++) {
        if (groupOf[j] !== -1) continue
        const bPts = snapPoints[j]!
        if (bPts.length === 0) continue
        let matched = false
        outer: for (const ap of aPts) {
          for (const bp of bPts) {
            const ddx = ap.x - bp.x, ddy = ap.y - bp.y
            if (ddx * ddx + ddy * ddy < tol2) { matched = true; break outer }
          }
        }
        if (matched) {
          groupOf[j] = nextGroup
          stack.push(j)
        }
      }
    }
    nextGroup++
  }
  // Compute bbox center per group, write to each wall in that group
  const groupBounds: Array<{ minX: number; maxX: number; minY: number; maxY: number }> = []
  for (let g = 0; g < nextGroup; g++) groupBounds.push({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity })
  for (let i = 0; i < n; i++) {
    const w = walls[i]!
    const g = groupOf[i]!
    const gb = groupBounds[g]!
    gb.minX = Math.min(gb.minX, w.restAx!, w.restBx!)
    gb.maxX = Math.max(gb.maxX, w.restAx!, w.restBx!)
    gb.minY = Math.min(gb.minY, w.restAy!, w.restBy!)
    gb.maxY = Math.max(gb.maxY, w.restAy!, w.restBy!)
  }
  for (let i = 0; i < n; i++) {
    const w = walls[i]!
    const gb = groupBounds[groupOf[i]!]!
    w.groupCenterX = (gb.minX + gb.maxX) / 2
    w.groupCenterY = (gb.minY + gb.maxY) / 2
  }
  // Per-group motion — first wall in each group with `motion` set becomes the leader; its
  // motion config is copied onto every other wall in the group via `groupMotion`. updateWalls
  // reads groupMotion (not motion) so the whole connected shape spins together.
  const groupMotionByG: Array<WallMotion | undefined> = new Array(nextGroup).fill(undefined)
  for (let i = 0; i < n; i++) {
    const g = groupOf[i]!
    if (groupMotionByG[g]) continue
    if (walls[i]!.motion) groupMotionByG[g] = walls[i]!.motion
  }
  for (let i = 0; i < n; i++) {
    const gm = groupMotionByG[groupOf[i]!]
    if (gm) walls[i]!.groupMotion = gm
    else delete walls[i]!.groupMotion
  }
  // Same propagation for translation — find any wall in each group with a translation
  // config, copy onto every wall in the group via groupTranslation.
  const groupTransByG: Array<WallTranslation | undefined> = new Array(nextGroup).fill(undefined)
  for (let i = 0; i < n; i++) {
    const g = groupOf[i]!
    if (groupTransByG[g]) continue
    if (walls[i]!.translation) groupTransByG[g] = walls[i]!.translation
  }
  for (let i = 0; i < n; i++) {
    const gt = groupTransByG[groupOf[i]!]
    if (gt) walls[i]!.groupTranslation = gt
    else delete walls[i]!.groupTranslation
  }
  // Same for fade — whole group shrinks/grows in sync.
  const groupFadeByG: Array<WallFade | undefined> = new Array(nextGroup).fill(undefined)
  for (let i = 0; i < n; i++) {
    const g = groupOf[i]!
    if (groupFadeByG[g]) continue
    if (walls[i]!.fade) groupFadeByG[g] = walls[i]!.fade
  }
  for (let i = 0; i < n; i++) {
    const gf = groupFadeByG[groupOf[i]!]
    if (gf) walls[i]!.groupFade = gf
    else delete walls[i]!.groupFade
  }
}

/** Snap every wall's live ax/ay/bx/by back to its authored rest position. Used by the
 * designer zoom-out toggle so the editor view always matches the saved data. */
export function resetWallsToRest(): void {
  for (const w of walls) {
    if (w.restAx != null) {
      w.ax = w.restAx
      w.ay = w.restAy!
      w.bx = w.restBx!
      w.by = w.restBy!
      w.bend = w.restBend
    }
  }
}

// Spring fires queued by updateWalls each frame, drained by GameManager to apply launch
// impulses to overlapping entities. Each fire references the wall (so the consumer can
// recompute the contact normal and use the live position) plus the cumulative dt of the
// frame so a launch lasts the same wall-clock time regardless of frame rate.
export interface SpringFire { wall: Wall; targetBeat: number }
const pendingSpringFires: SpringFire[] = []
export function consumeSpringFires(): SpringFire[] {
  if (pendingSpringFires.length === 0) return []
  const out = pendingSpringFires.slice()
  pendingSpringFires.length = 0
  return out
}

// Zone pulses queued by updateWalls each frame, drained by GameManager to apply damage/heal to
// entities inside the wall's band. Mirrors the spring-fire queue.
export interface ZoneFire { wall: Wall; targetBeat: number }
const pendingZoneFires: ZoneFire[] = []
export function consumeZoneFires(): ZoneFire[] {
  if (pendingZoneFires.length === 0) return []
  const out = pendingZoneFires.slice()
  pendingZoneFires.length = 0
  return out
}

/** Per-frame motion update — recomputes live ax/ay/bx/by from rest + motion params + beatPos.
 * Also detects spring fires and queues them for GameManager to apply.
 * beatPos is a monotonic absolute beat counter (not modulo loop). */
export function updateWalls(beatPos: number): void {
  // Cull walls whose death animation completed (Trailblaze old-trail teardown). Walks
  // backward so splice doesn't shift unread indices.
  const nowMs = performance.now()
  for (let i = walls.length - 1; i >= 0; i--) {
    const w = walls[i]!
    if (w.dyingUntil != null && nowMs >= w.dyingUntil) {
      walls.splice(i, 1)
    }
  }
  for (const w of walls) {
    // Motion — recompute live position from rest + angle. Uses groupMotion (propagated
    // from any wall in the connected group with `motion` set) so every wall in the group
    // moves as a single rigid body around the shared group center. The angle calculation
    // differs by motion type but the cos/sin transform applied to the rest position is
    // identical, so we compute angle first and then run the shared transform.
    const motion = w.groupMotion
    let angle: number | null = null
    if (motion?.type === 'rotate') {
      const beatsPerCycle = motion.beatsPerCycle ?? 4
      const direction = motion.direction ?? 1
      const phase = motion.phaseBeats ?? 0
      angle = ((beatPos + phase) / beatsPerCycle) * Math.PI * 2 * direction
    } else if (motion?.type === 'pendulum') {
      const beatsPerCycle = motion.beatsPerCycle ?? 4
      const direction = motion.direction ?? 1
      const phase = motion.phaseBeats ?? 0
      const sweepHalfRad = ((motion.sweepDegrees ?? 90) / 2) * (Math.PI / 180)
      // Sine sweep: starts at rest angle (0), peaks at +sweepHalf after 1/4 cycle, back
      // through rest at 1/2 cycle, peaks at -sweepHalf at 3/4 cycle. Smooth velocity through
      // rest, slowest at the turnarounds — natural pendulum feel.
      angle = sweepHalfRad * direction * Math.sin(((beatPos + phase) / beatsPerCycle) * Math.PI * 2)
    } else if (motion?.type === 'tick') {
      // Discrete clock-tick rotation. Each tick = one step of `degreesPerTick`. Within each
      // tick, motion happens in the first (1 - pauseFraction) of the interval using ease-out
      // cubic (snaps in, settles into the pause). After the motion, the wall holds position
      // until the next tick. If `ticksBeforeReverse > 0`, direction zigzags: forward N ticks,
      // then back N ticks (step-by-step, no snap-back).
      const beatsPerTick = motion.beatsPerTick ?? 1
      const degreesPerTick = motion.degreesPerTick ?? 30
      const pauseFraction = Math.max(0, Math.min(1, motion.pauseFraction ?? 0.6))
      const reverseEvery = motion.ticksBeforeReverse ?? 0
      const direction = motion.direction ?? 1
      const phase = motion.phaseBeats ?? 0
      if (beatsPerTick > 0) {
        const tCont = (beatPos + phase) / beatsPerTick      // continuous tick position
        const tickIdx = Math.floor(tCont)                   // which discrete tick we're in
        const within = tCont - tickIdx                       // 0..1 progress inside current tick
        // Ease-out cubic for the moving portion of the tick. Compressed to the (1-pauseFraction)
        // window — beyond that, motion is complete and the wall sits at the next tick's angle.
        const moveDur = Math.max(0.001, 1 - pauseFraction)
        const raw = Math.min(1, within / moveDur)
        const moveProgress = 1 - Math.pow(1 - raw, 3)       // ease-out cubic
        // Resolve the virtual tick position with reversal zigzag.
        let virtualTick: number, currentSign: number
        if (reverseEvery <= 0) {
          virtualTick = tickIdx
          currentSign = 1
        } else {
          const cycle = reverseEvery * 2
          const inCycle = ((tickIdx % cycle) + cycle) % cycle    // handle negative beats from phase
          virtualTick = inCycle < reverseEvery ? inCycle : (cycle - inCycle)
          currentSign = inCycle < reverseEvery ? 1 : -1
        }
        const partialTick = virtualTick + moveProgress * currentSign
        angle = partialTick * degreesPerTick * direction * (Math.PI / 180)
      }
    }
    if (angle !== null) {
      const cos = Math.cos(angle), sin = Math.sin(angle)
      // Pivot = bbox center + optional offset. (0,0) offset → pivot AT bbox center (default).
      const cx = w.groupCenterX! + (motion!.pivotOffsetX ?? 0)
      const cy = w.groupCenterY! + (motion!.pivotOffsetY ?? 0)
      const ax0 = w.restAx! - cx, ay0 = w.restAy! - cy
      const bx0 = w.restBx! - cx, by0 = w.restBy! - cy
      w.ax = cx + ax0 * cos - ay0 * sin
      w.ay = cy + ax0 * sin + ay0 * cos
      w.bx = cx + bx0 * cos - by0 * sin
      w.by = cy + bx0 * sin + by0 * cos
      w.bend = w.restBend
    } else if (w.groupTranslation || w.groupFade) {
      // No rotation but HAS translation or fade — start from rest so the position-mutating
      // passes below operate on a known baseline. Otherwise we'd accumulate the previous
      // frame's translation/fade offsets and the wall would drift / shrink permanently.
      w.ax = w.restAx!; w.ay = w.restAy!
      w.bx = w.restBx!; w.by = w.restBy!
    }
    // Translation — applied AFTER rotation, shifts the entire (already-rotated or rest)
    // shape by (tx, ty). Stacks naturally with motion: rotated shape orbits, swings, etc.
    const translation = w.groupTranslation
    if (translation) {
      const beatsPerCycle = translation.beatsPerCycle ?? 4
      const amp = translation.amplitude ?? 80
      const dir = translation.direction ?? 1
      const phase = translation.phaseBeats ?? 0
      const ticked = translation.ticked ?? false
      const pauseFraction = Math.max(0, Math.min(1, translation.pauseFraction ?? 0.6))
      let tx = 0, ty = 0
      if (beatsPerCycle > 0) {
        const tCont = (beatPos + phase) / beatsPerCycle    // continuous progress (0..1 per cycle)
        // For ticked modes we need a tick index + within-tick progress to apply ease-out.
        let cycleProgress = tCont - Math.floor(tCont)      // 0..1 wrapped
        if (cycleProgress < 0) cycleProgress += 1
        // Shared tick helper — returns the eased progress within the current tick and the
        // pair of tick indices to interpolate between. Used for all ticked variants below.
        const tickedSetup = (totalTicks: number) => {
          const tickFloat = cycleProgress * totalTicks
          const tickIdx = Math.floor(tickFloat) % totalTicks
          const within = tickFloat - Math.floor(tickFloat)
          const moveDur = Math.max(0.001, 1 - pauseFraction)
          const raw = Math.min(1, within / moveDur)
          const eased = 1 - Math.pow(1 - raw, 3)
          return { tickIdx, nextIdx: (tickIdx + 1) % totalTicks, eased }
        }
        // Linear position helper: given K total ticks (even), returns position along the
        // back-and-forth path at tick index `idx`. K=2: -amp,+amp. K=6: -amp,-amp/3,+amp/3,+amp,+amp/3,-amp/3.
        const linearPos = (idx: number, K: number) => {
          const halfK = K / 2
          const step = (2 * amp) / halfK
          if (idx <= halfK) return -amp + step * idx
          return -amp + step * (K - idx)
        }
        // Circle position helper: orbit center is `amp` north of rest (so the wall passes
        // through rest at t=0). Tick idx → angle around orbit.
        const circlePos = (idx: number, K: number) => {
          const angle = (idx / K) * Math.PI * 2 * dir
          return { x: amp * Math.sin(angle), y: amp * (Math.cos(angle) - 1) }
        }
        // Square position helper: tick idx → position on perimeter (rest = one corner).
        // K stops evenly distributed around perimeter. dir reverses traversal.
        const squarePos = (idx: number, K: number) => {
          const tt = idx / K
          const dirT = dir > 0 ? tt : (1 - tt + 1) % 1   // reverse direction
          const d = dirT * 4 * amp
          if (d < amp) return { x: d, y: 0 }
          if (d < 2 * amp) return { x: amp, y: -(d - amp) }
          if (d < 3 * amp) return { x: amp - (d - 2 * amp), y: -amp }
          return { x: 0, y: -amp + (d - 3 * amp) }
        }

        if (translation.type === 'horizontal') {
          if (ticked) {
            // K must be even — round up if user passes odd. Min 2.
            let K = Math.max(2, translation.tickCount ?? 2)
            if (K % 2 !== 0) K++
            const { tickIdx, nextIdx, eased } = tickedSetup(K)
            const from = linearPos(tickIdx, K)
            const to = linearPos(nextIdx, K)
            tx = (from + (to - from) * eased) * dir
          } else {
            tx = amp * dir * Math.sin(cycleProgress * Math.PI * 2)
          }
        } else if (translation.type === 'vertical') {
          if (ticked) {
            let K = Math.max(2, translation.tickCount ?? 2)
            if (K % 2 !== 0) K++
            const { tickIdx, nextIdx, eased } = tickedSetup(K)
            const from = linearPos(tickIdx, K)
            const to = linearPos(nextIdx, K)
            ty = (from + (to - from) * eased) * dir
          } else {
            ty = amp * dir * Math.sin(cycleProgress * Math.PI * 2)
          }
        } else if (translation.type === 'circle') {
          if (ticked) {
            const K = Math.max(2, translation.tickCount ?? 4)
            const { tickIdx, nextIdx, eased } = tickedSetup(K)
            const from = circlePos(tickIdx, K)
            const to = circlePos(nextIdx, K)
            tx = from.x + (to.x - from.x) * eased
            ty = from.y + (to.y - from.y) * eased
          } else {
            const angle = cycleProgress * Math.PI * 2 * dir
            tx = amp * Math.sin(angle)
            ty = amp * (Math.cos(angle) - 1)
          }
        } else if (translation.type === 'square') {
          if (ticked) {
            const K = Math.max(4, translation.tickCount ?? 4)
            const { tickIdx, nextIdx, eased } = tickedSetup(K)
            const from = squarePos(tickIdx, K)
            const to = squarePos(nextIdx, K)
            tx = from.x + (to.x - from.x) * eased
            ty = from.y + (to.y - from.y) * eased
          } else {
            // Smooth continuous perimeter sweep — uses squarePos at any fractional position.
            const from = squarePos(cycleProgress, 1)
            tx = from.x; ty = from.y
          }
        }
      }
      if (tx !== 0 || ty !== 0) {
        w.ax += tx; w.ay += ty
        w.bx += tx; w.by += ty
      }
    }
    // Fade — compute 0..1 base size from beat phase, then derive widthFade and lengthFade
    // based on shrinkMode. widthFade scales the radius (collision + rendering width).
    // lengthFade scales the endpoints toward midpoint (capsule length collapse). Splitting
    // them lets the user pick: shrink both dims, just width (becomes a hairline), or just
    // length (collapses to a midpoint pillar). Pillars only care about widthFade.
    const fade = w.groupFade
    let baseSize = 1
    let fadePhase: 'visible' | 'shrink' | 'hidden' | 'grow' = 'visible'
    if (fade) {
      const vis = Math.max(0, fade.visibleBeats ?? 4)
      const shr = Math.max(0.001, fade.shrinkBeats ?? 0.5)
      const hid = Math.max(0, fade.hiddenBeats ?? 2)
      const grw = Math.max(0.001, fade.growBeats ?? 0.5)
      const phs = fade.phase ?? 0
      const minSize = Math.max(0, Math.min(1, fade.minSize ?? 0))   // shrink target (0 = full disappear)
      const cycle = vis + shr + hid + grw
      if (cycle > 0) {
        let p = ((beatPos + phs) % cycle + cycle) % cycle
        let size: number
        // Lerp range: full size (1) ↔ minSize. Shrink goes 1 → minSize, grow goes minSize → 1.
        if (p < vis) { size = 1; fadePhase = 'visible' }
        else if (p < vis + shr) { size = 1 - (p - vis) / shr * (1 - minSize); fadePhase = 'shrink' }
        else if (p < vis + shr + hid) { size = minSize; fadePhase = 'hidden' }
        else { size = minSize + (p - vis - shr - hid) / grw * (1 - minSize); fadePhase = 'grow' }
        baseSize = Math.max(0, Math.min(1, size))
      }
    }
    w.fadePhase = fadePhase
    const mode = fade?.shrinkMode ?? 'both'
    const widthFade = mode === 'length' ? 1 : baseSize
    const lengthFade = mode === 'width' ? 1 : baseSize
    w.fadeSize = widthFade
    // Apply length fade — scale endpoints toward the wall's midpoint. At lengthFade=1, no
    // change. At lengthFade=0, both endpoints collapse to the midpoint. For pillars the
    // midpoint IS the endpoint, so this is automatically a no-op there.
    if (lengthFade < 1) {
      const mx = (w.ax + w.bx) / 2
      const my = (w.ay + w.by) / 2
      w.ax = mx + (w.ax - mx) * lengthFade
      w.ay = my + (w.ay - my) * lengthFade
      w.bx = mx + (w.bx - mx) * lengthFade
      w.by = my + (w.by - my) * lengthFade
    }
    // Spring — detect beat crossings and queue a fire.
    // CRITICAL: align fires to the same audio offset every other rhythm-locked sound uses.
    // The music scheduler (BeatLoop) schedules kick/snare/etc at `nextBeatTime + 0.37s`,
    // and danger melody also uses +0.37s (see AudioEngine.playDangerNote). That 0.37 is
    // the game's effective "perceived beat" offset — the audio time when each beat's
    // primary percussion hits. Springs need to fire on the SAME offset to feel locked in
    // with the rest of the music. (Was 0.45, matching the ring visual peak — but the user
    // locks to the audio kick, not the visual ring peak, so 0.45 felt 80ms late.)
    if (w.spring) {
      const beatsPerCycle = w.spring.beatsPerCycle
      const phase = w.spring.phase ?? 0
      if (beatsPerCycle > 0) {
        const BEAT_AUDIO_OFFSET = 0.37  // matches BeatLoop's +0.37s schedule offset
        const effectivePhase = phase + BEAT_AUDIO_OFFSET
        let nextFire: number
        if (w.springLastFireBeat == null) {
          nextFire = Math.ceil((beatPos - effectivePhase) / beatsPerCycle) * beatsPerCycle + effectivePhase
          if (nextFire <= beatPos) nextFire += beatsPerCycle
          w.springLastFireBeat = nextFire - beatsPerCycle
        } else {
          nextFire = w.springLastFireBeat + beatsPerCycle
        }
        if (beatPos >= nextFire) {
          pendingSpringFires.push({ wall: w, targetBeat: nextFire })
          w.springLastFireBeat = nextFire
          w.springJustFired = true   // renderer consumes this for the one-shot particle burst
        }
      }
    }
    // Zone pulse — identical beat-crossing detection to the spring, on the same audio offset so
    // the damage/heal burst lands locked to the music. zoneLastFireBeat doubles as the renderer's
    // charge baseline (band fills outward over the cycle since the last pulse).
    if (w.zone) {
      const beatsPerCycle = w.zone.beatsPerCycle
      const phase = w.zone.phase ?? 0
      if (beatsPerCycle > 0) {
        const BEAT_AUDIO_OFFSET = 0.37
        const effectivePhase = phase + BEAT_AUDIO_OFFSET
        let nextFire: number
        if (w.zoneLastFireBeat == null) {
          nextFire = Math.ceil((beatPos - effectivePhase) / beatsPerCycle) * beatsPerCycle + effectivePhase
          if (nextFire <= beatPos) nextFire += beatsPerCycle
          w.zoneLastFireBeat = nextFire - beatsPerCycle
        } else {
          nextFire = w.zoneLastFireBeat + beatsPerCycle
        }
        if (beatPos >= nextFire) {
          pendingZoneFires.push({ wall: w, targetBeat: nextFire })
          w.zoneLastFireBeat = nextFire
          w.zoneJustFired = true   // renderer consumes this for the one-shot burst flash
        }
      }
    }
  }
}

/**
 * Circle-vs-capsule push-out. Each wall is either a straight capsule (segment + radius) or
 * an arc capsule (when wall.bend != 0). For the arc case the closest point on the arc is
 * computed and the entity is pushed away from the arc curve. Degenerate cases handled:
 * zero-length segment = pillar; entity center exactly on the curve = push perpendicular.
 */
export function resolveWallCollision(x: number, y: number, radius: number, isPlayer: boolean = false): { x: number; y: number } {
  let rx = x, ry = y
  for (const w of walls) {
    // Trailblaze — player phases through their own walls ONLY during the grace window
    // right after each segment is laid down. Without grace the wall would shove the player
    // forward as it materializes behind them (rocketing the dash absurdly far). After
    // grace expires, the wall becomes fully solid against the player too.
    // Enemies and orbs always collide (grace doesn't apply to them).
    if (isPlayer && w.playerOwned && w.playerGraceUntil != null && performance.now() < w.playerGraceUntil) continue
    // Dying walls (old Trailblaze trail mid fade-out) are immediately permeable to everything.
    if (w.dyingUntil != null) continue
    // Fade — collision is always ON, but BOTH the detection radius AND the push strength
    // scale with fadeSize. Detection: effRadius = w.radius * fadeSize (matches visual).
    // Push: applied push = full_push * fadeSize (weakens during shrink/grow).
    //   visible (fadeSize=1): full push — wall acts as solid obstacle
    //   shrink (fadeSize → 0): push weakens — player can push through with growing ease,
    //     speed transitions from wall-shrink-rate (blocked) to full player speed (free)
    //   hidden (fadeSize=0):   collision skipped — wall isn't there
    //   grow (fadeSize 0 → 1): push strengthens — wall progressively pushes player out
    // The result is "physical fade" — wall solidity tracks its visual size smoothly without
    // either capping player motion at the slow shrink rate OR letting them blast through.
    const fadeSize = w.fadeSize ?? 1
    if (fadeSize < 0.05) continue
    const effRadius = w.radius * fadeSize
    const pushFactor = fadeSize
    const arc = computeWallArc(w)
    if (arc) {
      // Closest point on the arc to (rx, ry). If the entity's angle from the arc center is
      // within the arc's angular range, the closest point is on the curve; otherwise it's
      // the nearer endpoint.
      const dxc = rx - arc.cx
      const dyc = ry - arc.cy
      const distC = Math.sqrt(dxc * dxc + dyc * dyc)
      const queryAngle = Math.atan2(dyc, dxc)
      let cx: number, cy: number
      if (distC < 0.01) {
        // Entity at arc center — degenerate; push along start direction
        cx = arc.cx + arc.r * Math.cos(arc.aA)
        cy = arc.cy + arc.r * Math.sin(arc.aA)
      } else if (angleOnArc(arc, queryAngle)) {
        // Closest is on the curve, in the direction of the entity from center
        cx = arc.cx + (dxc / distC) * arc.r
        cy = arc.cy + (dyc / distC) * arc.r
      } else {
        // Closest is one of the two endpoints
        const da2 = (rx - w.ax) ** 2 + (ry - w.ay) ** 2
        const db2 = (rx - w.bx) ** 2 + (ry - w.by) ** 2
        if (da2 <= db2) { cx = w.ax; cy = w.ay } else { cx = w.bx; cy = w.by }
      }
      const dx = rx - cx
      const dy = ry - cy
      const dist2 = dx * dx + dy * dy
      const minDist = effRadius + radius
      if (dist2 < minDist * minDist) {
        const dist = Math.sqrt(dist2)
        if (dist > 0.01) {
          const push = (minDist - dist) * pushFactor
          rx += (dx / dist) * push
          ry += (dy / dist) * push
        } else {
          // On the curve exactly — push outward from arc center
          const outDX = cx - arc.cx
          const outDY = cy - arc.cy
          const outLen = Math.sqrt(outDX * outDX + outDY * outDY) || 1
          rx += (outDX / outLen) * minDist * pushFactor
          ry += (outDY / outLen) * minDist * pushFactor
        }
      }
      continue
    }
    // Straight wall (capsule)
    const abx = w.bx - w.ax
    const aby = w.by - w.ay
    const apx = rx - w.ax
    const apy = ry - w.ay
    const ab2 = abx * abx + aby * aby
    let t = 0
    if (ab2 > 0.01) {
      t = (apx * abx + apy * aby) / ab2
      if (t < 0) t = 0
      else if (t > 1) t = 1
    }
    const cx = w.ax + abx * t
    const cy = w.ay + aby * t
    const dx = rx - cx
    const dy = ry - cy
    const dist2 = dx * dx + dy * dy
    const minDist = effRadius + radius
    if (dist2 < minDist * minDist) {
      const dist = Math.sqrt(dist2)
      if (dist > 0.01) {
        const push = (minDist - dist) * pushFactor
        rx += (dx / dist) * push
        ry += (dy / dist) * push
      } else {
        // Center exactly on the segment — push perpendicular to AB (or up for a pillar).
        const segLen = Math.sqrt(ab2)
        if (segLen > 0.01) {
          rx += (-aby / segLen) * minDist * pushFactor
          ry += (abx / segLen) * minDist * pushFactor
        } else {
          ry -= minDist * pushFactor
        }
      }
    }
  }
  return { x: rx, y: ry }
}

/** Get a random spawn position inside the arena, min distance from player.
 * If no random attempt clears `minDist`, returns the FARTHEST attempt found instead of a
 * fixed-corner fallback — so if the requested distance is geometrically impossible (e.g.
 * minDist=1000 in a 1700x1100 arena with a centered player), we still get the best
 * available spawn far from the player rather than collapsing back to near them. */
export function getSpawnPos(playerX: number, playerY: number, minDist = 250): { x: number; y: number } {
  let bestX = playerX, bestY = playerY, bestD2 = -1
  const ATTEMPTS = 30
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let x: number, y: number
    if (arenaShape === 'cross') {
      if (Math.random() < 0.5) {
        x = ARENA_CX + (Math.random() - 0.5) * 2 * (CROSS_HE - 40)
        y = ARENA_CY + (Math.random() - 0.5) * 2 * (CROSS_HW - 40)
      } else {
        x = ARENA_CX + (Math.random() - 0.5) * 2 * (CROSS_HW - 40)
        y = ARENA_CY + (Math.random() - 0.5) * 2 * (CROSS_HE - 40)
      }
    } else if (arenaShape === 'pill') {
      const rx = (Math.random() - 0.5) * 2 * (PILL_HALF_W + PILL_R * 0.7)
      const ry = (Math.random() - 0.5) * 2 * PILL_R * 0.7
      const c = clampToPill(ARENA_CX + rx, ARENA_CY + ry, 40)
      x = c.x; y = c.y
    } else if (arenaShape === 'circle' || arenaShape === 'hex' || arenaShape === 'polygon') {
      const angle = Math.random() * Math.PI * 2
      // Was 0.8 — too restrictive. Use 0.95 so spawns can reach near the arena edge.
      const dist = Math.random() * (ARENA_RADIUS * 0.95)
      x = ARENA_CX + Math.cos(angle) * dist
      y = ARENA_CY + Math.sin(angle) * dist
      if (arenaShape === 'hex') {
        const c = clampToHex(x, y, 40)
        x = c.x; y = c.y
      } else if (arenaShape === 'polygon') {
        const c = clampToPolygon(x, y, 40)
        x = c.x; y = c.y
      }
    } else {
      const margin = 80
      x = margin + Math.random() * (ARENA_W - margin * 2)
      y = margin + Math.random() * (ARENA_H - margin * 2)
    }
    const dx = x - playerX
    const dy = y - playerY
    const d2 = dx * dx + dy * dy
    if (d2 > minDist * minDist) return { x, y }
    if (d2 > bestD2) { bestD2 = d2; bestX = x; bestY = y }
  }
  // No attempt cleared minDist — return the farthest valid arena point we found instead of
  // collapsing back to a fixed-corner fallback (which would land close to the player).
  return { x: bestX, y: bestY }
}

/** Get a spawn position along the OUTER PERIMETER of the arena. Used for designer
 * spawn-test enemies so they always appear at the edges of the play area, no matter where
 * the player is. Honors a minimum distance from the player as a safety fallback in case
 * the player is also at the perimeter — picks the farthest perimeter point in that case. */
export function getPerimeterSpawnPos(playerX: number, playerY: number, minDistFromPlayer = 300): { x: number; y: number } {
  let bestX = playerX, bestY = playerY, bestD2 = -1
  const ATTEMPTS = 30
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let x: number, y: number
    if (arenaShape === 'cross') {
      // Spawn near one of the four arm tips
      const side = Math.floor(Math.random() * 4)
      const acrossArm = (Math.random() - 0.5) * 2 * (CROSS_HW - 50)
      const tipDist = CROSS_HE * (0.78 + Math.random() * 0.15)
      if (side === 0)      { x = ARENA_CX + acrossArm; y = ARENA_CY - tipDist }
      else if (side === 1) { x = ARENA_CX + tipDist;   y = ARENA_CY + acrossArm }
      else if (side === 2) { x = ARENA_CX + acrossArm; y = ARENA_CY + tipDist }
      else                 { x = ARENA_CX - tipDist;   y = ARENA_CY + acrossArm }
    } else if (arenaShape === 'pill') {
      // Spawn along the pill rim — half the time a cap, half the time the top/bottom straight
      if (Math.random() < 0.5) {
        const capSign = Math.random() < 0.5 ? -1 : 1
        const angle = (Math.random() - 0.5) * Math.PI   // semi-circle on the cap side
        x = ARENA_CX + capSign * PILL_HALF_W + capSign * Math.cos(angle) * PILL_R * (0.85 + Math.random() * 0.10)
        y = ARENA_CY + Math.sin(angle) * PILL_R * (0.85 + Math.random() * 0.10)
      } else {
        x = ARENA_CX + (Math.random() - 0.5) * 2 * PILL_HALF_W
        y = ARENA_CY + (Math.random() < 0.5 ? -1 : 1) * PILL_R * (0.85 + Math.random() * 0.10)
      }
    } else if (arenaShape === 'circle' || arenaShape === 'hex' || arenaShape === 'polygon') {
      // Near the outer radius — 85-95% out
      const angle = Math.random() * Math.PI * 2
      const dist = ARENA_RADIUS * (0.85 + Math.random() * 0.10)
      x = ARENA_CX + Math.cos(angle) * dist
      y = ARENA_CY + Math.sin(angle) * dist
      if (arenaShape === 'hex') {
        const c = clampToHex(x, y, 40)
        x = c.x; y = c.y
      } else if (arenaShape === 'polygon') {
        const c = clampToPolygon(x, y, 40)
        x = c.x; y = c.y
      }
    } else {
      // Rect arena: pick a random edge (top/right/bottom/left), random position along it.
      // `inset` keeps the spawn slightly off the wall so the enemy isn't immediately
      // jammed against arena geometry.
      const edge = Math.floor(Math.random() * 4)
      const margin = 80
      const inset = 130
      if (edge === 0)      { x = margin + Math.random() * (ARENA_W - margin * 2); y = inset }              // top
      else if (edge === 1) { x = ARENA_W - inset; y = margin + Math.random() * (ARENA_H - margin * 2) }    // right
      else if (edge === 2) { x = margin + Math.random() * (ARENA_W - margin * 2); y = ARENA_H - inset }    // bottom
      else                 { x = inset; y = margin + Math.random() * (ARENA_H - margin * 2) }              // left
    }
    const dx = x - playerX
    const dy = y - playerY
    const d2 = dx * dx + dy * dy
    if (d2 > minDistFromPlayer * minDistFromPlayer) return { x, y }
    if (d2 > bestD2) { bestD2 = d2; bestX = x; bestY = y }
  }
  return { x: bestX, y: bestY }
}

/** Check if a point is inside the arena */
export function isInArena(x: number, y: number): boolean {
  if (arenaShape === 'cross') return isInCross(x, y)
  if (arenaShape === 'pill') return isInPill(x, y)
  if (arenaShape === 'hex') return isInHex(x, y)
  if (arenaShape === 'polygon') return isInPolygon(x, y)
  if (arenaShape === 'circle') {
    const dx = x - ARENA_CX
    const dy = y - ARENA_CY
    return dx * dx + dy * dy <= ARENA_RADIUS * ARENA_RADIUS
  }
  return x >= 0 && x <= ARENA_W && y >= 0 && y <= ARENA_H
}

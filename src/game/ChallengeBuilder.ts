// Challenge builder — place enemies on arena, save/load challenges

import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import type { EnemyType } from '../entities/EnemyTypes.ts'
import { getCamera, getPhase, getPlayer } from '../core/GameState.ts'
import { setArenaShape, clampToArena, setWalls, ARENA_CX, ARENA_CY, getWallSnapPoints, SNAP_POINT_5_THRESHOLD } from '../game/Arena.ts'
import type { ArenaShape, Camera, Wall, WallMotion, WallTranslation, WallFade, WallSpring } from '../game/Arena.ts'
import { getDesignerZoomFactor } from '../render/Renderer.ts'
import defaultData from '../../data/enemies.json'

export interface ChallengeEnemy {
  typeName: string
  x: number
  y: number
}

export interface Challenge {
  name: string
  arenaShape: 'rect' | 'circle' | 'hex' | 'pill' | 'cross'
  enemies: ChallengeEnemy[]
  walls?: Wall[]   // optional for backwards-compat with pre-walls challenges
  order?: number   // lower = earlier in list, default 999
}

const SAVE_KEY = 'beatback_challenges'

let challenges: Challenge[] = []
let activeChallenge: Challenge | null = null

// Place mode state — multi-tool. Only one tool active at a time; switching tools cancels
// the other. The 'enemy' tool keeps the original click-to-place flow; 'wall'/'pillar' are
// new and route through the wall drag state below.
export type PlaceTool = 'none' | 'enemy' | 'wall' | 'pillar'
let placeTool: PlaceTool = 'none'
let placeMode = false  // legacy boolean kept for callers; true iff placeTool === 'enemy'
let placeTypeName = ''
let placingEnemies: ChallengeEnemy[] = []
let placingWalls: Wall[] = []
let selectedPlacementIdx = -1
let challengeName = 'new_challenge'
let challengeArena: Challenge['arenaShape'] = 'circle'

// Wall-drag transient state — set on mouse-down, updated on mouse-move, committed on
// mouse-up. Tracked in WORLD coordinates so the snap math stays simple and the ghost
// follows the camera correctly.
interface WallDrag { startX: number; startY: number; curX: number; curY: number }
let wallDrag: WallDrag | null = null
let wallThickness = 16
const ENDPOINT_SNAP_DIST = 15
const MIN_WALL_LEN = 20
const ANGLE_SNAP_STEP = Math.PI / 12   // 15° increments when Shift held
const HANDLE_HIT_RADIUS = 12            // px around an endpoint handle that counts as "click on handle"

// Wall selection + endpoint edit state. Separate from hover/select for enemies. When a wall
// is selected, two endpoint handles render on top of it; dragging a handle reshapes the wall.
let selectedWallIdx = -1
// Pivot-set mode — when true, the next canvas click is interpreted as a pivot placement
// (instead of wall selection / new wall drag). Toggled via the "Set Pivot..." UI button.
let pivotSetMode = false
export function isPivotSetMode(): boolean { return pivotSetMode }
export function enterPivotSetMode(): void { pivotSetMode = true }
export function exitPivotSetMode(): void { pivotSetMode = false }
/** Consume a screen-space click in pivot-set mode — converts to world coords, sets pivot
 * (snapped to a wall snap point if within range), exits the mode. */
export function consumePivotSetClick(screenX: number, screenY: number): void {
  const p = screenToWorld(screenX, screenY)
  setSelectedWallPivot(p.x, p.y, true)
  pivotSetMode = false
}
interface EndpointDrag { wallIdx: number; endpoint: 'a' | 'b' }
let endpointDrag: EndpointDrag | null = null

/** Snap an angle to the nearest ANGLE_SNAP_STEP increment. */
function snapAngle(rad: number): number {
  return Math.round(rad / ANGLE_SNAP_STEP) * ANGLE_SNAP_STEP
}

export function isPlaceMode(): boolean { return placeMode }
export function getPlacingEnemies(): ChallengeEnemy[] { return placingEnemies }
export function getSelectedPlacement(): number { return selectedPlacementIdx }
export function getPlaceTypeName(): string { return placeTypeName }
export function getChallengeName(): string { return challengeName }
export function getChallengeArena(): Challenge['arenaShape'] { return challengeArena }
// Hardcoded challenge order — always authoritative
const BUNDLED_ORDER: Record<string, number> = {
  'Beginner Challenge': 0,
  'Challenge 1': 10,
  'Challenge 2': 20,
}

export function getChallenges(): Challenge[] {
  return [...challenges].sort((a, b) => {
    const oa = BUNDLED_ORDER[a.name] ?? a.order ?? 999
    const ob = BUNDLED_ORDER[b.name] ?? b.order ?? 999
    return oa - ob
  })
}
export function getActiveChallenge(): Challenge | null { return activeChallenge }

export function setPlaceMode(typeName: string): void {
  placeMode = true
  placeTool = 'enemy'
  placeTypeName = typeName
  selectedPlacementIdx = -1
  wallDrag = null
}

export function exitPlaceMode(): void {
  placeMode = false
  placeTypeName = ''
  if (placeTool === 'enemy') placeTool = 'none'
}

// ── Wall tool API ─────────────────────────────────────────────────────────
export function getPlaceTool(): PlaceTool { return placeTool }
export function setPlaceTool(tool: PlaceTool): void {
  placeTool = tool
  if (tool === 'enemy') {
    placeMode = true
  } else {
    placeMode = false
    placeTypeName = ''
  }
  selectedPlacementIdx = -1
  wallDrag = null
}
export function getPlacingWalls(): Wall[] { return placingWalls }
export function getWallThickness(): number { return wallThickness }
export function setWallThickness(t: number): void { wallThickness = Math.max(4, Math.min(240, t)) }
export function getWallDrag(): WallDrag | null { return wallDrag }

// Hover tracking — only one item can be hovered at a time. Enemy hit-tests take priority
// over wall hit-tests (smaller, more specific). Renderer reads getHovered{Enemy,Wall}Idx
// to draw red highlights; right-click calls deleteAtScreen to remove whichever is hovered.
let hoveredWallIdx = -1
let hoveredEnemyIdx = -1
export function getHoveredWallIdx(): number { return hoveredWallIdx }
export function getHoveredEnemyIdx(): number { return hoveredEnemyIdx }

/** Hit test enemy ghosts at a world-space point. Returns top-most index or -1. */
function hitTestEnemy(worldX: number, worldY: number): number {
  for (let i = placingEnemies.length - 1; i >= 0; i--) {
    const e = placingEnemies[i]!
    const type = ENEMY_TYPES.find(t => t.name === e.typeName)
    const r = type?.radius ?? 40
    const dx = worldX - e.x
    const dy = worldY - e.y
    if (dx * dx + dy * dy < r * r) return i
  }
  return -1
}

/** Hit test: does (worldX, worldY) lie within the visual extent of any wall? Returns the
 * top-most (last-placed) match, or -1. Adds a small clickability buffer beyond the radius. */
function hitTestWall(worldX: number, worldY: number): number {
  const CLICK_BUFFER = 4
  for (let i = placingWalls.length - 1; i >= 0; i--) {
    if (pointOverlapsWall(placingWalls[i]!, worldX, worldY, CLICK_BUFFER)) return i
  }
  return -1
}

/** True if (worldX, worldY) overlaps the given wall (within `buffer` extra pixels). */
function pointOverlapsWall(w: Wall, worldX: number, worldY: number, buffer: number): boolean {
  const abx = w.bx - w.ax
  const aby = w.by - w.ay
  const apx = worldX - w.ax
  const apy = worldY - w.ay
  const ab2 = abx * abx + aby * aby
  let t = 0
  if (ab2 > 0.01) {
    t = (apx * abx + apy * aby) / ab2
    if (t < 0) t = 0
    else if (t > 1) t = 1
  }
  const cx = w.ax + abx * t
  const cy = w.ay + aby * t
  const dx = worldX - cx
  const dy = worldY - cy
  const reach = w.radius + buffer
  return dx * dx + dy * dy <= reach * reach
}

/** Public: hit-test against a specific wall by index. Used by the designer to detect when
 * a click landed on the already-selected wall (so we know to start a move-group drag). */
export function hitTestSpecificWall(idx: number, screenX: number, screenY: number): boolean {
  if (idx < 0 || idx >= placingWalls.length) return false
  const p = screenToWorld(screenX, screenY)
  return pointOverlapsWall(placingWalls[idx]!, p.x, p.y, 4)
}

/** Update hover state — enemy hit takes priority over wall. Designer mouse-move calls this. */
export function updateHover(screenX: number, screenY: number): void {
  const p = screenToWorld(screenX, screenY)
  const ei = hitTestEnemy(p.x, p.y)
  if (ei >= 0) {
    hoveredEnemyIdx = ei
    hoveredWallIdx = -1
    return
  }
  hoveredEnemyIdx = -1
  hoveredWallIdx = hitTestWall(p.x, p.y)
}

export function clearHover(): void { hoveredEnemyIdx = -1; hoveredWallIdx = -1 }

/** Delete whatever's under the cursor (enemy first, then wall). Used by the right-click
 * handler so the user gets a single uniform "right-click removes things" gesture. */
export function deleteAtScreen(screenX: number, screenY: number): boolean {
  const p = screenToWorld(screenX, screenY)
  const ei = hitTestEnemy(p.x, p.y)
  if (ei >= 0) {
    removeEnemy(ei)   // existing helper — handles selection-bookkeeping
    hoveredEnemyIdx = -1
    return true
  }
  const wi = hitTestWall(p.x, p.y)
  if (wi >= 0) {
    placingWalls.splice(wi, 1)
    hoveredWallIdx = -1
    syncWallsToArena()
    return true
  }
  return false
}

/** Push placingWalls into the live arena so the player can drive around them in test play. */
function syncWallsToArena(): void {
  setWalls(placingWalls)
}

/** Snap a world-space point to the nearest wall snap point (any of 1/3/5 along each wall)
 * within ENDPOINT_SNAP_DIST. noClip walls are skipped — they have no snap points. */
function snapToEndpoint(x: number, y: number, excludeIdx: number = -1): { x: number; y: number; snapped: boolean } {
  let best: { x: number; y: number; d2: number } | null = null
  const limit = ENDPOINT_SNAP_DIST * ENDPOINT_SNAP_DIST
  for (let i = 0; i < placingWalls.length; i++) {
    if (i === excludeIdx) continue
    const w = placingWalls[i]!
    const pts = getWallSnapPoints(w)
    for (const p of pts) {
      const dx = x - p.x, dy = y - p.y
      const d2 = dx * dx + dy * dy
      if (d2 < limit && (!best || d2 < best.d2)) best = { x: p.x, y: p.y, d2 }
    }
  }
  return best ? { x: best.x, y: best.y, snapped: true } : { x, y, snapped: false }
}

function screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
  // When designer is zoomed out, the camera centers on the arena (not the player) and
  // the world is scaled. Invert that transform here so canvas clicks land on the right
  // world coord. Normal play / non-zoomed designer uses the player-following camera.
  const zoom = getDesignerZoomFactor()
  if (zoom !== 1) {
    return {
      x: ARENA_CX + (screenX - window.innerWidth / 2) / zoom,
      y: ARENA_CY + (screenY - window.innerHeight / 2) / zoom,
    }
  }
  const cam = getCamera()
  return { x: screenX + cam.x - window.innerWidth / 2, y: screenY + cam.y - window.innerHeight / 2 }
}

/** Begin a wall drag at the cursor (snapped to nearby endpoint if any). */
export function startWallDrag(screenX: number, screenY: number): void {
  const p = screenToWorld(screenX, screenY)
  const snapped = snapToEndpoint(p.x, p.y)
  wallDrag = { startX: snapped.x, startY: snapped.y, curX: snapped.x, curY: snapped.y }
}

/** Update the drag's current endpoint. Endpoint snap takes priority; if no snap target
 * and Shift is held, the cursor's angle from the drag start is locked to 15° increments. */
export function updateWallDrag(screenX: number, screenY: number, shift = false): void {
  if (!wallDrag) return
  const p = screenToWorld(screenX, screenY)
  const snapped = snapToEndpoint(p.x, p.y)
  if (snapped.snapped) {
    wallDrag.curX = snapped.x
    wallDrag.curY = snapped.y
    return
  }
  if (shift) {
    const dx = p.x - wallDrag.startX
    const dy = p.y - wallDrag.startY
    const len = Math.sqrt(dx * dx + dy * dy)
    const angle = snapAngle(Math.atan2(dy, dx))
    wallDrag.curX = wallDrag.startX + Math.cos(angle) * len
    wallDrag.curY = wallDrag.startY + Math.sin(angle) * len
  } else {
    wallDrag.curX = p.x
    wallDrag.curY = p.y
  }
}

// ── Selection + endpoint editing ─────────────────────────────────────────────
export function getSelectedWallIdx(): number { return selectedWallIdx }
export function getEndpointDrag(): EndpointDrag | null { return endpointDrag }

/** Test if a screen-space cursor is near one of the selected wall's endpoint handles.
 * Returns the endpoint ('a' or 'b') or null. */
export function hitTestSelectedWallHandle(screenX: number, screenY: number): 'a' | 'b' | null {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return null
  const w = placingWalls[selectedWallIdx]!
  const p = screenToWorld(screenX, screenY)
  const limit = HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS
  const dax = p.x - w.ax, day = p.y - w.ay
  if (dax * dax + day * day <= limit) return 'a'
  const dbx = p.x - w.bx, dby = p.y - w.by
  if (dbx * dbx + dby * dby <= limit) return 'b'
  return null
}

/** Select the wall under the cursor (or clear if none). Returns true if something was selected. */
export function selectWallAtScreen(screenX: number, screenY: number): boolean {
  const p = screenToWorld(screenX, screenY)
  const idx = hitTestWall(p.x, p.y)
  selectedWallIdx = idx
  return idx >= 0
}

export function clearWallSelection(): void {
  selectedWallIdx = -1
  endpointDrag = null
}

/** Mutate the selected wall's radius (thickness). Per-wall — does NOT propagate to the
 * group, so individual pieces in a connected shape can have different thicknesses. */
export function setSelectedWallRadius(radius: number): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const r = Math.max(4, Math.min(240, radius))
  placingWalls[selectedWallIdx]!.radius = r
  syncWallsToArena()
}

/** Read the selected wall's radius (or undefined if no selection). */
export function getSelectedWallRadius(): number | undefined {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return undefined
  return placingWalls[selectedWallIdx]?.radius
}

/** Toggle the no-clip tag on the selected wall. When true, this wall doesn't auto-group
 * with neighbors and doesn't expose snap points (designer won't snap to it). Per-wall. */
export function setSelectedWallNoClip(noClip: boolean): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  if (noClip) placingWalls[selectedWallIdx]!.noClip = true
  else delete placingWalls[selectedWallIdx]!.noClip
  syncWallsToArena()
}
export function getSelectedWallNoClip(): boolean {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return false
  return placingWalls[selectedWallIdx]?.noClip ?? false
}

/** Mutate the selected wall's motion config (or clear it). Propagates to every wall in
 * the connected group so the whole shape rotates as one unit (no piece left behind). */
export function setSelectedWallMotion(motion: WallMotion | undefined): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const group = findConnectedWalls(selectedWallIdx)
  for (const i of group) {
    const w = placingWalls[i]!
    if (motion) w.motion = { ...motion }
    else delete w.motion
  }
  syncWallsToArena()
}

/** Compute the bbox center of the selected wall's connected group (designer-side). Used
 * for converting world-space pivot clicks to motion.pivotOffset (relative to bbox center). */
function getSelectedGroupBboxCenter(): { cx: number; cy: number } | null {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return null
  const group = findConnectedWalls(selectedWallIdx)
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const i of group) {
    const w = placingWalls[i]!
    if (w.ax < minX) minX = w.ax
    if (w.ax > maxX) maxX = w.ax
    if (w.bx < minX) minX = w.bx
    if (w.bx > maxX) maxX = w.bx
    if (w.ay < minY) minY = w.ay
    if (w.ay > maxY) maxY = w.ay
    if (w.by < minY) minY = w.by
    if (w.by > maxY) maxY = w.by
  }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

/** Set the pivot for the selected wall's group motion. World coords; snaps to any wall's
 * snap point within ENDPOINT_SNAP_DIST if `snap` is true. The pivot is stored as offset
 * from the group's bbox center (so translation/prefab-drop just work). */
export function setSelectedWallPivot(worldX: number, worldY: number, snap: boolean = true): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const motion = placingWalls[selectedWallIdx]?.motion
  if (!motion) {
    // No own motion — find a peer in the group with motion, set pivot on that one's config.
    // Whichever wall has motion will propagate via groupMotion at runtime.
    for (const i of findConnectedWalls(selectedWallIdx)) {
      if (placingWalls[i]?.motion) {
        return setSelectedWallPivotOnIdx(i, worldX, worldY, snap)
      }
    }
    return
  }
  setSelectedWallPivotOnIdx(selectedWallIdx, worldX, worldY, snap)
}

function setSelectedWallPivotOnIdx(wallIdx: number, worldX: number, worldY: number, snap: boolean): void {
  const motion = placingWalls[wallIdx]?.motion
  if (!motion) return
  let px = worldX, py = worldY
  if (snap) {
    const snapped = snapToEndpoint(worldX, worldY)
    if (snapped.snapped) { px = snapped.x; py = snapped.y }
  }
  const center = getSelectedGroupBboxCenter()
  if (!center) return
  motion.pivotOffsetX = px - center.cx
  motion.pivotOffsetY = py - center.cy
  syncWallsToArena()
}

/** Reset the selected wall's pivot to the bbox center (default behavior). */
export function resetSelectedWallPivot(): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const motion = placingWalls[selectedWallIdx]?.motion
  if (motion) {
    delete motion.pivotOffsetX
    delete motion.pivotOffsetY
    syncWallsToArena()
    return
  }
  // Fall back to peer's motion if selected wall has none
  for (const i of findConnectedWalls(selectedWallIdx)) {
    const m = placingWalls[i]?.motion
    if (m) { delete m.pivotOffsetX; delete m.pivotOffsetY; syncWallsToArena(); return }
  }
}

/** Get the selected wall's group pivot in WORLD coordinates (bbox center + offset). Returns
 * null if no motion is set. Used by renderer to draw the pivot diamond. */
export function getSelectedWallPivotWorld(): { x: number; y: number; offset: { x: number; y: number } } | null {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return null
  // Find motion (own or peer)
  let motion = placingWalls[selectedWallIdx]?.motion
  if (!motion) {
    for (const i of findConnectedWalls(selectedWallIdx)) {
      if (placingWalls[i]?.motion) { motion = placingWalls[i]!.motion; break }
    }
  }
  if (!motion) return null
  const center = getSelectedGroupBboxCenter()
  if (!center) return null
  const ox = motion.pivotOffsetX ?? 0
  const oy = motion.pivotOffsetY ?? 0
  return { x: center.cx + ox, y: center.cy + oy, offset: { x: ox, y: oy } }
}

/** Read the selected wall's motion. Falls back to ANY peer's motion in the connected group
 * so clicking a non-leader wall still shows the group's rotation config in the UI. */
export function getSelectedWallMotion(): WallMotion | undefined {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return undefined
  const own = placingWalls[selectedWallIdx]?.motion
  if (own) return own
  for (const i of findConnectedWalls(selectedWallIdx)) {
    const m = placingWalls[i]?.motion
    if (m) return m
  }
  return undefined
}

/** Mutate the selected wall's translation config — propagates to the whole connected group
 * (same model as motion). Walls in a group all move along the path together. */
export function setSelectedWallTranslation(translation: WallTranslation | undefined): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const group = findConnectedWalls(selectedWallIdx)
  for (const i of group) {
    const w = placingWalls[i]!
    if (translation) w.translation = { ...translation }
    else delete w.translation
  }
  syncWallsToArena()
}

/** Read the selected wall's translation (fallback to peer in group). */
export function getSelectedWallTranslation(): WallTranslation | undefined {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return undefined
  const own = placingWalls[selectedWallIdx]?.translation
  if (own) return own
  for (const i of findConnectedWalls(selectedWallIdx)) {
    const t = placingWalls[i]?.translation
    if (t) return t
  }
  return undefined
}

/** Mutate the selected wall's fade config (or clear). Propagates to whole connected group. */
export function setSelectedWallFade(fade: WallFade | undefined): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const group = findConnectedWalls(selectedWallIdx)
  for (const i of group) {
    const w = placingWalls[i]!
    if (fade) w.fade = { ...fade }
    else delete w.fade
  }
  syncWallsToArena()
}

/** Read the selected wall's fade (fallback to peer in group). */
export function getSelectedWallFade(): WallFade | undefined {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return undefined
  const own = placingWalls[selectedWallIdx]?.fade
  if (own) return own
  for (const i of findConnectedWalls(selectedWallIdx)) {
    const f = placingWalls[i]?.fade
    if (f) return f
  }
  return undefined
}

/** Mutate the selected wall's spring config (or clear it). Triggers sync to live arena. */
export function setSelectedWallSpring(spring: WallSpring | undefined): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const w = placingWalls[selectedWallIdx]!
  if (spring) w.spring = { ...spring }
  else delete w.spring
  syncWallsToArena()
}

export function getSelectedWallSpring(): WallSpring | undefined {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return undefined
  return placingWalls[selectedWallIdx]?.spring
}

/** Delete the currently selected wall (used by Delete key). Returns true if deleted. */
export function deleteSelectedWall(): boolean {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return false
  placingWalls.splice(selectedWallIdx, 1)
  selectedWallIdx = -1
  endpointDrag = null
  syncWallsToArena()
  return true
}

/** Begin dragging one endpoint of the currently selected wall. */
export function startEndpointDrag(endpoint: 'a' | 'b'): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  endpointDrag = { wallIdx: selectedWallIdx, endpoint }
}

/** Update the active endpoint drag. Endpoint snap to OTHER walls' endpoints (not the
 * other end of the same wall — that would be self-snap). Shift locks angle to 15°. */
export function updateEndpointDrag(screenX: number, screenY: number, shift = false): void {
  if (!endpointDrag) return
  if (endpointDrag.wallIdx < 0 || endpointDrag.wallIdx >= placingWalls.length) {
    endpointDrag = null
    return
  }
  const w = placingWalls[endpointDrag.wallIdx]!
  const p = screenToWorld(screenX, screenY)
  // Snap to nearby snap points of OTHER walls (skip self-snap). Uses shared helper that
  // knows about midpoints + quarter-points + noClip exclusion.
  const snapHit = snapToEndpoint(p.x, p.y, endpointDrag.wallIdx)
  let snappedX = snapHit.x, snappedY = snapHit.y, snapped = snapHit.snapped
  if (snapped) {
    if (endpointDrag.endpoint === 'a') { w.ax = snappedX; w.ay = snappedY }
    else { w.bx = snappedX; w.by = snappedY }
    syncWallsToArena()
    return
  }
  // Shift locks angle to 15° from the OTHER (anchored) endpoint
  if (shift) {
    const anchorX = endpointDrag.endpoint === 'a' ? w.bx : w.ax
    const anchorY = endpointDrag.endpoint === 'a' ? w.by : w.ay
    const dx = p.x - anchorX
    const dy = p.y - anchorY
    const len = Math.sqrt(dx * dx + dy * dy)
    const angle = snapAngle(Math.atan2(dy, dx))
    snappedX = anchorX + Math.cos(angle) * len
    snappedY = anchorY + Math.sin(angle) * len
  }
  if (endpointDrag.endpoint === 'a') { w.ax = snappedX; w.ay = snappedY }
  else { w.bx = snappedX; w.by = snappedY }
  syncWallsToArena()
}

export function endEndpointDrag(): void { endpointDrag = null }

// ── Move-group drag (drag a selected wall's body → translate its whole connected piece) ──
interface MoveDrag {
  indices: number[]                                  // walls in the connected group
  originX: number; originY: number                   // world-space drag origin
  initial: Array<{ ax: number; ay: number; bx: number; by: number }>  // starting coords per wall
}
let moveDrag: MoveDrag | null = null
const JOIN_TOL = 0.5   // px tolerance for "endpoints share a point"
export function getMoveDrag(): MoveDrag | null { return moveDrag }

/** Flood-fill walls connected to `startIdx` via shared snap points (endpoints, midpoint,
 * and for long walls also quarter points — matches Arena's runtime grouping logic).
 * Walls tagged with `noClip` are isolated and never join a group with a neighbor. */
function findConnectedWalls(startIdx: number): number[] {
  if (startIdx < 0 || startIdx >= placingWalls.length) return []
  const tol2 = JOIN_TOL * JOIN_TOL
  const allSnap = placingWalls.map(w => getWallSnapPoints(w))
  const visited = new Set<number>([startIdx])
  const stack = [startIdx]
  while (stack.length > 0) {
    const i = stack.pop()!
    const aPts = allSnap[i]!
    if (aPts.length === 0) continue   // noClip wall — isolated
    for (let j = 0; j < placingWalls.length; j++) {
      if (visited.has(j)) continue
      const bPts = allSnap[j]!
      if (bPts.length === 0) continue
      let matched = false
      outer: for (const ap of aPts) {
        for (const bp of bPts) {
          const ddx = ap.x - bp.x, ddy = ap.y - bp.y
          if (ddx * ddx + ddy * ddy < tol2) { matched = true; break outer }
        }
      }
      if (matched) {
        visited.add(j)
        stack.push(j)
      }
    }
  }
  return Array.from(visited)
}

/** Begin a move-group drag using the currently selected wall as the seed. Captures starting
 * coords for every wall in its connected component so the move is a clean translation. */
export function startMoveDrag(screenX: number, screenY: number): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  const p = screenToWorld(screenX, screenY)
  const indices = findConnectedWalls(selectedWallIdx)
  moveDrag = {
    indices,
    originX: p.x, originY: p.y,
    initial: indices.map(i => {
      const w = placingWalls[i]!
      return { ax: w.ax, ay: w.ay, bx: w.bx, by: w.by }
    }),
  }
}

/** Apply the drag delta to every wall in the group. */
export function updateMoveDrag(screenX: number, screenY: number): void {
  if (!moveDrag) return
  const p = screenToWorld(screenX, screenY)
  let dx = p.x - moveDrag.originX
  let dy = p.y - moveDrag.originY
  // Snap the WHOLE GROUP. For each wall in the move group: compute snap points based on
  // (initial position + current dx/dy). For each stationary wall (not in group): get its
  // snap points. Find the closest moving↔stationary pair within ENDPOINT_SNAP_DIST and
  // adjust dx/dy so that pair aligns exactly. The group "clicks into place" by any of its
  // snap points matching any stationary wall's snap point.
  const movingSet = new Set(moveDrag.indices)
  const limit = ENDPOINT_SNAP_DIST * ENDPOINT_SNAP_DIST
  let best: { adjDx: number; adjDy: number; d2: number } | null = null
  for (let k = 0; k < moveDrag.indices.length; k++) {
    const wi = moveDrag.indices[k]!
    const init = moveDrag.initial[k]!
    const w = placingWalls[wi]
    if (!w || w.noClip) continue
    // Build moving-side snap points from (init + dx/dy). Same formula as getWallSnapPoints
    // but applied to the proposed post-translation coordinates.
    const ax = init.ax + dx, ay = init.ay + dy
    const bx = init.bx + dx, by = init.by + dy
    const sdx = bx - ax, sdy = by - ay
    const len = Math.sqrt(sdx * sdx + sdy * sdy)
    const movingPts: Array<{ x: number; y: number }> = []
    if (len < 0.5) movingPts.push({ x: ax, y: ay })
    else if (len < SNAP_POINT_5_THRESHOLD) {
      movingPts.push({ x: ax, y: ay }, { x: ax + sdx * 0.5, y: ay + sdy * 0.5 }, { x: bx, y: by })
    } else {
      movingPts.push(
        { x: ax, y: ay },
        { x: ax + sdx * 0.25, y: ay + sdy * 0.25 },
        { x: ax + sdx * 0.5,  y: ay + sdy * 0.5  },
        { x: ax + sdx * 0.75, y: ay + sdy * 0.75 },
        { x: bx, y: by },
      )
    }
    for (let j = 0; j < placingWalls.length; j++) {
      if (movingSet.has(j)) continue
      const stationaryPts = getWallSnapPoints(placingWalls[j]!)
      for (const mp of movingPts) {
        for (const sp of stationaryPts) {
          const ddx = mp.x - sp.x, ddy = mp.y - sp.y
          const d2 = ddx * ddx + ddy * ddy
          if (d2 < limit && (!best || d2 < best.d2)) {
            // Adjust translation so that this moving point exactly aligns with the
            // stationary target. mp.x already includes (dx, dy); subtract the residual
            // gap from dx/dy to make them coincide.
            best = { adjDx: dx - ddx, adjDy: dy - ddy, d2 }
          }
        }
      }
    }
  }
  if (best) { dx = best.adjDx; dy = best.adjDy }
  for (let k = 0; k < moveDrag.indices.length; k++) {
    const i = moveDrag.indices[k]!
    const init = moveDrag.initial[k]!
    const w = placingWalls[i]
    if (!w) continue
    w.ax = init.ax + dx
    w.ay = init.ay + dy
    w.bx = init.bx + dx
    w.by = init.by + dy
  }
  syncWallsToArena()
}

export function endMoveDrag(): void { moveDrag = null }

// ── Curve handle (drag perpendicular to chord to bend a selected wall into an arc) ──
let bendDrag: { wallIdx: number } | null = null
export function getBendDrag(): { wallIdx: number } | null { return bendDrag }

/** World-space position of the curve handle for a wall — midpoint + perp * bend. */
export function getWallCurveHandle(w: Wall): { x: number; y: number } {
  const mx = (w.ax + w.bx) / 2
  const my = (w.ay + w.by) / 2
  const dx = w.bx - w.ax
  const dy = w.by - w.ay
  const L = Math.sqrt(dx * dx + dy * dy)
  if (L < 0.5) return { x: mx, y: my }
  const px = -dy / L, py = dx / L
  const bend = w.bend ?? 0
  return { x: mx + px * bend, y: my + py * bend }
}

/** Hit-test the selected wall's curve handle. Returns true if the cursor is over it. */
export function hitTestSelectedWallCurveHandle(screenX: number, screenY: number): boolean {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return false
  const w = placingWalls[selectedWallIdx]!
  // Don't show curve handle on degenerate pillars
  const dx = w.bx - w.ax
  const dy = w.by - w.ay
  if (dx * dx + dy * dy < 4) return false
  const handle = getWallCurveHandle(w)
  const p = screenToWorld(screenX, screenY)
  const ddx = p.x - handle.x, ddy = p.y - handle.y
  return ddx * ddx + ddy * ddy <= HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS
}

export function startBendDrag(): void {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return
  bendDrag = { wallIdx: selectedWallIdx }
}

/** Project cursor onto the chord's perpendicular axis and set bend = signed distance from
 * midpoint. Tiny absolute values snap to 0 so the user can flatten a curve precisely. */
export function updateBendDrag(screenX: number, screenY: number): void {
  if (!bendDrag) return
  const w = placingWalls[bendDrag.wallIdx]
  if (!w) { bendDrag = null; return }
  const p = screenToWorld(screenX, screenY)
  const mx = (w.ax + w.bx) / 2
  const my = (w.ay + w.by) / 2
  const dx = w.bx - w.ax
  const dy = w.by - w.ay
  const L = Math.sqrt(dx * dx + dy * dy)
  if (L < 0.5) return
  const px = -dy / L, py = dx / L
  let bend = (p.x - mx) * px + (p.y - my) * py
  // Snap to 0 within 4px so straightening is easy
  if (Math.abs(bend) < 4) bend = 0
  w.bend = bend === 0 ? undefined : bend
  syncWallsToArena()
}

export function endBendDrag(): void { bendDrag = null }

// ─────────────────────────────────────────────────────────────────────────────
// Wall prefabs — saved connected-group templates that can be stamped into any
// challenge. Stored separately from challenges in their own localStorage slot so
// they're a library, not per-challenge data.
// ─────────────────────────────────────────────────────────────────────────────
export interface WallPrefab { name: string; walls: Wall[] }  // wall coords are RELATIVE to bbox center
const PREFAB_SAVE_KEY = 'beatback_wall_prefabs'
let wallPrefabs: WallPrefab[] = []
let placingPrefab: WallPrefab | null = null
let prefabCursorX = 0
let prefabCursorY = 0

export function getWallPrefabs(): WallPrefab[] { return wallPrefabs }
export function getPlacingPrefab(): WallPrefab | null { return placingPrefab }
export function getPrefabCursor(): { x: number; y: number } { return { x: prefabCursorX, y: prefabCursorY } }

function savePrefabsToStorage(): void {
  localStorage.setItem(PREFAB_SAVE_KEY, JSON.stringify(wallPrefabs))
}
export function loadPrefabsFromStorage(): void {
  try {
    const raw = localStorage.getItem(PREFAB_SAVE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as WallPrefab[]
      if (Array.isArray(data)) wallPrefabs = data
    }
  } catch { /* ignore */ }
}

function computeBBoxCenter(ws: readonly Wall[]): { x: number; y: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const w of ws) {
    minX = Math.min(minX, w.ax, w.bx); maxX = Math.max(maxX, w.ax, w.bx)
    minY = Math.min(minY, w.ay, w.by); maxY = Math.max(maxY, w.ay, w.by)
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/** Capture the SELECTED wall's whole connected component as a named prefab. Coords are
 * stored relative to the group's bbox center so the prefab can be placed anywhere. */
export function saveSelectedGroupAsPrefab(name: string): boolean {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return false
  if (!name.trim()) return false
  const indices = findConnectedWalls(selectedWallIdx)
  if (indices.length === 0) return false
  const groupWalls = indices.map(i => placingWalls[i]!)
  const center = computeBBoxCenter(groupWalls)
  // Store as deep copies with positions relativized to bbox center. Motion/emit/touch
  // ride along so a prefab of a rotating L-corner stays a rotating L-corner when dropped.
  const relWalls: Wall[] = groupWalls.map(w => ({
    ax: w.ax - center.x, ay: w.ay - center.y,
    bx: w.bx - center.x, by: w.by - center.y,
    radius: w.radius,
    ...(w.bend != null ? { bend: w.bend } : {}),
    ...(w.motion ? { motion: { ...w.motion } } : {}),
    ...(w.translation ? { translation: { ...w.translation } } : {}),
    ...(w.fade ? { fade: { ...w.fade } } : {}),
    ...(w.spring ? { spring: { ...w.spring } } : {}),
    ...(w.noClip ? { noClip: true } : {}),
  }))
  const trimmed = name.trim()
  const existing = wallPrefabs.findIndex(p => p.name === trimmed)
  if (existing >= 0) wallPrefabs[existing] = { name: trimmed, walls: relWalls }
  else wallPrefabs.push({ name: trimmed, walls: relWalls })
  savePrefabsToStorage()
  return true
}

export function deleteWallPrefab(name: string): void {
  wallPrefabs = wallPrefabs.filter(p => p.name !== name)
  savePrefabsToStorage()
  if (placingPrefab?.name === name) placingPrefab = null
}

/** Enter prefab-place mode. Click on the canvas while in this mode to drop a copy. */
export function startPlacingPrefab(name: string): void {
  const p = wallPrefabs.find(x => x.name === name)
  if (!p) return
  placingPrefab = p
  prefabRotation = 0
  // Switching into prefab mode supersedes the other wall sub-modes (drag, endpoint, bend)
  wallDrag = null
  endpointDrag = null
  moveDrag = null
  bendDrag = null
  // It does NOT change placeTool — prefab is essentially a sub-mode of the wall tool.
  // Make sure user is in wall tool so the existing handlers route properly.
  setPlaceTool('wall')
  selectedWallIdx = -1
}

export function stopPlacingPrefab(): void { placingPrefab = null }

/** Track cursor world position while prefab-place mode is active (for ghost preview). */
export function updatePrefabCursor(screenX: number, screenY: number): void {
  const p = screenToWorld(screenX, screenY)
  prefabCursorX = p.x
  prefabCursorY = p.y
}

/** Drop the active prefab at the cursor. Each prefab wall becomes a new individual wall
 * (so the user can edit/delete pieces independently after placement). */
/** Rotation applied to the placing prefab — radians, around its bbox center (which lands
 * at the cursor). Updated by scroll wheel / R key while in prefab-place mode. */
let prefabRotation = 0
export function getPrefabRotation(): number { return prefabRotation }
export function rotatePrefab(deltaRad: number): void { prefabRotation += deltaRad }
export function setPrefabRotation(rad: number): void { prefabRotation = rad }
export function snapPrefabRotation90(ccw = false): void {
  const step = Math.PI / 2
  prefabRotation = Math.round(prefabRotation / step) * step + (ccw ? -step : step)
}

export function dropPrefabAt(screenX: number, screenY: number): boolean {
  if (!placingPrefab) return false
  const p = screenToWorld(screenX, screenY)
  const cos = Math.cos(prefabRotation), sin = Math.sin(prefabRotation)
  for (const w of placingPrefab.walls) {
    // Rotate the relative endpoint coords around (0,0), then translate to cursor
    const rax = w.ax * cos - w.ay * sin
    const ray = w.ax * sin + w.ay * cos
    const rbx = w.bx * cos - w.by * sin
    const rby = w.bx * sin + w.by * cos
    // Rotate the motion's pivot offset too if present — pivot needs to track the prefab's
    // rotated orientation so the rotation center stays semantically the same point on the
    // shape (e.g. "wall's left endpoint" stays "left endpoint" relative to the rotated shape).
    let rotatedMotion: WallMotion | undefined
    if (w.motion) {
      rotatedMotion = { ...w.motion }
      if (rotatedMotion.pivotOffsetX != null || rotatedMotion.pivotOffsetY != null) {
        const px = rotatedMotion.pivotOffsetX ?? 0
        const py = rotatedMotion.pivotOffsetY ?? 0
        rotatedMotion.pivotOffsetX = px * cos - py * sin
        rotatedMotion.pivotOffsetY = px * sin + py * cos
      }
    }
    // Rotate the translation type if needed: horizontal ↔ vertical swap under 90°/270°
    // rotation. Circle/square paths are rotationally symmetric so they pass through unchanged.
    // For any rotation, the resulting motion stays visually consistent with the prefab.
    let rotatedTrans: WallTranslation | undefined
    if (w.translation) {
      rotatedTrans = { ...w.translation }
      if (rotatedTrans.type === 'horizontal' || rotatedTrans.type === 'vertical') {
        // Compute effective rotation in 90° quadrants for axis-swap logic
        const quadrant = Math.round(prefabRotation / (Math.PI / 2)) & 3   // 0..3
        if (quadrant === 1 || quadrant === 3) {
          rotatedTrans.type = rotatedTrans.type === 'horizontal' ? 'vertical' : 'horizontal'
        }
        // 180° flip negates direction
        if (quadrant === 2 || quadrant === 3) {
          rotatedTrans.direction = ((rotatedTrans.direction ?? 1) === 1 ? -1 : 1) as 1 | -1
        }
      }
    }
    placingWalls.push({
      ax: rax + p.x, ay: ray + p.y,
      bx: rbx + p.x, by: rby + p.y,
      radius: w.radius,
      ...(w.bend != null ? { bend: w.bend } : {}),
      ...(rotatedMotion ? { motion: rotatedMotion } : {}),
      ...(rotatedTrans ? { translation: rotatedTrans } : {}),
      ...(w.fade ? { fade: { ...w.fade } } : {}),
      ...(w.spring ? { spring: { ...w.spring } } : {}),
      ...(w.noClip ? { noClip: true } : {}),
    })
  }
  syncWallsToArena()
  return true
}

/** Rotate the SELECTED wall's whole connected group around its bbox center.
 * Bend values stay the same (they're perpendicular to each wall's chord — they rotate with
 * the wall geometry automatically). Used by R / Shift+R in designer. */
export function rotateSelectedGroup(angleRad: number): boolean {
  if (selectedWallIdx < 0 || selectedWallIdx >= placingWalls.length) return false
  const indices = findConnectedWalls(selectedWallIdx)
  if (indices.length === 0) return false
  const groupWalls = indices.map(i => placingWalls[i]!)
  const center = computeBBoxCenter(groupWalls)
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad)
  for (const w of groupWalls) {
    const ax0 = w.ax - center.x, ay0 = w.ay - center.y
    const bx0 = w.bx - center.x, by0 = w.by - center.y
    w.ax = center.x + ax0 * cos - ay0 * sin
    w.ay = center.y + ax0 * sin + ay0 * cos
    w.bx = center.x + bx0 * cos - by0 * sin
    w.by = center.y + bx0 * sin + by0 * cos
    // Rotate motion's pivot offset too if present, so the rotation pivot stays at the
    // same semantic location on the shape (the bbox CENTER doesn't change under rotation
    // around the bbox center, so the offset just rotates with the shape).
    if (w.motion && (w.motion.pivotOffsetX != null || w.motion.pivotOffsetY != null)) {
      const px = w.motion.pivotOffsetX ?? 0
      const py = w.motion.pivotOffsetY ?? 0
      w.motion.pivotOffsetX = px * cos - py * sin
      w.motion.pivotOffsetY = px * sin + py * cos
    }
  }
  syncWallsToArena()
  return true
}

/** Commit the in-progress wall if it meets min-length, otherwise discard. */
export function endWallDrag(): void {
  if (!wallDrag) return
  const dx = wallDrag.curX - wallDrag.startX
  const dy = wallDrag.curY - wallDrag.startY
  if (dx * dx + dy * dy >= MIN_WALL_LEN * MIN_WALL_LEN) {
    placingWalls.push({
      ax: wallDrag.startX, ay: wallDrag.startY,
      bx: wallDrag.curX, by: wallDrag.curY,
      radius: wallThickness,
    })
    syncWallsToArena()
  }
  wallDrag = null
}

/** Cancel an in-progress wall drag (Esc). */
export function cancelWallDrag(): void {
  wallDrag = null
}

/** Drop a pillar (degenerate capsule, ax=bx, ay=by) at the cursor. */
export function placePillar(screenX: number, screenY: number): void {
  const p = screenToWorld(screenX, screenY)
  // Snap the pillar's single point (center) to a nearby wall snap point (endpoint, midpoint,
  // or quarter-point of an existing capsule) so pillars can clip onto wall geometry cleanly.
  const s = snapToEndpoint(p.x, p.y)
  placingWalls.push({ ax: s.x, ay: s.y, bx: s.x, by: s.y, radius: wallThickness })
  syncWallsToArena()
}

/** Clear all placed walls (used by a "Clear walls" UI button). */
export function clearWalls(): void {
  placingWalls = []
  syncWallsToArena()
}

export function setChallengeName(name: string): void { challengeName = name }
export function setChallengeArena(shape: Challenge['arenaShape']): void {
  challengeArena = shape
  if (getPhase() === 'designer') {
    setArenaShape(shape as ArenaShape)
    const p = getPlayer()
    const c = clampToArena(p.x, p.y, p.hitRadius)
    p.x = c.x; p.y = c.y
  }
}

export function placeEnemy(screenX: number, screenY: number): void {
  // Use screenToWorld so designer zoom-out is correctly inverted (otherwise the cursor
  // and the placed enemy were misaligned when zoomed out).
  const p = screenToWorld(screenX, screenY)
  placingEnemies.push({ typeName: placeTypeName, x: p.x, y: p.y })
}

export function removeEnemy(idx: number): void {
  if (idx >= 0 && idx < placingEnemies.length) {
    placingEnemies.splice(idx, 1)
    if (selectedPlacementIdx === idx) selectedPlacementIdx = -1
    else if (selectedPlacementIdx > idx) selectedPlacementIdx--
  }
}

export function selectPlacement(screenX: number, screenY: number): boolean {
  const p = screenToWorld(screenX, screenY)
  for (let i = placingEnemies.length - 1; i >= 0; i--) {
    const e = placingEnemies[i]!
    const type = ENEMY_TYPES.find(t => t.name === e.typeName)
    const r = type?.radius ?? 40
    const dx = p.x - e.x
    const dy = p.y - e.y
    if (dx * dx + dy * dy < r * r) {
      selectedPlacementIdx = i
      return true
    }
  }
  selectedPlacementIdx = -1
  return false
}

export function clearSelection(): void {
  selectedPlacementIdx = -1
}

export function moveSelectedPlacement(screenX: number, screenY: number): void {
  if (selectedPlacementIdx < 0) return
  const p = screenToWorld(screenX, screenY)
  const e = placingEnemies[selectedPlacementIdx]!
  e.x = p.x
  e.y = p.y
}

export function saveChallenge(): void {
  const challenge: Challenge = {
    name: challengeName,
    arenaShape: challengeArena,
    enemies: [...placingEnemies],
    walls: placingWalls.map(w => ({ ...w })),
  }
  const existing = challenges.findIndex(c => c.name === challenge.name)
  if (existing >= 0) challenges[existing] = challenge
  else challenges.push(challenge)
  saveToStorage()
}

export function loadChallenge(name: string): void {
  const c = challenges.find(ch => ch.name === name)
  if (!c) return
  activeChallenge = c
  challengeName = c.name
  setChallengeArena(c.arenaShape)
  placingEnemies = c.enemies.map(e => ({ ...e }))
  placingWalls = (c.walls ?? []).map(w => ({ ...w }))
  syncWallsToArena()  // apply immediately so walls show up in designer test-play
}

export function deleteChallenge(name: string): void {
  challenges = challenges.filter(c => c.name !== name)
  saveToStorage()
}

export function clearPlacements(): void {
  placingEnemies = []
  placingWalls = []
  selectedPlacementIdx = -1
  wallDrag = null
  syncWallsToArena()
}

export function setActiveChallenge(c: Challenge | null): void {
  activeChallenge = c
}

function saveToStorage(): void {
  localStorage.setItem(SAVE_KEY, JSON.stringify(challenges))
}

export function loadFromStorage(): void {
  loadPrefabsFromStorage()
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (raw) {
      challenges = JSON.parse(raw)
      // Merge from bundled data: add missing challenges and refresh order fields
      const bundled = (defaultData as any).challenges as Challenge[] | undefined
      if (Array.isArray(bundled)) {
        let merged = false
        for (const bc of bundled) {
          const existing = challenges.find(c => c.name === bc.name)
          if (!existing) {
            challenges.push(bc)
            merged = true
          } else if (bc.order != null && existing.order !== bc.order) {
            existing.order = bc.order
            merged = true
          }
        }
        if (merged) saveToStorage()
      }
    } else {
      // First time — use bundled default challenges
      const bundled = (defaultData as any).challenges
      if (Array.isArray(bundled) && bundled.length > 0) {
        challenges = bundled
        saveToStorage()
      }
    }
  } catch { /* ignore */ }
}

export function exportChallenges(): string {
  return JSON.stringify(challenges, null, 2)
}

export function importChallenges(json: string): void {
  try {
    const data = JSON.parse(json) as Challenge[]
    if (Array.isArray(data)) {
      challenges = data
      saveToStorage()
    }
  } catch { /* ignore */ }
}

/** Import a prefab library JSON (array of WallPrefab). Merges with existing, replacing
 * prefabs that share a name and adding new ones. */
export function importWallPrefabs(prefabs: WallPrefab[]): void {
  if (!Array.isArray(prefabs)) return
  for (const p of prefabs) {
    if (!p?.name || !Array.isArray(p.walls)) continue
    const i = wallPrefabs.findIndex(x => x.name === p.name)
    if (i >= 0) wallPrefabs[i] = p
    else wallPrefabs.push(p)
  }
  savePrefabsToStorage()
}

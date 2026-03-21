// Ring occlusion — blocker enemies cast "shadows" that block other enemies' rings

import type { Enemy } from '../entities/Enemy.ts'

export interface BlockedArc {
  start: number  // angle in radians
  end: number
}

/** Get all blocked angle ranges from blocker enemies, relative to a source position */
export function getBlockedArcs(
  sourceX: number,
  sourceY: number,
  ringRadius: number,
  allEnemies: Enemy[],
  sourceEnemy: Enemy  // the enemy whose ring we're checking — skip self
): BlockedArc[] {
  const arcs: BlockedArc[] = []

  for (const blocker of allEnemies) {
    if (blocker === sourceEnemy) continue
    if (!blocker.alive || !blocker.blocksRings) continue

    const dx = blocker.x - sourceX
    const dy = blocker.y - sourceY
    const dist = Math.sqrt(dx * dx + dy * dy)

    // Blocker blocks when ring reaches its near edge (center - body radius)
    const nearEdge = dist - blocker.radius
    if (nearEdge >= ringRadius || dist < 1) continue

    // Angular width the blocker's body covers
    const halfAngle = Math.atan2(blocker.radius, dist)
    const centerAngle = Math.atan2(dy, dx)

    arcs.push({
      start: centerAngle - halfAngle,
      end: centerAngle + halfAngle,
    })
  }

  return arcs
}

/** Check if a specific angle is blocked by any arc */
export function isAngleBlocked(angle: number, arcs: BlockedArc[]): boolean {
  for (const arc of arcs) {
    if (angleInRange(angle, arc.start, arc.end)) return true
  }
  return false
}

/** Check if the angle from source to target is blocked */
export function isTargetBlocked(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  arcs: BlockedArc[]
): boolean {
  const angle = Math.atan2(targetY - sourceY, targetX - sourceX)
  return isAngleBlocked(angle, arcs)
}

function angleInRange(angle: number, start: number, end: number): boolean {
  // Normalize to [-PI, PI]
  const a = normalizeAngle(angle)
  const s = normalizeAngle(start)
  const e = normalizeAngle(end)

  if (s <= e) {
    return a >= s && a <= e
  }
  // Wraps around -PI/PI boundary
  return a >= s || a <= e
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2
  while (a < -Math.PI) a += Math.PI * 2
  return a
}

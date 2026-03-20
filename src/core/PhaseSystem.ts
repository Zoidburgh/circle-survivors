import type { Ring } from '../entities/Ring.ts'
import { BEAT_PHASE, BEAT_WINDOW_HALF } from '../utils/constants.ts'

export function advancePhase(ring: Ring, dt: number): void {
  ring.phase = (ring.phase + dt / ring.tempo) % 1.0
}

export function isAtBeat(ring: Ring): boolean {
  return Math.abs(ring.phase - BEAT_PHASE) < BEAT_WINDOW_HALF
}

// ── Attack animation — fixed duration for ALL rings ──
export const ATTACK_EXPAND_TIME = 1.0
export const ATTACK_LINGER_TIME = 0.05
export const ATTACK_TOTAL_TIME = ATTACK_EXPAND_TIME + ATTACK_LINGER_TIME

/** Ring radius 0-1 from attack timer */
export function getRingExpansion(attackTime: number): number {
  if (attackTime < 0 || attackTime > ATTACK_TOTAL_TIME) return 0
  if (attackTime < ATTACK_EXPAND_TIME) {
    const t = attackTime / ATTACK_EXPAND_TIME
    return 1 - (1 - t) * (1 - t)
  }
  return 1.0
}

/** Ring opacity from attack timer */
export function getRingAlpha(attackTime: number, baseAlpha: number): number {
  if (attackTime < 0 || attackTime > ATTACK_TOTAL_TIME) return 0
  if (attackTime < ATTACK_EXPAND_TIME) return baseAlpha
  const t = (attackTime - ATTACK_EXPAND_TIME) / ATTACK_LINGER_TIME
  return baseAlpha * (1 - t)
}

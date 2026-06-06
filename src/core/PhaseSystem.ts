import type { Ring } from '../entities/Ring.ts'
import { BEAT_PHASE, BEAT_WINDOW_HALF } from '../utils/constants.ts'

export function advancePhase(ring: Ring, dt: number): void {
  ring.phase = (ring.phase + dt / ring.tempo) % 1.0
}

export function isAtBeat(ring: Ring): boolean {
  return Math.abs(ring.phase - BEAT_PHASE) < BEAT_WINDOW_HALF
}

// ── Attack animation — fixed duration for ALL rings ──
export const ATTACK_EXPAND_TIME = 0.68
export const ATTACK_LINGER_TIME = 0.07
export const ATTACK_TOTAL_TIME = ATTACK_EXPAND_TIME + ATTACK_LINGER_TIME
// Ring-fire pattern lead time — rings fire this many seconds BEFORE their nominal beat so
// the visible expansion telegraphs the hit. Hit still lands on the beat: peak occurs at
// (fire_time + ATTACK_EXPAND_TIME), and ATTACK_EXPAND_TIME was bumped by the same delta so
// the math nets out. Only ring patterns use the lead — walls / off-beat-event patterns stay
// at lead=0 so their timing is unchanged.
export const RING_FIRE_LEAD_SEC = 0.23

/** Ring radius 0-1 from attack timer. Softer ease-out (exponent 1.5 instead of 2) so the
 *  start doesn't rush as much and the end doesn't hang close to peak for long.
 *  expandTime defaults to ATTACK_EXPAND_TIME but rings with custom expand windows (e.g. big
 *  enemy rings = 0.80s) should pass their own value so the peak/total math is correct. */
export function getRingExpansion(attackTime: number, expandTime: number = ATTACK_EXPAND_TIME): number {
  const totalTime = expandTime + ATTACK_LINGER_TIME
  if (attackTime < 0 || attackTime > totalTime) return 0
  if (attackTime < expandTime) {
    const t = attackTime / expandTime
    return 1 - Math.pow(1 - t, 1.5)
  }
  return 1.0
}

/** Ring opacity from attack timer */
export function getRingAlpha(attackTime: number, baseAlpha: number, expandTime: number = ATTACK_EXPAND_TIME): number {
  const totalTime = expandTime + ATTACK_LINGER_TIME
  if (attackTime < 0 || attackTime > totalTime) return 0
  if (attackTime < expandTime) return baseAlpha
  const t = (attackTime - expandTime) / ATTACK_LINGER_TIME
  return baseAlpha * (1 - t)
}

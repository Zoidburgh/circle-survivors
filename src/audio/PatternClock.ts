// Pattern-driven beat clock — reads AudioContext.currentTime for sync with music
// Runs at MASTER_BPM (game speed), same time source as BeatLoop

import type { SongPattern } from './SongPatterns.ts'
import { BEAT_SEC } from '../utils/constants.ts'
import { getAudioTime, tickDangerBeat } from './AudioEngine.ts'
import { getBeatZeroTime } from './BeatLoop.ts'

let currentPattern: SongPattern | null = null
let startTime = 0 // AudioContext time when pattern started

// firedBeats key = `${typeName}:${leadSec}` so the SAME pattern can be checked with multiple
// lead times independently (e.g. ring fire wants lead=0.30, walls/zigs want lead=0).
const firedBeats = new Map<string, Set<number>>()
// Per-tick cache so multiple shouldFire(type, lead) callers in the same tick get the same
// answer (boolean — both true AND false get cached). Cleared each advancePatternClock.
const firedThisTick = new Map<string, boolean>()
let lastLoopBeat = -1

export function setPattern(pattern: SongPattern): void {
  currentPattern = pattern
  startTime = getAudioTime()
  firedBeats.clear()
  firedThisTick.clear()
  lastLoopBeat = -1
}

export function getPattern(): SongPattern | null {
  return currentPattern
}

export function getLoopPosition(): number {
  if (!currentPattern) return 0
  // Use BeatLoop's start time so game beats align with music beats
  const elapsed = getAudioTime() - getBeatZeroTime()
  if (elapsed < 0) return 0
  const totalBeats = elapsed / BEAT_SEC
  return totalBeats % currentPattern.loopBeats
}

/** Monotonic beat counter — increases forever, never wraps. Used by wall motion and any
 * other system whose cycle length differs from the song loop (e.g. a 12-beats/rev rotating
 * wall in an 8-beat song would snap backwards every wrap if using getLoopPosition()). */
export function getAbsoluteBeats(): number {
  if (!currentPattern) return 0
  const elapsed = getAudioTime() - getBeatZeroTime()
  if (elapsed < 0) return 0
  return elapsed / BEAT_SEC
}

export function getLoopLength(): number {
  return currentPattern?.loopBeats ?? 8
}

export function advancePatternClock(_dt: number): void {
  if (!currentPattern) return

  const beatTime = getLoopPosition()

  // Detect loop wrap — clear all fired beats (across all leadSec variants).
  if (beatTime < lastLoopBeat - 1) {
    firedBeats.clear()
  }
  lastLoopBeat = beatTime

  // Danger melody — synced to beat
  tickDangerBeat(beatTime)

  // Clear per-tick cache so the next batch of shouldFire calls re-evaluates the live
  // beatTime. Live evaluation in shouldFire (rather than precomputing firingThisTick here)
  // lets us support per-call leadSec without enumerating all possible (type, lead) combos.
  firedThisTick.clear()
}

export function shouldFire(typeName: string, leadSec = 0): boolean {
  if (!currentPattern) return false
  const beats = currentPattern.patterns[typeName]
  if (!beats) return false

  const cacheKey = `${typeName}:${leadSec}`
  const cached = firedThisTick.get(cacheKey)
  if (cached !== undefined) return cached

  let firedSet = firedBeats.get(cacheKey)
  if (!firedSet) {
    firedSet = new Set()
    firedBeats.set(cacheKey, firedSet)
  }

  const beatTime = getLoopPosition()
  const window = 0.08
  const loopLen = currentPattern.loopBeats
  const leadBeats = leadSec / BEAT_SEC

  for (const beat of beats) {
    if (firedSet.has(beat)) continue
    // Shift target by -leadBeats so the fire moment is leadSec BEFORE the nominal beat
    const targetBeat = ((beat - leadBeats) % loopLen + loopLen) % loopLen
    const dist = loopDist(beatTime, targetBeat, loopLen)
    if (dist < window) {
      firedSet.add(beat)
      firedThisTick.set(cacheKey, true)
      return true
    }
  }

  firedThisTick.set(cacheKey, false)
  return false
}

function loopDist(a: number, b: number, len: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, len - d)
}

export function getBeatInterval(typeName: string): number {
  if (!currentPattern) return BEAT_SEC
  const beats = currentPattern.patterns[typeName]
  if (!beats || beats.length < 2) return currentPattern.loopBeats * BEAT_SEC

  const sorted = [...beats].sort((a, b) => a - b)
  let minGap = currentPattern.loopBeats - sorted[sorted.length - 1]! + sorted[0]!
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!
    if (gap < minGap) minGap = gap
  }
  return minGap * BEAT_SEC
}

/** Time in seconds until the next beat of a given pattern fires */
export function timeUntilNextBeat(typeName: string): number {
  if (!currentPattern) return BEAT_SEC
  const beats = currentPattern.patterns[typeName]
  if (!beats || beats.length === 0) return BEAT_SEC
  const pos = getLoopPosition()
  const loopLen = currentPattern.loopBeats
  let minTime = loopLen  // worst case: full loop
  for (const b of beats) {
    let diff = b - pos
    if (diff <= 0.05) diff += loopLen  // skip beats that already fired this tick
    if (diff < minTime) minTime = diff
  }
  return minTime * BEAT_SEC
}

// Pattern-driven beat clock — reads AudioContext.currentTime for sync with music
// Runs at MASTER_BPM (game speed), same time source as BeatLoop

import type { SongPattern } from './SongPatterns.ts'
import { BEAT_SEC } from '../utils/constants.ts'
import { getAudioTime } from './AudioEngine.ts'
import { getBeatZeroTime } from './BeatLoop.ts'

let currentPattern: SongPattern | null = null
let startTime = 0 // AudioContext time when pattern started

const firedBeats = new Map<string, Set<number>>()
const firingThisTick = new Set<string>()
let lastLoopBeat = -1

export function setPattern(pattern: SongPattern): void {
  currentPattern = pattern
  startTime = getAudioTime()
  firedBeats.clear()
  firingThisTick.clear()
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

export function getLoopLength(): number {
  return currentPattern?.loopBeats ?? 8
}

export function advancePatternClock(_dt: number): void {
  if (!currentPattern) return

  const beatTime = getLoopPosition()

  // Detect loop wrap — clear fired beats
  if (beatTime < lastLoopBeat - 1) {
    firedBeats.clear()
  }
  lastLoopBeat = beatTime

  // Compute which types fire this tick
  firingThisTick.clear()
  const window = 0.08

  for (const [typeName, beats] of Object.entries(currentPattern.patterns)) {
    let firedSet = firedBeats.get(typeName)
    if (!firedSet) {
      firedSet = new Set()
      firedBeats.set(typeName, firedSet)
    }

    for (const beat of beats) {
      if (firedSet.has(beat)) continue
      const dist = loopDist(beatTime, beat, currentPattern.loopBeats)
      if (dist < window) {
        firedSet.add(beat)
        firingThisTick.add(typeName)
        break
      }
    }
  }
}

export function shouldFire(typeName: string): boolean {
  return firingThisTick.has(typeName)
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

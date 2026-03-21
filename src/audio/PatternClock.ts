import type { SongPattern } from './SongPatterns.ts'
import { BEAT_SEC } from '../utils/constants.ts'

let currentPattern: SongPattern | null = null
let beatTime = 0
let prevBeatTime = 0

const firedBeats = new Map<string, Set<number>>()

// Which types should fire THIS tick — computed once per tick, read by all enemies
const firingThisTick = new Set<string>()

export function setPattern(pattern: SongPattern): void {
  currentPattern = pattern
  beatTime = 0
  prevBeatTime = 0
  firedBeats.clear()
  firingThisTick.clear()
}

export function getPattern(): SongPattern | null {
  return currentPattern
}

export function getLoopPosition(): number {
  return beatTime
}

export function getLoopLength(): number {
  return currentPattern?.loopBeats ?? 8
}

export function advancePatternClock(dt: number): void {
  if (!currentPattern) return

  prevBeatTime = beatTime
  beatTime += dt / BEAT_SEC

  // Loop wrap
  if (beatTime >= currentPattern.loopBeats) {
    beatTime -= currentPattern.loopBeats
    prevBeatTime = -0.01
    firedBeats.clear()
  }

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
        break // one trigger per type per tick is enough
      }
    }
  }
}

/** Check if this enemy type should fire — all enemies of this type get the same answer */
export function shouldFire(typeName: string): boolean {
  return firingThisTick.has(typeName)
}

function loopDist(a: number, b: number, len: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, len - d)
}

/** Get the shortest interval (in seconds) between beats for a type */
export function getBeatInterval(typeName: string): number {
  if (!currentPattern) return BEAT_SEC
  const beats = currentPattern.patterns[typeName]
  if (!beats || beats.length < 2) return currentPattern.loopBeats * BEAT_SEC

  // Sort and find smallest gap (including wrap-around)
  const sorted = [...beats].sort((a, b) => a - b)
  let minGap = currentPattern.loopBeats - sorted[sorted.length - 1]! + sorted[0]! // wrap gap
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i]! - sorted[i - 1]!
    if (gap < minGap) minGap = gap
  }
  return minGap * BEAT_SEC
}

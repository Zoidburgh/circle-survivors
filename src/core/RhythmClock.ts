// Global rhythm clock — tracks a shared phase for each tempo
// All enemies of the same tempo stay in sync regardless of spawn time

let globalTime = 0

export function advanceGlobalTime(dt: number): void {
  globalTime += dt
}

/** Get the current phase (0-1) for a given tempo */
export function getPhaseForTempo(tempo: number): number {
  return (globalTime / tempo) % 1.0
}


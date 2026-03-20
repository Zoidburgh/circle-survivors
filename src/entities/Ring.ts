export interface Ring {
  phase: number      // 0.0 to 1.0 — 0.5 is beat moment
  radius: number     // max radius in world units
  tempo: number      // seconds per full cycle
  color: [number, number, number, number] // rgba normalized
  owner: 'player' | 'enemy'
}

export function createRing(
  radius: number,
  tempo: number,
  color: [number, number, number, number],
  owner: 'player' | 'enemy'
): Ring {
  return {
    phase: 0,
    radius,
    tempo,
    color,
    owner,
  }
}

export interface Vec2 {
  x: number
  y: number
}

export function vec2(x: number, y: number): Vec2 {
  return { x, y }
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

export function hexToRgba(hex: string, alpha = 1.0): [number, number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return [r, g, b, alpha]
}

/** Triadic-shift a color: rotate hue by 120° + slight lightness bump.
 *  Mirrors the player-is-blue / dots-are-green relationship for any enemy color. */
export function complementColor(r: number, g: number, b: number): [number, number, number] {
  // RGB → HSL
  const rn = r / 255, gn = g / 255, bn = b / 255
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
    else if (max === gn) h = ((bn - rn) / d + 2) / 6
    else h = ((rn - gn) / d + 4) / 6
  }
  // Shift hue by 120°, lift lightness toward 0.65 for punch
  h = (h + 1 / 3) % 1
  const targetL = 0.65
  const newL = l < targetL ? l + (targetL - l) * 0.6 : l
  // HSL → RGB
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let nr: number, ng: number, nb: number
  if (s === 0) { nr = ng = nb = newL }
  else {
    const q = newL < 0.5 ? newL * (1 + s) : newL + s - newL * s
    const p = 2 * newL - q
    nr = hue2rgb(p, q, h + 1 / 3)
    ng = hue2rgb(p, q, h)
    nb = hue2rgb(p, q, h - 1 / 3)
  }
  return [Math.round(nr * 255), Math.round(ng * 255), Math.round(nb * 255)]
}

// Staccato motion — returns the fraction (0..1) of a bullet's flight it should have covered by
// `curBeat`, given the absolute beat it was released (`fireBeat`) and how many beat-aligned hops
// the flight is divided into (`hops`). Frozen between global beats; snaps forward over the last
// ~18% of each beat (smoothstep) so it ARRIVES on the beat. Reaches 1 at the detonation beat
// (clamped), preserving the "lands on the beat" invariant. Sim + viz both call this with the same
// global beat → identical hops with zero data passing. Hardcoded internals (no exposed tunables).
// Delay the hop grid a hair so the SNAP lands ON the beat instead of finishing in the run-up
// just before it (the player pulse peaks on the beat; without this the jump reads ~a frame
// early). Applied to both curBeat and fireBeat so the whole grid shifts uniformly. Dial to taste.
export const STACCATO_LEAD = 0.08
// `division` = hops per beat (1 = whole beat, 2 = half-beat / eighth notes). The hop grid scales
// so boundaries land on each sub-beat; `hops` (the normaliser) must be counted in the same sub-beats.
// `phaseBeats` shifts the whole grid (0 = on-beat, 0.5 = off-beat / syncopated).
export function staccatoProgress(curBeat: number, fireBeat: number, hops: number, division = 1, phaseBeats = 0): number {
  if (hops <= 0) return 1
  const c = (curBeat - STACCATO_LEAD - phaseBeats) * division
  const f = (fireBeat - STACCATO_LEAD - phaseBeats) * division
  const hopsDone = Math.floor(c) - Math.floor(f)   // sub-beat hops since release
  const phase = c - Math.floor(c)                  // 0..1 within the current sub-beat
  const LURCH = 0.18                                            // snap window at the tail of each beat
  const t = phase > 1 - LURCH ? (phase - (1 - LURCH)) / LURCH : 0
  const eased = t * t * (3 - 2 * t)                            // smoothstep into the next hop
  return Math.min(1, Math.max(0, (hopsDone + eased) / hops))
}

// Feels = the "TIME-FEEL" axis of the music, orthogonal to the KIT (Palettes) and the TRACK
// (BeatPresets). A Feel is a pure CLOCK transform on the BeatLoop scheduler: it scales the step
// tempo and optionally overrides the groove swing. It rewrites NO patterns and touches NO voices —
// so Half-Time / Double-Time / Shuffle compose with every kit and every track.
//
// Safe by construction: gameplay timing (PatternClock) reads only BeatLoop's START ORIGIN
// (getBeatZeroTime), never the music tempo, so bending the music clock leaves dash/enemy/ring
// sync untouched. See BeatLoop.setFeel — the feel applies LIVE (no loop restart) so beatZeroTime,
// the shared origin, never moves.

export interface Feel {
  name: string
  speed: number         // step-tempo multiplier: 1 = straight, 0.5 = half-time (slower), 2 = double-time (faster)
  swing: number | null  // null = inherit the active palette's swing; a number OVERRIDES it (e.g. 0.33 = triplet shuffle)
}

export const FEELS: Feel[] = [
  { name: 'Straight',    speed: 1,   swing: null },
  { name: 'Half-Time',   speed: 0.5, swing: null },   // whole loop at half speed — heavy / doom / trap
  { name: 'Double-Time', speed: 2,   swing: null },   // double speed — frantic DnB / footwork
  { name: 'Shuffle',     speed: 1,   swing: 0.33 },   // same tempo, hard triplet swing on the off-16ths
]

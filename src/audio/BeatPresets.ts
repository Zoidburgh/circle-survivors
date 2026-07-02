// Beat presets — 120 BPM, proper electronic tempo
// 16 steps = 1 bar of 4/4 at sixteenth note resolution
// Step 0=beat1, 4=beat2, 8=beat3, 12=beat4
// Every 4 steps = 1 beat

export interface BeatPreset {
  name: string
  bpm: number
  loopSteps?: number   // master loop length (default 16). Set to 32 for a 4-bar evolving phrase.
  kick:   (0|1)[]
  snare:  (0|1)[]
  hihat:  (0|1)[]
  bass:   (0|1)[]
  melody: (0|1)[]
  bassNotes:   number[]
  melodyNotes: number[]
}

export const BEAT_PRESETS: BeatPreset[] = [
  {
    name: 'Pulse',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],  // 1 and 3
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],  // 2 and 4
    hihat:          [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],  // eighth notes
    bass:           [1,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,1,0],  // root + offbeat
    melody:         [0,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0],  // single accent
    bassNotes:      [0,0,0,0, 0,0,3,3, 0,0,0,0, 0,0,0,0],
    melodyNotes:    [0,0,0,0, 0,0,0,0, 0,0,7,0, 0,0,0,0],
  },
  {
    name: 'Groove',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 0,0,0,0, 1,0,0,1, 0,0,0,0],  // kick + ghost
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],  // backbeat
    hihat:          [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1],  // sixteenths
    bass:           [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,0,1],  // bouncy
    melody:         [0,0,1,0, 0,0,0,1, 0,0,1,0, 0,1,0,0],  // arpeggiated
    bassNotes:      [0,0,0,3, 3,3,5,5, 0,0,0,3, 3,3,3,0],
    melodyNotes:    [0,0,5,0, 0,0,0,7, 0,0,3,0, 0,5,0,0],
  },
  {
    name: 'Drive',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],  // four on the floor
    snare:          [0,0,0,0, 1,0,0,1, 0,0,0,0, 1,0,0,0],  // backbeat + ghost
    hihat:          [0,0,1,0, 0,0,1,0, 0,0,1,0, 0,0,1,0],  // offbeat hats
    bass:           [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,1,0],  // pumping
    melody:         [1,0,0,1, 0,0,1,0, 0,1,0,0, 1,0,0,0],  // driving arp
    bassNotes:      [0,0,0,0, 0,0,3,3, 5,5,5,5, 5,5,3,3],
    melodyNotes:    [3,0,0,5, 0,0,7,0, 0,5,0,0, 3,0,0,0],
  },
  {
    name: 'Dark',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,1,0],  // syncopated
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 0,0,0,1],  // off-kilter
    hihat:          [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],  // quarter notes only
    bass:           [1,0,0,0, 0,0,0,0, 0,0,1,0, 0,0,0,0],  // minimal
    melody:         [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,1],  // single hit
    bassNotes:      [0,0,0,0, 0,0,0,0, 0,0,3,3, 3,3,3,3],
    melodyNotes:    [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,7],
  },
  {
    name: 'Rush',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,1,0, 0,0,1,0, 1,0,0,0, 1,0,1,0],  // broken, intense
    snare:          [0,0,0,0, 1,0,0,1, 0,0,1,0, 1,0,0,0],  // syncopated snare
    hihat:          [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1],  // constant sixteenths
    bass:           [1,0,1,0, 0,1,1,0, 1,0,1,0, 0,1,0,1],  // aggressive
    melody:         [1,0,1,1, 0,1,0,1, 1,0,1,0, 1,0,1,1],  // relentless arp
    bassNotes:      [0,0,3,3, 3,5,5,5, 0,0,3,3, 3,7,7,0],
    melodyNotes:    [7,0,5,3, 0,5,0,7, 3,0,5,0, 7,0,3,5],
  },
  {
    // FRACTURE — polyrhythmic: each instrument has a different loop length
    // Kick=4, Snare=7, HiHat=5, Bass=3, Melody=11
    // They cycle at different rates so the combo barely ever repeats
    name: 'Fracture',
    bpm: 120,
    kick:           [1,0,0,0],                          // 4 steps — steady anchor
    snare:          [0,0,1,0,0,1,0],                    // 7 steps — shifts against the kick
    hihat:          [1,0,1,0,1],                        // 5 steps — odd grouping
    bass:           [1,0,1],                            // 3 steps — fast tumbling root
    melody:         [0,0,1,0,0,0,1,0,0,1,0],           // 11 steps — prime, drifts through everything
    bassNotes:      [0,3,5],                            // cycles through 3 notes
    melodyNotes:    [7,0,5,0,0,0,3,0,0,7,0],           // sparse melody hits
  },
  {
    // GENERATIVE — patterns randomize every bar. Always new, always musical.
    name: 'Generative',
    bpm: 120,
    // These are just initial patterns — they get randomized every bar
    kick:           [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],
    hihat:          [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],
    bass:           [1,0,0,0, 0,0,1,0, 0,0,0,0, 0,0,1,0],
    melody:         [0,0,0,0, 0,0,0,1, 0,0,0,0, 0,1,0,0],
    bassNotes:      [0,0,0,0, 0,0,3,3, 0,0,0,0, 0,0,5,5],
    melodyNotes:    [0,0,0,0, 0,0,0,7, 0,0,0,0, 0,5,0,0],
  },
  {
    // ROCK — driving, energetic, straight-ahead power
    // Strong kick-snare, open hats on the and, power chord bass, octave melody
    name: 'Rock',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 0,0,0,0, 1,0,1,0, 0,0,0,0],  // 1 and 3 with pickup
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],  // hard 2 and 4
    hihat:          [1,0,1,1, 1,0,1,1, 1,0,1,1, 1,0,1,1],  // open-close pattern
    bass:           [1,0,1,0, 0,0,0,0, 1,0,1,0, 0,0,1,0],  // driving root + fifth
    melody:         [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,0,1],  // power riff
    bassNotes:      [0,0,0,0, 0,0,0,0, 3,3,3,3, 3,3,0,0],
    melodyNotes:    [0,0,0,0, 0,0,3,0, 5,0,0,0, 0,0,0,7],
  },
  {
    // TRAP — half-time feel, 808 sub, hi-hat rolls
    // Kick sparse, snare on 3 only, hats do the work
    name: 'Trap',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],  // just the 1
    snare:          [0,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0],  // clap on 3 — half time
    hihat:          [1,0,1,1, 1,0,1,1, 1,1,1,0, 1,1,1,1],  // rolls with gaps
    bass:           [1,0,0,0, 0,0,0,1, 0,0,0,0, 0,1,0,0],  // 808 slides
    melody:         [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],  // no melody — all weight
    bassNotes:      [0,0,0,0, 0,0,0,3, 0,0,0,0, 0,5,0,0],
    melodyNotes:    [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0],
  },
  {
    // EAST COAST — boom bap, NY gritty, hard kick-snare, choppy hats
    name: 'BoomBap',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 0,0,0,1, 0,0,1,0, 0,0,0,0],  // syncopated boom
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],  // hard 2 and 4
    hihat:          [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],  // straight eighths
    bass:           [1,0,0,0, 0,0,0,1, 0,0,1,0, 0,0,0,0],  // follows kick
    melody:         [0,0,1,0, 0,0,0,0, 0,0,0,1, 0,0,1,0],  // jazzy stab
    bassNotes:      [0,0,0,0, 0,0,0,3, 0,0,5,5, 0,0,0,0],
    melodyNotes:    [0,0,5,0, 0,0,0,0, 0,0,0,7, 0,0,3,0],
  },
  {
    // WEST COAST — g-funk, laid back, bouncy, whine lead
    name: 'GFunk',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,1, 0,0,0,0, 1,0,0,0, 0,0,1,0],  // bouncy, laid back
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],  // clean backbeat
    hihat:          [1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1],  // sixteenths, ticking
    bass:           [1,0,0,1, 0,0,0,0, 1,0,0,0, 0,0,1,0],  // follows kick, smooth
    melody:         [1,0,0,0, 0,1,0,1, 0,0,1,0, 0,0,0,1],  // whiny synth lead
    bassNotes:      [0,0,0,3, 0,0,0,0, 5,5,5,5, 5,5,3,3],
    melodyNotes:    [7,0,0,0, 0,5,0,3, 0,0,5,0, 0,0,0,7],
  },
  {
    // THE HOOK — a MELODY-led track (vs the drum-led presets). A rising pentatonic riff that climbs to
    // the octave and resolves back to the root, over a root-fifth bass + backbeat. The drums support
    // the tune. The riff re-voices per kit, so the same hook becomes gangsa / vibraphone / chip-lead / etc.
    name: 'The Hook',
    bpm: 120,
    //               1 e + a  2 e + a  3 e + a  4 e + a
    kick:           [1,0,0,0, 1,0,0,0, 1,0,0,1, 1,0,0,0],  // steady, danceable
    snare:          [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],  // backbeat
    hihat:          [1,0,1,1, 1,0,1,0, 1,0,1,1, 1,0,1,0],  // light groove
    bass:           [1,0,0,0, 1,0,1,0, 1,0,0,0, 1,0,1,0],  // root + fifth pulse
    melody:         [1,0,1,1, 0,1,0,0, 1,0,1,1, 0,1,0,1],  // the riff (syncopated)
    bassNotes:      [0,0,0,0, 0,0,3,0, 0,0,0,0, 0,0,3,0],  // root, root, fifth …
    melodyNotes:    [0,0,2,3, 0,2,0,0, 3,0,4,5, 0,2,0,0],  // 0→4th→5th → climbs to the octave(5), resolves to root
  },
  {
    // UNISON RIFF — bass + melody play the SAME riff an OCTAVE apart (the boss-theme / Seven-Nation-Army
    // move). A 4-bar (32-step) evolving phrase so it doesn't loop every bar: phrase A is a root-pedal
    // groove that descends to resolve; phrase B climbs higher (up to the octave) before resolving. Drums
    // stay 16 (steady groove) under the 32-step riff.
    name: 'Unison Riff',
    bpm: 120,
    loopSteps: 32,
    kick:   [1,0,0,0, 0,0,1,0, 1,0,0,0, 0,0,1,0],  // driving rock groove (repeats each bar)
    snare:  [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0],  // backbeat
    hihat:  [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0],  // steady eighths
    //       ── phrase A (root-pedal, resolves down) ──   ── phrase B (climbs to the octave) ──
    bass:   [1,0,1,1,0,1,0,0, 1,0,1,1,0,1,0,0,  1,0,1,1,0,1,0,0, 1,0,1,1,0,1,0,1],
    melody: [1,0,1,1,0,1,0,0, 1,0,1,1,0,1,0,0,  1,0,1,1,0,1,0,0, 1,0,1,1,0,1,0,1],
    bassNotes:   [0,0,0,1,0,0,0,0, 3,0,2,1,0,0,0,0,  0,0,0,1,0,3,0,0, 5,0,4,3,0,2,0,0],
    melodyNotes: [0,0,0,1,0,0,0,0, 3,0,2,1,0,0,0,0,  0,0,0,1,0,3,0,0, 5,0,4,3,0,2,0,0],
  },
]

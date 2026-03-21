// Beat presets — 120 BPM, proper electronic tempo
// 16 steps = 1 bar of 4/4 at sixteenth note resolution
// Step 0=beat1, 4=beat2, 8=beat3, 12=beat4
// Every 4 steps = 1 beat

export interface BeatPreset {
  name: string
  bpm: number
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
]

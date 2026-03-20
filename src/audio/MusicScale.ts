// Note frequencies (A4 = 440hz)
const NOTES: Record<string, number> = {
  'C3': 130.81, 'D3': 146.83, 'Eb3': 155.56, 'E3': 164.81,
  'F3': 174.61, 'G3': 196.00, 'Ab3': 207.65, 'A3': 220.00,
  'Bb3': 233.08, 'B3': 246.94,
  'C4': 261.63, 'D4': 293.66, 'Eb4': 311.13, 'E4': 329.63,
  'F4': 349.23, 'G4': 392.00, 'Ab4': 415.30, 'A4': 440.00,
  'Bb4': 466.16, 'B4': 493.88,
  'C5': 523.25, 'D5': 587.33, 'Eb5': 622.25, 'E5': 659.26,
  'F5': 698.46, 'G5': 783.99,
}

// Scale intervals (semitones from root)
const MINOR_PENTA = [0, 3, 5, 7, 10]  // C Eb F G Bb
const MAJOR_PENTA = [0, 2, 4, 7, 9]   // C D E G A

const ROOT_NAMES = ['C', 'D', 'E', 'F', 'G', 'A']

// All 12 chromatic note names for building scales from any root
const CHROMATIC = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

export interface WaveMusic {
  root: string
  mode: 'minor' | 'major'
  bpm: number
  bassNote: number       // frequency for Whole enemies
  chordNotes: number[]   // frequencies for Half enemies (dyads)
  melodyNotes: number[]  // frequencies for Quarter enemies
  droneRoot: number      // frequency for drone root
  droneFifth: number     // frequency for drone fifth
}

function getFreq(noteName: string, octave: number): number {
  const key = `${noteName}${octave}`
  return NOTES[key] ?? 220
}

function buildScale(rootIndex: number, intervals: number[], octave: number): number[] {
  return intervals.map(semitones => {
    const noteIndex = (rootIndex + semitones) % 12
    const octaveShift = Math.floor((rootIndex + semitones) / 12)
    const noteName = CHROMATIC[noteIndex]!
    return getFreq(noteName, octave + octaveShift)
  })
}

export function generateWaveMusic(waveNum: number): WaveMusic {
  // Pick root — cycle through roots
  const rootName = ROOT_NAMES[(waveNum - 1) % ROOT_NAMES.length]!
  const rootIndex = CHROMATIC.indexOf(rootName)

  // Pick mode — minor default, major every 3rd wave
  const mode: 'minor' | 'major' = waveNum % 3 === 0 ? 'major' : 'minor'
  const intervals = mode === 'minor' ? MINOR_PENTA : MAJOR_PENTA

  // BPM scales with wave
  const bpm = Math.min(30 + (waveNum - 1) * 2, 55)

  // Build notes in different octaves for different roles
  const bassScale = buildScale(rootIndex, intervals, 3)
  const midScale = buildScale(rootIndex, intervals, 4)
  const highScale = buildScale(rootIndex, intervals, 4)

  // Bass = root note
  const bassNote = bassScale[0]!

  // Chord = two notes from mid scale (root + 3rd or root + 4th)
  const chordNotes = [midScale[0]!, midScale[2]!]

  // Melody = full pentatonic in upper register
  const melodyNotes = highScale

  // Drone
  const droneRoot = getFreq(rootName, 3)
  // Fifth is always 7 semitones up
  const fifthIndex = (rootIndex + 7) % 12
  const fifthName = CHROMATIC[fifthIndex]!
  const droneFifth = getFreq(fifthName, 3)

  return { root: rootName, mode, bpm, bassNote, chordNotes, melodyNotes, droneRoot, droneFifth }
}

/** Pick a random melody note from the current wave's scale */
export function pickMelodyNote(music: WaveMusic): number {
  return music.melodyNotes[Math.floor(Math.random() * music.melodyNotes.length)]!
}

/** Pick a chord dyad from the current wave's scale */
export function pickChordNotes(music: WaveMusic): [number, number] {
  // Randomly offset which dyad
  const i = Math.floor(Math.random() * music.melodyNotes.length)
  const j = (i + 2) % music.melodyNotes.length
  return [music.melodyNotes[i]!, music.melodyNotes[j]!]
}

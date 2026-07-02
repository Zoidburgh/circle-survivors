// Continuous electronic beat loop with sustain, pads, and flow
// Schedules notes ahead for precise timing

import type { BeatPreset } from './BeatPresets.ts'
import { getAttackActivity } from './MusicalSFX.ts'
import { ELECTRONIC, type Palette, type Sustain } from './Palettes.ts'

// The active KIT (voices + pad/bass + swing). Rhythm/patterns/scale are unchanged by this — only
// timbre + groove. Swapped live via setPalette().
let activePalette: Palette = ELECTRONIC
let sustain: Sustain | null = null

let ctx: AudioContext
let dest: AudioNode
let playing = false
let bpm = 60
let beatDuration = 60 / bpm
let nextBeatTime = 0
let currentStep = 0
let scheduleAheadTime = 0.1
let timerID: number | null = null
let currentPresetName = ''

// Master loop length in steps (default 16 = 1 phrase). A preset can set `loopSteps` longer (e.g. 32 =
// a 4-bar evolving phrase) so melody/bass don't loop every bar. Only affects the MUSIC — gameplay
// rhythm sync uses PatternClock/getLoopPosition, not this.
let loopSteps = 16

type Pattern = (0 | 1)[]

let kickPattern: Pattern    = [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]
let snarePattern: Pattern   = [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0]
let hihatPattern: Pattern   = [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0]
let bassPattern: Pattern    = [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,0]
let melodyPattern: Pattern  = [0,0,1,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

let bassNotes = [0, 0, 0, 3, 3, 3, 5, 5, 0, 0, 0, 3, 3, 3, 5, 7]
let melodyNotes = [7, 5, 3, 5, 7, 10, 7, 5, 3, 0, 3, 5, 7, 5, 3, 0]

// The music scale (5 pentatonic frequencies). DEFAULT is C minor pentatonic; setBeatLoopScale()
// overwrites it with the current WAVE's scale (from generateWaveMusic) so the tracks sit in the
// SAME key/mode as the drone + the enemy attack SFX — instead of being locked to C minor.
let scaleFreqs = [130.81, 155.56, 174.61, 196.00, 233.08]

function noteFreq(degree: number, octave = 0): number {
  const note = scaleFreqs[((degree % scaleFreqs.length) + scaleFreqs.length) % scaleFreqs.length]!
  return note * Math.pow(2, octave)
}

/** Point the music at the current wave's scale. `freqs` is the wave's 5-note pentatonic (octave 4
 *  from generateWaveMusic.melodyNotes); we drop it an octave to match this engine's register.
 *  Retunes the live pad so a wave/key change is heard immediately. */
export function setBeatLoopScale(freqs: number[]): void {
  if (freqs.length < 5) return
  scaleFreqs = freqs.slice(0, 5).map(f => f * 0.5)
  sustain?.retune(noteFreq(0, 1))   // retune the live pad/drone so a key change is heard immediately
}

export function initBeatLoop(audioCtx: AudioContext, destination: AudioNode, masterBpm: number): void {
  ctx = audioCtx
  dest = destination
  bpm = masterBpm
  beatDuration = 60 / bpm
}

/** The exact AudioContext.currentTime when beat 0 started */
let beatZeroTime = 0

export function getBeatZeroTime(): number {
  return beatZeroTime
}

export function startBeatLoop(): void {
  if (playing) return
  playing = true
  currentStep = 0
  beatZeroTime = ctx.currentTime
  nextBeatTime = beatZeroTime
  sustain = activePalette.startSustain(ctx, dest, noteFreq(0, 1))
  scheduler()
}

export function stopBeatLoop(): void {
  playing = false
  if (timerID !== null) {
    clearTimeout(timerID)
    timerID = null
  }
  sustain?.stop()
  sustain = null
}

/** Swap the active KIT live. Rhythm/patterns/scale/beat-phase all continue uninterrupted — only the
 *  voices + pad/bass + swing change. */
export function setPalette(p: Palette): void {
  activePalette = p
  if (playing && ctx) {
    sustain?.stop()
    sustain = p.startSustain(ctx, dest, noteFreq(0, 1))
  }
}

export function getActivePaletteName(): string { return activePalette.name }

export function loadPreset(preset: BeatPreset): void {
  const wasPlaying = playing
  if (wasPlaying) stopBeatLoop()

  kickPattern = preset.kick
  snarePattern = preset.snare
  hihatPattern = preset.hihat
  bassPattern = preset.bass
  melodyPattern = preset.melody
  bassNotes = preset.bassNotes
  melodyNotes = preset.melodyNotes
  bpm = preset.bpm
  beatDuration = 60 / bpm
  loopSteps = preset.loopSteps ?? 16
  currentPresetName = preset.name

  if (wasPlaying) startBeatLoop()
}

export function getCurrentPresetName(): string {
  return currentPresetName
}

export function getCurrentLoopBeat(): number {
  return currentStep
}

/** Get current loop position in beats (0 to loopLength) for PatternClock sync */
export function getLoopBeatPosition(): number {
  if (!ctx || !playing) return 0
  // Each step = half a beat (eighth note). 16 steps = 8 beats.
  // Interpolate between scheduled steps using audio time
  const stepDuration = beatDuration / 2
  const timeSinceLastStep = ctx.currentTime - (nextBeatTime - stepDuration)
  const fractionalStep = Math.max(0, timeSinceLastStep / stepDuration)
  return ((currentStep + fractionalStep) % loopSteps) / 2 // convert steps to beats
}

export function setBeatLoopBpm(newBpm: number): void {
  bpm = newBpm
  beatDuration = 60 / bpm
}

let isGenerative = false

export function setGenerative(on: boolean): void {
  isGenerative = on
}

function randomizePatterns(): void {
  // Kick: always on 1, randomly add 1-2 more
  const k: (0|1)[] = [1,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]
  const extraKicks = 1 + Math.floor(Math.random() * 2)
  for (let i = 0; i < extraKicks; i++) {
    const pos = [4, 8, 12, 6, 10, 2][Math.floor(Math.random() * 6)]!
    k[pos] = 1
  }
  kickPattern = k

  // Snare: backbeat + maybe ghost
  const s: (0|1)[] = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0]
  s[4] = 1  // always beat 2
  s[12] = 1 // always beat 4
  if (Math.random() > 0.5) s[Math.random() > 0.5 ? 7 : 11] = 1 // ghost
  snarePattern = s

  // Hihat: random density
  const hDensity = Math.random()
  const h: (0|1)[] = Array(16).fill(0) as (0|1)[]
  for (let i = 0; i < 16; i++) {
    if (hDensity < 0.3) h[i] = i % 4 === 0 ? 1 : 0       // quarter
    else if (hDensity < 0.7) h[i] = i % 2 === 0 ? 1 : 0   // eighth
    else h[i] = 1                                           // sixteenth
  }
  hihatPattern = h

  // Bass: random rhythm, 3-5 hits
  const b: (0|1)[] = Array(16).fill(0) as (0|1)[]
  b[0] = 1 // always root on 1
  const bHits = 2 + Math.floor(Math.random() * 3)
  for (let i = 0; i < bHits; i++) {
    b[Math.floor(Math.random() * 16)] = 1
  }
  bassPattern = b
  bassNotes = Array(16).fill(0).map(() => Math.floor(Math.random() * 5))

  // Melody: sparse, 2-4 hits, playful
  const m: (0|1)[] = Array(16).fill(0) as (0|1)[]
  const mHits = 2 + Math.floor(Math.random() * 3)
  for (let i = 0; i < mHits; i++) {
    m[Math.floor(Math.random() * 16)] = 1
  }
  melodyPattern = m
  melodyNotes = Array(16).fill(0).map(() => Math.floor(Math.random() * 8))
}

function scheduler(): void {
  if (!playing) return
  while (nextBeatTime < ctx.currentTime + scheduleAheadTime) {
    // Regenerate patterns at the start of each bar
    if (isGenerative && currentStep % loopSteps === 0) {
      randomizePatterns()
    }
    // Swing — the active kit can delay the off-16ths (odd steps) for a human lilt.
    const stepDur = beatDuration / 2
    const swingOffset = (currentStep % 2 === 1) ? activePalette.swing * stepDur : 0
    scheduleStep(currentStep % loopSteps, nextBeatTime + 0.37 + swingOffset)
    nextBeatTime += beatDuration / 2
    currentStep = (currentStep + 1) % loopSteps
  }
  timerID = window.setTimeout(scheduler, 25)
}

function scheduleStep(step: number, time: number): void {
  // Each instrument uses step % its own pattern length — allows polyrhythmic patterns
  const kStep = step % kickPattern.length
  const sStep = step % snarePattern.length
  const hStep = step % hihatPattern.length
  const bStep = step % bassPattern.length
  const mStep = step % melodyPattern.length

  if (kickPattern[kStep]) { activePalette.kick(ctx, dest, time); sustain?.duck(time) }
  if (snarePattern[sStep]) activePalette.snare(ctx, dest, time)
  if (hihatPattern[hStep]) activePalette.hihat(ctx, dest, time)
  if (bassPattern[bStep]) sustain?.bassHit(time, noteFreq(bassNotes[bStep % bassNotes.length]!, 0), beatDuration)
  if (melodyPattern[mStep]) {
    const duck = 1 - getAttackActivity() * 0.85   // combat owns the lead; the music melody recedes
    const g = Math.max(0.0005, 0.045 * melodyDuck * duck)
    activePalette.melody(ctx, dest, time, noteFreq(melodyNotes[mStep % melodyNotes.length]!, 1), g)
  }
}

// Melody duck (0..1) — the enemy attacks are the LEAD now, so the music's melody is demoted to a
// supporting voice. Read in scheduleStep to size the palette's melody gain. Phase B will drive this
// down dynamically when combat is busy; for now it's 1.
let melodyDuck = 1
export function setMelodyDuck(level: number): void { melodyDuck = Math.max(0, Math.min(1, level)) }

// Continuous electronic beat loop with sustain, pads, and flow
// Schedules notes ahead for precise timing

import type { BeatPreset } from './BeatPresets.ts'
import { getAttackActivity } from './MusicalSFX.ts'
import { ELECTRONIC, type Palette, type Sustain } from './Palettes.ts'
import { FEELS, type Feel } from './Feels.ts'

// The active KIT (voices + pad/bass + swing). Rhythm/patterns/scale are unchanged by this — only
// timbre + groove. Swapped live via setPalette().
let activePalette: Palette = ELECTRONIC
let sustain: Sustain | null = null

// The active TIME-FEEL (step-tempo scale + optional swing override). A pure clock transform applied
// live in the scheduler — no patterns/voices change and the loop is NOT restarted, so the shared
// origin (beatZeroTime) that gameplay sync reads never moves. Swapped live via setFeel().
let activeFeel: Feel = FEELS[0]!

let ctx: AudioContext
let dest: AudioNode
let playing = false
let bpm = 60
let beatDuration = 60 / bpm
let nextBeatTime = 0
let currentStep = 0
let scheduleAheadTime = 0.1
let timerID: number | null = null
// Audible-time lead added to every scheduled step. Sets the phase of the music grid against the
// player pulse: the timing probe measured the pulse landing ~5ms BEFORE the music beat at 0.37, so
// 0.365 pulls the beat back onto the pulse. Nudge down = music earlier, up = music later.
const SCHEDULE_LEAD = 0.365
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

/** Re-quantize the scheduler phase to the shared origin (beatZeroTime) under the CURRENT step size.
 *  Called after any LIVE change to tempo/feel/track so the music grid stays locked to the beat grid
 *  instead of drifting to an arbitrary phase.
 *
 *  Why it's needed: `nextBeatTime` is a free-running accumulator. Changing the step size mid-loop (a
 *  feel switch) or swapping patterns (a track switch) without re-anchoring leaves the grid at whatever
 *  phase it happened to be at — a permanent, cumulative offset that never recovers (measured: a
 *  Double→Half→Straight feel round trip left the pulse ~125ms off baseline). We snap the next step to
 *  the grid a fresh start from beatZeroTime would produce. Anchoring from the current scheduling
 *  frontier (not just `now`) means we never re-schedule an already-committed step, so no doubled hits.
 *  No-op when stopped — startBeatLoop owns setting the origin. */
function reanchorClock(): void {
  if (!playing || !ctx) return
  const stepDur = (beatDuration / activeFeel.speed) / 2
  const from = Math.max(ctx.currentTime, nextBeatTime)
  const k = Math.ceil((from - beatZeroTime) / stepDur)
  nextBeatTime = beatZeroTime + k * stepDur
  currentStep = ((k % loopSteps) + loopSteps) % loopSteps
}

/** Swap the active TIME-FEEL live — no loop restart, so the shared origin (beatZeroTime) that
 *  PatternClock reads is never touched and gameplay stays in sync. Only the step tempo + swing
 *  change; patterns/scale/voices are untouched. Re-anchors so the switch is phase-lossless. */
export function setFeel(f: Feel): void {
  activeFeel = f
  reanchorClock()
}

export function getActiveFeelName(): string { return activeFeel.name }

// ── Music-beat telemetry (dev probe) ─────────────────────────────────────────
// Ring buffer of the AUDIBLE time of each music quarter-note pulse (every even step = the felt
// "beat"). Populated as the scheduler runs, so it reflects the LIVE feel: Half-Time spaces the
// entries out, Double-Time packs them in, and a live feel switch shows up as the phase where the
// spacing changes. getMusicBeatDeltaMs() compares an event time to the nearest stored pulse — that's
// how far the player's on-beat pulse lands from the music beat (+ = player late, − = early).
const musicBeatTimes: number[] = []
function recordMusicBeat(audibleTime: number): void {
  musicBeatTimes.push(audibleTime)
  if (musicBeatTimes.length > 64) musicBeatTimes.shift()
}

/** Signed ms between `atTime` (default: now) and the nearest scheduled music quarter-note pulse.
 *  + = atTime is AFTER the music beat (late), − = before (early). null if the loop isn't running. */
export function getMusicBeatDeltaMs(atTime?: number): number | null {
  if (!playing || !ctx || musicBeatTimes.length === 0) return null
  const t = atTime ?? ctx.currentTime
  let best = Infinity
  for (const bt of musicBeatTimes) {
    const d = t - bt
    if (Math.abs(d) < Math.abs(best)) best = d
  }
  return best === Infinity ? null : best * 1000
}

/** Swap the active TRACK live. Reassigns the patterns/notes/tempo/loop-length while the scheduler
 *  keeps running — NO stop/restart, so beatZeroTime (the shared gameplay+music origin) is never reset.
 *  A restart would yank the gameplay beat grid to "now", re-phasing the player's attack cadence and
 *  snapping enemies mid-pattern back to loop-start — a hitch on every track change. Live-swapping +
 *  re-anchoring keeps the origin fixed for the whole session; the new track picks up seamlessly at the
 *  current loop position (like the KIT swap already does). The origin is set once, by startBeatLoop. */
export function loadPreset(preset: BeatPreset): void {
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

  reanchorClock()   // re-lock the phase to beatZeroTime under the (possibly new) tempo/loop length
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
    // TIME-FEEL — scale the beat by the active feel's speed (0.5 = half-time, 2 = double-time). Read
    // live each step so a feel change applies smoothly without restarting the loop. feelBeatDur also
    // feeds scheduleStep so per-hit bass envelopes stretch/compress with the tempo.
    const feelBeatDur = beatDuration / activeFeel.speed
    const stepDur = feelBeatDur / 2
    // Swing — a feel can OVERRIDE the kit's swing (Shuffle); otherwise inherit the palette's lilt.
    const swing = activeFeel.swing ?? activePalette.swing
    const swingOffset = (currentStep % 2 === 1) ? swing * stepDur : 0
    const audibleTime = nextBeatTime + SCHEDULE_LEAD + swingOffset
    scheduleStep(currentStep % loopSteps, audibleTime, feelBeatDur)
    // Telemetry (dev only): even steps are the quarter-note pulse (the felt beat) — record their
    // audible time so the TimingProbe can measure the player pulse against the live music beat.
    if (__DEV__ && currentStep % 2 === 0) recordMusicBeat(audibleTime)
    nextBeatTime += stepDur
    currentStep = (currentStep + 1) % loopSteps
  }
  timerID = window.setTimeout(scheduler, 25)
}

function scheduleStep(step: number, time: number, feelBeatDur: number = beatDuration): void {
  // Each instrument uses step % its own pattern length — allows polyrhythmic patterns
  const kStep = step % kickPattern.length
  const sStep = step % snarePattern.length
  const hStep = step % hihatPattern.length
  const bStep = step % bassPattern.length
  const mStep = step % melodyPattern.length

  if (kickPattern[kStep]) { activePalette.kick(ctx, dest, time); sustain?.duck(time) }
  if (snarePattern[sStep]) activePalette.snare(ctx, dest, time)
  if (hihatPattern[hStep]) activePalette.hihat(ctx, dest, time)
  if (bassPattern[bStep]) sustain?.bassHit(time, noteFreq(bassNotes[bStep % bassNotes.length]!, 0), feelBeatDur)
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

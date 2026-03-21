// Continuous electronic beat loop with sustain, pads, and flow
// Schedules notes ahead for precise timing

import type { BeatPreset } from './BeatPresets.ts'

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

const STEPS = 16

type Pattern = (0 | 1)[]

let kickPattern: Pattern    = [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0]
let snarePattern: Pattern   = [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0]
let hihatPattern: Pattern   = [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0]
let bassPattern: Pattern    = [1,0,0,1, 0,0,1,0, 1,0,0,1, 0,0,1,0]
let melodyPattern: Pattern  = [0,0,1,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]

let bassNotes = [0, 0, 0, 3, 3, 3, 5, 5, 0, 0, 0, 3, 3, 3, 5, 7]
let melodyNotes = [7, 5, 3, 5, 7, 10, 7, 5, 3, 0, 3, 5, 7, 5, 3, 0]

// C minor pentatonic
const SCALE = [130.81, 155.56, 174.61, 196.00, 233.08]

function noteFreq(degree: number, octave = 0): number {
  const note = SCALE[((degree % SCALE.length) + SCALE.length) % SCALE.length]!
  return note * Math.pow(2, octave)
}

// ── Pad state — continuous, not per-step ──
let padOsc1: OscillatorNode | null = null
let padOsc2: OscillatorNode | null = null
let padGain: GainNode | null = null
let padFilter: BiquadFilterNode | null = null

function startPad(): void {
  if (padOsc1) return

  padGain = ctx.createGain()
  padGain.gain.value = 0.08

  padFilter = ctx.createBiquadFilter()
  padFilter.type = 'lowpass'
  padFilter.frequency.value = 600
  padFilter.Q.value = 1

  // Two detuned saws for width
  padOsc1 = ctx.createOscillator()
  padOsc2 = ctx.createOscillator()
  padOsc1.type = 'sawtooth'
  padOsc2.type = 'sawtooth'
  padOsc1.frequency.value = noteFreq(0, 1)
  padOsc2.frequency.value = noteFreq(0, 1) * 1.003

  // LFO on filter for movement
  const lfo = ctx.createOscillator()
  const lfoGain = ctx.createGain()
  lfo.type = 'sine'
  lfo.frequency.value = 0.15
  lfoGain.gain.value = 300
  lfo.connect(lfoGain)
  lfoGain.connect(padFilter.frequency)
  lfo.start()

  padOsc1.connect(padFilter)
  padOsc2.connect(padFilter)
  padFilter.connect(padGain)
  padGain.connect(dest)
  padOsc1.start()
  padOsc2.start()
}

function stopPad(): void {
  if (padOsc1) { padOsc1.stop(); padOsc1 = null }
  if (padOsc2) { padOsc2.stop(); padOsc2 = null }
  if (padGain) { padGain.disconnect(); padGain = null }
  padFilter = null
}

// ── Sidechain — duck pad on kick ──
function duckPad(time: number): void {
  if (!padGain) return
  padGain.gain.setValueAtTime(0.08, time)
  padGain.gain.linearRampToValueAtTime(0.005, time + 0.01)
  padGain.gain.linearRampToValueAtTime(0.08, time + 0.35)
}

// ── Bass portamento state ──
let bassOsc: OscillatorNode | null = null
let bassGain: GainNode | null = null
let bassFilter: BiquadFilterNode | null = null

function startBassEngine(): void {
  if (bassOsc) return

  bassGain = ctx.createGain()
  bassGain.gain.value = 0

  bassFilter = ctx.createBiquadFilter()
  bassFilter.type = 'lowpass'
  bassFilter.frequency.value = 400
  bassFilter.Q.value = 3

  bassOsc = ctx.createOscillator()
  bassOsc.type = 'sawtooth'
  bassOsc.frequency.value = noteFreq(0, 0)

  bassOsc.connect(bassFilter)
  bassFilter.connect(bassGain)
  bassGain.connect(dest)
  bassOsc.start()
}

function stopBassEngine(): void {
  if (bassOsc) { bassOsc.stop(); bassOsc = null }
  if (bassGain) { bassGain.disconnect(); bassGain = null }
  bassFilter = null
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
  startPad()
  startBassEngine()
  scheduler()
}

export function stopBeatLoop(): void {
  playing = false
  if (timerID !== null) {
    clearTimeout(timerID)
    timerID = null
  }
  stopPad()
  stopBassEngine()
}

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
  return ((currentStep + fractionalStep) % STEPS) / 2 // convert steps to beats
}

export function setBeatLoopBpm(newBpm: number): void {
  bpm = newBpm
  beatDuration = 60 / bpm
}

function scheduler(): void {
  if (!playing) return
  while (nextBeatTime < ctx.currentTime + scheduleAheadTime) {
    scheduleStep(currentStep % STEPS, nextBeatTime + 0.37) // delay to sync with ring peak (0.45 expand - ~0.08 pattern window)
    nextBeatTime += beatDuration / 2 // eighth note resolution
    currentStep = (currentStep + 1) % STEPS
  }
  timerID = window.setTimeout(scheduler, 25)
}

function scheduleStep(step: number, time: number): void {
  if (kickPattern[step]) { scheduleKick(time); duckPad(time) }
  if (snarePattern[step]) scheduleSnare(time)
  if (hihatPattern[step]) scheduleHihat(time)
  if (bassPattern[step]) scheduleBass(time, bassNotes[step]!)
  if (melodyPattern[step]) scheduleMelody(time, melodyNotes[step]!)
}

function scheduleKick(time: number): void {
  // Sub body
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(160, time)
  osc.frequency.exponentialRampToValueAtTime(35, time + 0.12)
  gain.gain.setValueAtTime(0.8, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25)
  osc.connect(gain); gain.connect(dest)
  osc.start(time); osc.stop(time + 0.25)

  // Punch
  const punch = ctx.createOscillator()
  const pGain = ctx.createGain()
  punch.type = 'triangle'
  punch.frequency.setValueAtTime(100, time)
  punch.frequency.exponentialRampToValueAtTime(30, time + 0.08)
  pGain.gain.setValueAtTime(0.5, time)
  pGain.gain.exponentialRampToValueAtTime(0.001, time + 0.1)
  punch.connect(pGain); pGain.connect(dest)
  punch.start(time); punch.stop(time + 0.1)

  // Click transient
  const click = ctx.createOscillator()
  const cGain = ctx.createGain()
  click.type = 'square'
  click.frequency.value = 350
  cGain.gain.setValueAtTime(0.3, time)
  cGain.gain.exponentialRampToValueAtTime(0.001, time + 0.01)
  click.connect(cGain); cGain.connect(dest)
  click.start(time); click.stop(time + 0.01)
}

function scheduleSnare(time: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(200, time)
  osc.frequency.exponentialRampToValueAtTime(80, time + 0.05)
  gain.gain.setValueAtTime(0.45, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12)
  osc.connect(gain); gain.connect(dest)
  osc.start(time); osc.stop(time + 0.12)

  // Noise layer — louder
  for (let i = 0; i < 3; i++) {
    const n = ctx.createOscillator()
    const nGain = ctx.createGain()
    n.type = 'square'
    n.frequency.value = 2500 + Math.random() * 5000
    nGain.gain.setValueAtTime(0.1, time)
    nGain.gain.exponentialRampToValueAtTime(0.001, time + 0.08)
    n.connect(nGain); nGain.connect(dest)
    n.start(time); n.stop(time + 0.08)
  }
}

function scheduleHihat(time: number): void {
  const osc = ctx.createOscillator()
  const osc2 = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'square'
  osc2.type = 'square'
  osc.frequency.value = 5000 + Math.random() * 3000
  osc2.frequency.value = 7000 + Math.random() * 3000
  gain.gain.setValueAtTime(0.08, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
  osc.connect(gain); osc2.connect(gain); gain.connect(dest)
  osc.start(time); osc2.start(time)
  osc.stop(time + 0.05); osc2.stop(time + 0.05)
}

function scheduleBass(time: number, noteIndex: number): void {
  if (!bassOsc || !bassGain || !bassFilter) return
  const freq = noteFreq(noteIndex, 0)
  // Portamento — slide to new note
  bassOsc.frequency.setValueAtTime(bassOsc.frequency.value, time)
  bassOsc.frequency.exponentialRampToValueAtTime(freq, time + 0.06)
  bassGain.gain.setValueAtTime(0.22, time)
  bassGain.gain.linearRampToValueAtTime(0.1, time + beatDuration / 4)
  // Filter accent
  bassFilter.frequency.setValueAtTime(800, time)
  bassFilter.frequency.exponentialRampToValueAtTime(300, time + 0.15)
}

function scheduleMelody(time: number, noteIndex: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const filter = ctx.createBiquadFilter()
  osc.type = 'square'
  const freq = noteFreq(noteIndex, 1)
  osc.frequency.value = freq

  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(2000, time)
  filter.frequency.exponentialRampToValueAtTime(600, time + 0.3)
  filter.Q.value = 1

  gain.gain.setValueAtTime(0.1, time)
  gain.gain.setValueAtTime(0.1, time + 0.08)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2)

  osc.connect(filter); filter.connect(gain); gain.connect(dest)
  osc.start(time); osc.stop(time + 0.2)
}

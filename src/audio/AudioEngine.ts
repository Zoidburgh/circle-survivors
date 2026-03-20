import { initSynth, playKick, playBass, playChord, playMelody, playPluck, playTap } from './MusicSynth.ts'
import { initDrone, startDrone } from './MusicDrone.ts'
import { generateWaveMusic, pickMelodyNote, pickChordNotes } from './MusicScale.ts'
import type { WaveMusic } from './MusicScale.ts'

let ctx: AudioContext | null = null
let master: GainNode
let compressor: DynamicsCompressorNode
let reverbInput: GainNode
let reverbWet: GainNode

let lastEnemyTickTime = 0
const ENEMY_TICK_MIN_INTERVAL = 0.05

let currentMusic: WaveMusic | null = null

function createReverb(audioCtx: AudioContext): { input: GainNode; output: GainNode } {
  const input = audioCtx.createGain()
  const wet = audioCtx.createGain()
  wet.gain.value = 0.2

  // Simple delay-based reverb
  const delays = [0.037, 0.053, 0.079]
  const feedbacks = [0.4, 0.35, 0.3]

  for (let i = 0; i < delays.length; i++) {
    const delay = audioCtx.createDelay()
    delay.delayTime.value = delays[i]!
    const fb = audioCtx.createGain()
    fb.gain.value = feedbacks[i]!
    const filter = audioCtx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 3000

    input.connect(delay)
    delay.connect(filter)
    filter.connect(fb)
    fb.connect(delay) // feedback loop
    filter.connect(wet)
  }

  return { input, output: wet }
}

function ensureContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -12
    compressor.knee.value = 6
    compressor.ratio.value = 8
    compressor.attack.value = 0.003
    compressor.release.value = 0.1
    compressor.connect(ctx.destination)

    master = ctx.createGain()
    master.gain.value = 0.8
    master.connect(compressor)

    // Reverb
    const reverb = createReverb(ctx)
    reverbInput = reverb.input
    reverbWet = reverb.output
    reverbInput.connect(master) // dry signal
    reverbWet.connect(master)   // wet signal

    // Init subsystems
    initSynth(ctx, reverbInput)
    initDrone(ctx, reverbInput)

    // Start with wave 1 music
    currentMusic = generateWaveMusic(1)
    startDrone(currentMusic.droneRoot, currentMusic.droneFifth)
  }
  if (ctx.state === 'suspended') {
    ctx.resume()
  }
  return ctx
}

export function init(): void {
  const resume = () => {
    ensureContext()
    window.removeEventListener('click', resume)
    window.removeEventListener('keydown', resume)
  }
  window.addEventListener('click', resume)
  window.addEventListener('keydown', resume)
}

export function getCurrentMusic(): WaveMusic | null {
  return currentMusic
}

export function setWaveMusic(waveNum: number): void {
  ensureContext()
  currentMusic = generateWaveMusic(waveNum)
}

// ── Player sounds ──

export function playMiss(): void {
  ensureContext()
  // Punchy kick-like thud so it still keeps the beat, but lower/duller than hit
  const c = ctx!
  const t = c.currentTime

  // Hard snare-like crack
  const osc = c.createOscillator()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(180, t)
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.1)

  const snap = c.createOscillator()
  snap.type = 'sawtooth'
  snap.frequency.value = 400

  const body = c.createOscillator()
  body.type = 'square'
  body.frequency.setValueAtTime(120, t)
  body.frequency.exponentialRampToValueAtTime(50, t + 0.08)

  const gain = c.createGain()
  gain.gain.setValueAtTime(1.0, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)

  osc.connect(gain)
  snap.connect(gain)
  body.connect(gain)
  gain.connect(master)
  osc.start(t)
  snap.start(t)
  body.start(t)
  osc.stop(t + 0.15)
  snap.stop(t + 0.03)
  body.stop(t + 0.15)
}

export function playHit(): void {
  ensureContext()
  const c = ctx!
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const osc3 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'square'
  osc1.frequency.setValueAtTime(600, c.currentTime)
  osc1.frequency.exponentialRampToValueAtTime(200, c.currentTime + 0.05)
  osc2.type = 'sine'
  osc2.frequency.value = 440
  osc3.type = 'triangle'
  osc3.frequency.setValueAtTime(120, c.currentTime)
  osc3.frequency.exponentialRampToValueAtTime(60, c.currentTime + 0.1)
  gain.gain.setValueAtTime(0.9, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.2)
  osc1.connect(gain)
  osc2.connect(gain)
  osc3.connect(gain)
  gain.connect(master)
  osc1.start(c.currentTime)
  osc2.start(c.currentTime)
  osc3.start(c.currentTime)
  osc1.stop(c.currentTime + 0.2)
  osc2.stop(c.currentTime + 0.2)
  osc3.stop(c.currentTime + 0.2)
}

export function playKill(): void {
  ensureContext()
  const c = ctx!
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(440, c.currentTime)
  osc.frequency.exponentialRampToValueAtTime(880, c.currentTime + 0.25)
  gain.gain.setValueAtTime(0.8, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.3)
  osc.connect(gain)
  gain.connect(reverbInput)
  osc.start(c.currentTime)
  osc.stop(c.currentTime + 0.3)
}

export function playPlayerHit(): void {
  ensureContext()
  const c = ctx!
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'triangle'
  osc1.frequency.value = 65
  osc2.type = 'sawtooth'
  osc2.frequency.value = 90
  gain.gain.setValueAtTime(1.0, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.35)
  osc1.connect(gain)
  osc2.connect(gain)
  gain.connect(master)
  osc1.start(c.currentTime)
  osc2.start(c.currentTime)
  osc1.stop(c.currentTime + 0.35)
  osc2.stop(c.currentTime + 0.35)
}

export function playBeatTick(): void {
  ensureContext()
  playKick()
}

export function playDash(): void {
  ensureContext()
  const c = ctx!
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const osc3 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'sawtooth'
  osc1.frequency.setValueAtTime(800, c.currentTime)
  osc1.frequency.exponentialRampToValueAtTime(200, c.currentTime + 0.15)
  osc2.type = 'sawtooth'
  osc2.frequency.setValueAtTime(850, c.currentTime)
  osc2.frequency.exponentialRampToValueAtTime(180, c.currentTime + 0.15)
  osc3.type = 'sine'
  osc3.frequency.setValueAtTime(300, c.currentTime)
  osc3.frequency.exponentialRampToValueAtTime(100, c.currentTime + 0.2)
  gain.gain.setValueAtTime(0.5, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.2)
  osc1.connect(gain)
  osc2.connect(gain)
  osc3.connect(gain)
  gain.connect(master)
  osc1.start(c.currentTime)
  osc2.start(c.currentTime)
  osc3.start(c.currentTime)
  osc1.stop(c.currentTime + 0.2)
  osc2.stop(c.currentTime + 0.2)
  osc3.stop(c.currentTime + 0.2)
}

// ── Enemy sounds — now musical ──

export function playEnemyBeatTick(enemyType: string): void {
  ensureContext()
  const c = ctx!
  if (c.currentTime - lastEnemyTickTime < ENEMY_TICK_MIN_INTERVAL) return
  lastEnemyTickTime = c.currentTime

  if (!currentMusic) return

  switch (enemyType) {
    case 'Whole':
      playBass(currentMusic.bassNote)
      break
    case 'Half':
      playChord(pickChordNotes(currentMusic))
      break
    case 'Quarter':
      playMelody(pickMelodyNote(currentMusic))
      break
    case 'Eighth':
      playPluck(pickMelodyNote(currentMusic))
      break
    case 'Sixteenth':
      playTap(pickMelodyNote(currentMusic))
      break
    default:
      playMelody(pickMelodyNote(currentMusic))
  }
}

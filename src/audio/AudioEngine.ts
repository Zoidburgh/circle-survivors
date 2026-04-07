import { initSynth, playKick, playBass, playChord, playPluck } from './MusicSynth.ts'
import { initBeatLoop, startBeatLoop, loadPreset, getCurrentPresetName, setGenerative } from './BeatLoop.ts'
import { BEAT_PRESETS } from './BeatPresets.ts'
import { initDrone, startDrone } from './MusicDrone.ts'
import { generateWaveMusic, pickMelodyNote, pickChordNotes } from './MusicScale.ts'
import type { WaveMusic } from './MusicScale.ts'
import { AUDIO_THROTTLE_INTERVAL } from '../utils/constants.ts'

// ── Micro-variation: prevents repetition fatigue ──
function rPitch(freq: number): number { return freq * (0.97 + Math.random() * 0.06) }
function rVol(vol: number): number { return vol * (0.9 + Math.random() * 0.2) }

// ── Normalized enemy sound volume by waveform type ──
// Square/sawtooth are perceptually louder than sine/triangle
const ENEMY_VOL = 0.35 // base target volume for all enemy sounds
function eVol(waveType: 'sine' | 'triangle' | 'square' | 'sawtooth' | 'multi'): number {
  const scale: Record<string, number> = {
    sine: 1.2,      // quiet waveform, boost
    triangle: 1.0,  // medium
    square: 0.6,    // loud waveform, cut
    sawtooth: 0.65, // loud waveform, cut
    multi: 0.5,     // multiple oscillators, cut more
  }
  return rVol(ENEMY_VOL * (scale[waveType] ?? 1))
}

let ctx: AudioContext | null = null
let master: GainNode
let compressor: DynamicsCompressorNode
let reverbInput: GainNode
let reverbWet: GainNode

const lastTickByType = new Map<string, number>()
const TICK_MIN_INTERVAL = AUDIO_THROTTLE_INTERVAL

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
    initBeatLoop(ctx, reverbInput, 60) // matches MASTER_BPM

    // Start with wave 1 music
    currentMusic = generateWaveMusic(1)
    startDrone(currentMusic.droneRoot, currentMusic.droneFifth)
    loadPreset(BEAT_PRESETS[0]!)
    startBeatLoop()
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

export function switchBeat(index: number): void {
  ensureContext()
  const preset = BEAT_PRESETS[index]
  if (preset) {
    loadPreset(preset)
    setGenerative(preset.name === 'Generative')
  }
}

export function getBeatName(): string {
  return getCurrentPresetName()
}

export function getBeatCount(): number {
  return BEAT_PRESETS.length
}

/** Get audio context time — single source of truth for all timing */
export function getAudioTime(): number {
  if (!ctx) return 0
  return ctx.currentTime
}

export function setWaveMusic(waveNum: number): void {
  ensureContext()
  currentMusic = generateWaveMusic(waveNum)
}

// ── Player sounds ──

export function playMiss(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Body
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(250), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(80), t + 0.1)
  gain.gain.setValueAtTime(0.8, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  osc.connect(gain)
  gain.connect(master)
  osc.start(t)
  osc.stop(t + 0.12)

  // High click that cuts through — this is what you actually hear
  const click = c.createOscillator()
  const clickGain = c.createGain()
  click.type = 'triangle'
  click.frequency.setValueAtTime(rPitch(800), t)
  click.frequency.exponentialRampToValueAtTime(rPitch(400), t + 0.03)
  clickGain.gain.setValueAtTime(0.7, t)
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  click.connect(clickGain)
  clickGain.connect(master)
  click.start(t)
  click.stop(t + 0.05)
}

export function playHit(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Priority 1: Short rising tone (low-mid lane 300-500hz)
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(330), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(500), t + 0.1)
  gain.gain.setValueAtTime(1.0, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain)
  gain.connect(master)
  osc.start(t)
  osc.stop(t + 0.15)
}

export function playKill(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Priority 1: Rising sine (mid lane 440-880hz)
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(440), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(880), t + 0.25)
  gain.gain.setValueAtTime(rVol(0.8), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  osc.connect(gain)
  gain.connect(reverbInput)
  osc.start(t)
  osc.stop(t + 0.3)
}

export function playPlayerHit(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Tonal hit — minor chord stab, musical but painful
  const click = c.createOscillator()
  const clickGain = c.createGain()
  click.type = 'square'
  click.frequency.setValueAtTime(440, t)  // A4 — cuts through
  click.frequency.exponentialRampToValueAtTime(110, t + 0.08)
  clickGain.gain.setValueAtTime(rVol(0.55), t)
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
  click.connect(clickGain)
  clickGain.connect(master)
  click.start(t)
  click.stop(t + 0.1)

  // Dissonant minor second — the "pain" interval
  const dis = c.createOscillator()
  const disGain = c.createGain()
  dis.type = 'sawtooth'
  dis.frequency.setValueAtTime(466, t)  // Bb4 — half step above A = tension
  dis.frequency.exponentialRampToValueAtTime(116, t + 0.08)
  disGain.gain.setValueAtTime(rVol(0.35), t)
  disGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
  dis.connect(disGain)
  disGain.connect(master)
  dis.start(t)
  dis.stop(t + 0.08)

  // Low thud body
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'triangle'
  osc1.frequency.value = rPitch(50)
  osc2.type = 'sawtooth'
  osc2.frequency.value = rPitch(75)
  gain.gain.setValueAtTime(rVol(0.75), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
  osc1.connect(gain)
  osc2.connect(gain)
  gain.connect(master)
  osc1.start(t)
  osc2.start(t)
  osc1.stop(t + 0.2)
  osc2.stop(t + 0.2)
}

export function playBeatTick(): void {
  ensureContext()
  playKick()
}

export function playDash(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Breathy whoosh — two detuned high sines sweeping down
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'sine'
  osc2.type = 'sine'
  osc1.frequency.setValueAtTime(rPitch(600), t)
  osc1.frequency.exponentialRampToValueAtTime(rPitch(180), t + 0.3)
  osc2.frequency.setValueAtTime(rPitch(650), t)
  osc2.frequency.exponentialRampToValueAtTime(rPitch(160), t + 0.3)
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(rVol(0.15), t + 0.04)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  osc1.connect(gain)
  osc2.connect(gain)
  gain.connect(reverbInput)
  osc1.start(t)
  osc2.start(t)
  osc1.stop(t + 0.3)
  osc2.stop(t + 0.3)
}

export function playCollect(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Two-note ascending chime
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'sine'
  osc1.frequency.value = rPitch(700)
  osc2.type = 'sine'
  osc2.frequency.value = rPitch(1050)
  gain.gain.setValueAtTime(rVol(0.5), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc1.connect(gain)
  osc2.connect(gain)
  gain.connect(reverbInput)
  osc1.start(t)
  osc2.start(t + 0.04)
  osc1.stop(t + 0.08)
  osc2.stop(t + 0.15)
}

// ── Attack windup — quiet rising tone that telegraphs incoming attack ──

export function playWindup(duration: number, isPlayer: boolean): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  // Player windup rises higher, enemy stays low
  const startFreq = isPlayer ? 80 : 50
  const endFreq = isPlayer ? 200 : 120
  osc.frequency.setValueAtTime(startFreq, t)
  osc.frequency.exponentialRampToValueAtTime(endFreq, t + duration)
  // Starts silent, builds to subtle volume
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.exponentialRampToValueAtTime(0.05, t + duration * 0.8)
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration)
  osc.connect(gain)
  gain.connect(reverbInput)
  osc.start(t)
  osc.stop(t + duration)
}

// ── Enemy instrument sounds ──

// ── Sound pool — each has a distinct character ──

function playPop(): void {
  const c = ctx!
  const t = c.currentTime
  const osc = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(800, t)
  osc.frequency.exponentialRampToValueAtTime(300, t + 0.06)
  osc2.type = 'sine'
  osc2.frequency.value = 400
  gain.gain.setValueAtTime(eVol('multi'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
  osc.connect(gain)
  osc2.connect(gain)
  gain.connect(reverbInput)
  osc.start(t)
  osc2.start(t)
  osc.stop(t + 0.1)
  osc2.stop(t + 0.1)
}

function playClick(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'square'
  osc.frequency.setValueAtTime(1200, t)
  osc.frequency.exponentialRampToValueAtTime(400, t + 0.03)
  gain.gain.setValueAtTime(eVol('square'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.05)
}

function playBassSound(): void {
  const c = ctx!; const t = c.currentTime
  if (currentMusic) playBass(currentMusic.bassNote)
}

function playChordSound(): void {
  const c = ctx!
  if (currentMusic) playChord(pickChordNotes(currentMusic))
}

function playPluckSound(): void {
  const c = ctx!
  if (currentMusic) playPluck(pickMelodyNote(currentMusic))
}

function playSnap(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(500, t)
  osc.frequency.exponentialRampToValueAtTime(150, t + 0.04)
  gain.gain.setValueAtTime(eVol('sawtooth'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.07)
}

function playBell(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = currentMusic ? pickMelodyNote(currentMusic) * 2 : 880
  osc2.type = 'sine'
  osc2.frequency.value = (currentMusic ? pickMelodyNote(currentMusic) * 2 : 880) * 1.5
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  osc.connect(gain); osc2.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc2.start(t); osc.stop(t + 0.3); osc2.stop(t + 0.3)
}

function playBuzz(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.value = currentMusic ? currentMusic.bassNote * 2 : 220
  gain.gain.setValueAtTime(eVol('sawtooth'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.08)
}

function playThump(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(200, t)
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.15)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.15)
}

function playChirp(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(600, t)
  osc.frequency.exponentialRampToValueAtTime(1200, t + 0.06)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.08)
}

function playZap(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(1500, t)
  osc.frequency.exponentialRampToValueAtTime(100, t + 0.08)
  gain.gain.setValueAtTime(eVol('sawtooth'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.1)
}

function playBloop(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(300, t)
  osc.frequency.exponentialRampToValueAtTime(600, t + 0.05)
  osc.frequency.exponentialRampToValueAtTime(200, t + 0.12)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.15)
}

function playClap(): void {
  const c = ctx!; const t = c.currentTime
  const gain = c.createGain()
  gain.gain.setValueAtTime(eVol('square'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
  gain.connect(reverbInput)
  for (let i = 0; i < 4; i++) {
    const osc = c.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 1000 + Math.random() * 2000
    osc.connect(gain)
    osc.start(t + i * 0.005)
    osc.stop(t + 0.06 + i * 0.005)
  }
}

function playRim(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(rPitch(900), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(500), t + 0.02)
  gain.gain.setValueAtTime(eVol('triangle'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.04)
}

function playTom(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(250, t)
  osc.frequency.exponentialRampToValueAtTime(100, t + 0.15)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.2)
}

function playWhistle(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(800, t)
  osc.frequency.linearRampToValueAtTime(1200, t + 0.1)
  osc.frequency.linearRampToValueAtTime(800, t + 0.2)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.25)
}

// ── New sounds: tonal variety + texture ──

function playPurr(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const lfo = c.createOscillator()
  const lfoGain = c.createGain()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = rPitch(55)
  lfo.type = 'sine'
  lfo.frequency.value = rPitch(6)
  lfoGain.gain.value = 8
  lfo.connect(lfoGain)
  lfoGain.connect(osc.frequency)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); lfo.start(t)
  osc.stop(t + 0.25); lfo.stop(t + 0.25)
}

function playPing(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = rPitch(currentMusic ? pickMelodyNote(currentMusic) * 4 : 1760)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.06)
}

function playGrowl(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.value = rPitch(80)
  osc2.type = 'square'
  osc2.frequency.value = rPitch(82)
  gain.gain.setValueAtTime(eVol('multi'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1)
  osc.connect(gain); osc2.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc2.start(t)
  osc.stop(t + 0.1); osc2.stop(t + 0.1)
}

function playChime(): void {
  const c = ctx!; const t = c.currentTime
  const freq = rPitch(currentMusic ? pickMelodyNote(currentMusic) * 2 : 880)
  const osc = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  osc2.type = 'sine'
  osc2.frequency.value = freq * 1.498 // near-fifth harmonic
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  osc.connect(gain); osc2.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc2.start(t)
  osc.stop(t + 0.4); osc2.stop(t + 0.4)
}

function playKnock(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const filter = c.createBiquadFilter()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.value = rPitch(300)
  filter.type = 'bandpass'
  filter.frequency.value = rPitch(800)
  filter.Q.value = 3
  gain.gain.setValueAtTime(eVol('sawtooth'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  osc.connect(filter); filter.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.05)
}

function playSweep(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const filter = c.createBiquadFilter()
  const gain = c.createGain()
  osc.type = 'sawtooth'
  osc.frequency.value = rPitch(150)
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(200, t)
  filter.frequency.exponentialRampToValueAtTime(3000, t + 0.12)
  filter.Q.value = 5
  gain.gain.setValueAtTime(eVol('sawtooth'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(filter); filter.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.15)
}

function playDrop(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(500), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(80), t + 0.12)
  gain.gain.setValueAtTime(eVol('sine'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.15)
}

function playPulseSound(): void {
  const c = ctx!; const t = c.currentTime
  const osc = c.createOscillator()
  const lfo = c.createOscillator()
  const lfoGain = c.createGain()
  const gain = c.createGain()
  osc.type = 'square'
  osc.frequency.value = rPitch(currentMusic ? pickMelodyNote(currentMusic) : 330)
  lfo.type = 'square'
  lfo.frequency.value = rPitch(12)
  lfoGain.gain.value = 0.4
  lfo.connect(lfoGain)
  lfoGain.connect(gain.gain)
  gain.gain.setValueAtTime(eVol('square'), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); lfo.start(t)
  osc.stop(t + 0.15); lfo.stop(t + 0.15)
}

const SOUND_MAP: Record<string, () => void> = {
  pop: playPop,
  click: playClick,
  bass: playBassSound,
  chord: playChordSound,
  pluck: playPluckSound,
  snap: playSnap,
  bell: playBell,
  buzz: playBuzz,
  thump: playThump,
  chirp: playChirp,
  zap: playZap,
  bloop: playBloop,
  clap: playClap,
  rim: playRim,
  tom: playTom,
  whistle: playWhistle,
  purr: playPurr,
  ping: playPing,
  growl: playGrowl,
  chime: playChime,
  knock: playKnock,
  sweep: playSweep,
  drop: playDrop,
  pulse: playPulseSound,
}

// ── Enemy beat dispatch ──

export function playEnemyBeatTick(enemyType: string, sound?: string): void {
  ensureContext()
  const c = ctx!
  const lastTime = lastTickByType.get(enemyType) ?? 0
  if (c.currentTime - lastTime < TICK_MIN_INTERVAL) return
  lastTickByType.set(enemyType, c.currentTime)

  const soundFn = SOUND_MAP[sound ?? 'pop']
  if (soundFn) soundFn()
}

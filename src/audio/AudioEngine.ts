import { initSynth, playKick, playBass, playChord, playMelody, playPluck, playTap } from './MusicSynth.ts'
import { initDrone, startDrone } from './MusicDrone.ts'
import { generateWaveMusic, pickMelodyNote, pickChordNotes } from './MusicScale.ts'
import type { WaveMusic } from './MusicScale.ts'

// ── Micro-variation: prevents repetition fatigue ──
function rPitch(freq: number): number { return freq * (0.97 + Math.random() * 0.06) }
function rVol(vol: number): number { return vol * (0.9 + Math.random() * 0.2) }

let ctx: AudioContext | null = null
let master: GainNode
let compressor: DynamicsCompressorNode
let reverbInput: GainNode
let reverbWet: GainNode

const lastTickByType = new Map<string, number>()
const TICK_MIN_INTERVAL = 0.04

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
  const t = c.currentTime
  // Priority 1: Short rising tone (low-mid lane 300-500hz)
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(330), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(500), t + 0.1)
  gain.gain.setValueAtTime(rVol(0.75), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  osc.connect(gain)
  gain.connect(reverbInput)
  osc.start(t)
  osc.stop(t + 0.12)
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
  // Priority 2: Low thud (sub lane 40-90hz)
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'triangle'
  osc1.frequency.value = rPitch(65)
  osc2.type = 'sawtooth'
  osc2.frequency.value = rPitch(90)
  gain.gain.setValueAtTime(rVol(0.6), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  osc1.connect(gain)
  osc2.connect(gain)
  gain.connect(master)
  osc1.start(t)
  osc2.start(t)
  osc1.stop(t + 0.3)
  osc2.stop(t + 0.3)
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
  gain.gain.setValueAtTime(0.6, t)
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
  gain.gain.setValueAtTime(0.5, t)
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
  gain.gain.setValueAtTime(0.6, t)
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
  gain.gain.setValueAtTime(0.35, t)
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
  gain.gain.setValueAtTime(0.35, t)
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
  gain.gain.setValueAtTime(0.7, t)
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
  gain.gain.setValueAtTime(0.4, t)
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
  gain.gain.setValueAtTime(0.4, t)
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
  gain.gain.setValueAtTime(0.5, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.15)
}

function playClap(): void {
  const c = ctx!; const t = c.currentTime
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.5, t)
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
  gain.gain.setValueAtTime(0.6, t)
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
  gain.gain.setValueAtTime(0.6, t)
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
  gain.gain.setValueAtTime(0.3, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.25)
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

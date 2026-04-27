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
    const saved = localStorage.getItem('beatback_volume')
    master.gain.value = saved !== null ? parseFloat(saved) : 0.8
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
    ctx.resume().catch(() => {})
  }
  return ctx
}

/** Resume AudioContext if suspended — call on focus regain */
export function ensureAudioContext(): void {
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
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

export function getVolume(): number {
  return master ? master.gain.value : parseFloat(localStorage.getItem('beatback_volume') ?? '0.8')
}

export function setVolume(v: number): void {
  const clamped = Math.max(0, Math.min(1, v))
  if (master) master.gain.value = clamped
  localStorage.setItem('beatback_volume', clamped.toFixed(2))
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

export function playVolatileExplosion(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Hissing buildup — filtered noise rising in pitch, matches BEAT_SEC
  const hissLen = 1.0
  const hissBuf = c.createBuffer(1, Math.floor(c.sampleRate * hissLen), c.sampleRate)
  const hissData = hissBuf.getChannelData(0)
  for (let i = 0; i < hissData.length; i++) hissData[i] = (Math.random() * 2 - 1) * 0.4
  const hiss = c.createBufferSource()
  hiss.buffer = hissBuf
  const hissFilter = c.createBiquadFilter()
  hissFilter.type = 'highpass'
  hissFilter.frequency.setValueAtTime(1000, t)
  hissFilter.frequency.exponentialRampToValueAtTime(4000, t + hissLen)
  const hissGain = c.createGain()
  hissGain.gain.setValueAtTime(rVol(0.15), t)
  hissGain.gain.linearRampToValueAtTime(rVol(0.4), t + hissLen * 0.7)
  hissGain.gain.exponentialRampToValueAtTime(0.001, t + hissLen)
  hiss.connect(hissFilter)
  hissFilter.connect(hissGain)
  hissGain.connect(master)
  hiss.start(t)
  hiss.stop(t + hissLen)

  // Explosion boom
  const popTime = t + hissLen * 0.95

  // Deep bass thud
  const thud = c.createOscillator()
  const thudGain = c.createGain()
  thud.type = 'sine'
  thud.frequency.setValueAtTime(60, popTime)
  thud.frequency.exponentialRampToValueAtTime(20, popTime + 0.3)
  thudGain.gain.setValueAtTime(rVol(1.2), popTime)
  thudGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.3)
  thud.connect(thudGain)
  thudGain.connect(master)
  thud.start(popTime)
  thud.stop(popTime + 0.3)

  // Second bass layer
  const thud2 = c.createOscillator()
  const thud2Gain = c.createGain()
  thud2.type = 'triangle'
  thud2.frequency.setValueAtTime(45, popTime)
  thud2.frequency.exponentialRampToValueAtTime(15, popTime + 0.25)
  thud2Gain.gain.setValueAtTime(rVol(1.0), popTime)
  thud2Gain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.25)
  thud2.connect(thud2Gain)
  thud2Gain.connect(master)
  thud2.start(popTime)
  thud2.stop(popTime + 0.25)

  // Low rumble noise burst
  const boomBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.2), c.sampleRate)
  const boomData = boomBuf.getChannelData(0)
  for (let i = 0; i < boomData.length; i++) boomData[i] = (Math.random() * 2 - 1) * 0.6
  const boomNoise = c.createBufferSource()
  boomNoise.buffer = boomBuf
  const boomFilter = c.createBiquadFilter()
  boomFilter.type = 'lowpass'
  boomFilter.frequency.setValueAtTime(800, popTime)
  boomFilter.frequency.exponentialRampToValueAtTime(200, popTime + 0.15)
  const boomGain = c.createGain()
  boomGain.gain.setValueAtTime(rVol(1.1), popTime)
  boomGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.2)
  boomNoise.connect(boomFilter)
  boomFilter.connect(boomGain)
  boomGain.connect(master)
  boomNoise.start(popTime)
  boomNoise.stop(popTime + 0.2)
}

let fuseBurnNodes: { gain: GainNode; sources: AudioBufferSourceNode[] } | null = null

export function startShieldFuseBurn(duration: number): void {
  ensureContext()
  stopShieldFuseBurn()
  const c = ctx!
  const t = c.currentTime

  // Crackling burn — looped noise through a narrow bandpass, slowly rising
  const bufLen = 2  // 2 second buffer, looped
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * bufLen), c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    // Crackle texture — random pops mixed with hiss
    data[i] = (Math.random() * 2 - 1) * (Math.random() < 0.05 ? 0.8 : 0.2)
  }

  const noise = c.createBufferSource()
  noise.buffer = buf
  noise.loop = true

  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 3
  filter.frequency.setValueAtTime(800, t)
  filter.frequency.exponentialRampToValueAtTime(2500, t + duration * 0.8)
  filter.frequency.exponentialRampToValueAtTime(4000, t + duration)

  const gain = c.createGain()
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(rVol(0.08), t + 0.5)
  gain.gain.linearRampToValueAtTime(rVol(0.15), t + duration * 0.5)
  gain.gain.linearRampToValueAtTime(rVol(0.25), t + duration)

  noise.connect(filter)
  filter.connect(gain)
  gain.connect(reverbInput)
  noise.start(t)
  noise.stop(t + duration + 0.5)  // extra buffer, stopShieldFuseBurn cuts it

  // Subtle low hum that rises — the fuse wire heating up
  const hum = c.createOscillator()
  const humGain = c.createGain()
  hum.type = 'sine'
  hum.frequency.setValueAtTime(rPitch(120), t)
  hum.frequency.exponentialRampToValueAtTime(rPitch(300), t + duration)
  humGain.gain.setValueAtTime(0.001, t)
  humGain.gain.linearRampToValueAtTime(rVol(0.05), t + 0.5)
  humGain.gain.linearRampToValueAtTime(rVol(0.12), t + duration * 0.5)
  humGain.gain.linearRampToValueAtTime(rVol(0.2), t + duration)
  hum.connect(humGain)
  humGain.connect(master)
  hum.start(t)
  hum.stop(t + duration + 0.5)

  fuseBurnNodes = { gain, sources: [noise, hum as unknown as AudioBufferSourceNode] }
}

export function stopShieldFuseBurn(): void {
  if (fuseBurnNodes) {
    try {
      fuseBurnNodes.gain.gain.cancelScheduledValues(0)
      fuseBurnNodes.gain.gain.setValueAtTime(0, 0)
      for (const s of fuseBurnNodes.sources) try { s.stop() } catch {}
    } catch {}
    fuseBurnNodes = null
  }
}

export function playShieldBreak(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Descending dissonant crash — minor second interval, feels wrong
  const ping = c.createOscillator()
  const ping2 = c.createOscillator()
  const pingGain = c.createGain()
  ping.type = 'sawtooth'
  ping2.type = 'sawtooth'
  ping.frequency.setValueAtTime(rPitch(1400), t)
  ping.frequency.exponentialRampToValueAtTime(rPitch(180), t + 0.35)
  ping2.frequency.setValueAtTime(rPitch(1480), t) // minor second = dissonance
  ping2.frequency.exponentialRampToValueAtTime(rPitch(170), t + 0.35)
  pingGain.gain.setValueAtTime(rVol(0.3), t)
  pingGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  const pingFilter = c.createBiquadFilter()
  pingFilter.type = 'lowpass'
  pingFilter.frequency.setValueAtTime(4000, t)
  pingFilter.frequency.exponentialRampToValueAtTime(500, t + 0.35)
  ping.connect(pingFilter)
  ping2.connect(pingFilter)
  pingFilter.connect(pingGain)
  pingGain.connect(reverbInput)
  ping.start(t)
  ping2.start(t)
  ping.stop(t + 0.4)
  ping2.stop(t + 0.4)

  // Heavy sub drop — ominous gut punch
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(120), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(20), t + 0.3)
  subGain.gain.setValueAtTime(rVol(0.6), t)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  sub.connect(subGain)
  subGain.connect(master)
  sub.start(t)
  sub.stop(t + 0.3)

  // Harsh shatter noise — loud, aggressive
  const noiseDur = 0.25
  const noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * noiseDur), c.sampleRate)
  const noiseData = noiseBuf.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.7
  const noise = c.createBufferSource()
  noise.buffer = noiseBuf
  const noiseGain = c.createGain()
  noiseGain.gain.setValueAtTime(rVol(0.45), t)
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + noiseDur)
  const hpf = c.createBiquadFilter()
  hpf.type = 'highpass'
  hpf.frequency.value = 1200
  noise.connect(hpf)
  hpf.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(t)
  noise.stop(t + noiseDur)

  // Dark descending moan — tritone dissonance, something went wrong
  const moan = c.createOscillator()
  const moan2 = c.createOscillator()
  const moanGain = c.createGain()
  moan.type = 'triangle'
  moan2.type = 'triangle'
  moan.frequency.setValueAtTime(rPitch(300), t + 0.05)
  moan.frequency.exponentialRampToValueAtTime(rPitch(150), t + 0.5)
  moan2.frequency.setValueAtTime(rPitch(424), t + 0.05) // tritone = devil's interval
  moan2.frequency.exponentialRampToValueAtTime(rPitch(212), t + 0.5)
  moanGain.gain.setValueAtTime(0.001, t + 0.05)
  moanGain.gain.linearRampToValueAtTime(rVol(0.2), t + 0.12)
  moanGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
  moan.connect(moanGain)
  moan2.connect(moanGain)
  moanGain.connect(reverbInput)
  moan.start(t + 0.05)
  moan2.start(t + 0.05)
  moan.stop(t + 0.5)
  moan2.stop(t + 0.5)
}

export function playShieldRestore(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Power-up sweep — rising filtered saw for that force field hum
  const sweep = c.createOscillator()
  const sweep2 = c.createOscillator()
  const sweepGain = c.createGain()
  sweep.type = 'sawtooth'
  sweep2.type = 'sawtooth'
  sweep.frequency.setValueAtTime(rPitch(80), t)
  sweep.frequency.exponentialRampToValueAtTime(rPitch(300), t + 0.3)
  sweep2.frequency.setValueAtTime(rPitch(82), t) // detuned for thickness
  sweep2.frequency.exponentialRampToValueAtTime(rPitch(305), t + 0.3)
  sweepGain.gain.setValueAtTime(rVol(0.3), t)
  sweepGain.gain.linearRampToValueAtTime(rVol(0.4), t + 0.15)
  sweepGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  const sweepFilter = c.createBiquadFilter()
  sweepFilter.type = 'lowpass'
  sweepFilter.frequency.setValueAtTime(400, t)
  sweepFilter.frequency.exponentialRampToValueAtTime(2000, t + 0.25)
  sweepFilter.frequency.exponentialRampToValueAtTime(600, t + 0.4)
  sweep.connect(sweepFilter)
  sweep2.connect(sweepFilter)
  sweepFilter.connect(sweepGain)
  sweepGain.connect(master)
  sweep.start(t)
  sweep2.start(t)
  sweep.stop(t + 0.4)
  sweep2.stop(t + 0.4)

  // Bright activation chime — delayed to hit at the peak
  const chime = c.createOscillator()
  const chime2 = c.createOscillator()
  const chimeGain = c.createGain()
  chime.type = 'sine'
  chime2.type = 'sine'
  chime.frequency.setValueAtTime(rPitch(900), t + 0.15)
  chime.frequency.exponentialRampToValueAtTime(rPitch(1200), t + 0.25)
  chime2.frequency.setValueAtTime(rPitch(1350), t + 0.15) // fifth above
  chime2.frequency.exponentialRampToValueAtTime(rPitch(1800), t + 0.25)
  chimeGain.gain.setValueAtTime(0.001, t)
  chimeGain.gain.linearRampToValueAtTime(rVol(0.35), t + 0.17)
  chimeGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
  chime.connect(chimeGain)
  chime2.connect(chimeGain)
  chimeGain.connect(reverbInput)
  chime.start(t + 0.15)
  chime2.start(t + 0.15)
  chime.stop(t + 0.45)
  chime2.stop(t + 0.45)

  // Energy crackle — filtered noise burst
  const noiseDur = 0.2
  const noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * noiseDur), c.sampleRate)
  const noiseData = noiseBuf.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.4
  const noise = c.createBufferSource()
  noise.buffer = noiseBuf
  const noiseFilter = c.createBiquadFilter()
  noiseFilter.type = 'bandpass'
  noiseFilter.frequency.setValueAtTime(1500, t + 0.1)
  noiseFilter.frequency.exponentialRampToValueAtTime(4000, t + 0.2)
  noiseFilter.Q.value = 2
  const noiseGain = c.createGain()
  noiseGain.gain.setValueAtTime(0.001, t)
  noiseGain.gain.linearRampToValueAtTime(rVol(0.25), t + 0.12)
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  noise.connect(noiseFilter)
  noiseFilter.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(t + 0.1)
  noise.stop(t + 0.3)
}

export function playBeatTick(): void {
  ensureContext()
  playKick()
}

export function playShrineSummon(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime + 0.1  // slight delay so hit sound plays first

  // Rising whoosh — energy gathering
  const whooshDur = 0.4
  const whooshBuf = c.createBuffer(1, Math.floor(c.sampleRate * whooshDur), c.sampleRate)
  const whooshData = whooshBuf.getChannelData(0)
  for (let i = 0; i < whooshData.length; i++) whooshData[i] = (Math.random() * 2 - 1) * 0.4
  const whoosh = c.createBufferSource()
  whoosh.buffer = whooshBuf
  const whooshFilter = c.createBiquadFilter()
  whooshFilter.type = 'bandpass'
  whooshFilter.Q.value = 2
  whooshFilter.frequency.setValueAtTime(300, t)
  whooshFilter.frequency.exponentialRampToValueAtTime(2500, t + whooshDur)
  const whooshGain = c.createGain()
  whooshGain.gain.setValueAtTime(0.001, t)
  whooshGain.gain.linearRampToValueAtTime(rVol(0.45), t + whooshDur * 0.7)
  whooshGain.gain.exponentialRampToValueAtTime(0.001, t + whooshDur)
  whoosh.connect(whooshFilter)
  whooshFilter.connect(whooshGain)
  whooshGain.connect(reverbInput)
  whoosh.start(t)
  whoosh.stop(t + whooshDur)

  // Rising tone — builds tension
  const rise = c.createOscillator()
  const riseGain = c.createGain()
  rise.type = 'triangle'
  rise.frequency.setValueAtTime(rPitch(150), t)
  rise.frequency.exponentialRampToValueAtTime(rPitch(500), t + 0.35)
  riseGain.gain.setValueAtTime(rVol(0.25), t)
  riseGain.gain.linearRampToValueAtTime(rVol(0.45), t + 0.3)
  riseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  rise.connect(riseGain)
  riseGain.connect(master)
  rise.start(t)
  rise.stop(t + 0.4)

  // Sub buildup
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(60), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(120), t + 0.35)
  subGain.gain.setValueAtTime(rVol(0.3), t)
  subGain.gain.linearRampToValueAtTime(rVol(0.5), t + 0.3)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  sub.connect(subGain)
  subGain.connect(master)
  sub.start(t)
  sub.stop(t + 0.4)
}

export function playShrineHit(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Crystalline chime — rising, rewarding
  const chime = c.createOscillator()
  const chime2 = c.createOscillator()
  const chimeGain = c.createGain()
  chime.type = 'sine'
  chime2.type = 'sine'
  chime.frequency.setValueAtTime(rPitch(700), t)
  chime.frequency.exponentialRampToValueAtTime(rPitch(1100), t + 0.12)
  chime2.frequency.setValueAtTime(rPitch(1050), t)  // fifth above
  chime2.frequency.exponentialRampToValueAtTime(rPitch(1650), t + 0.12)
  chimeGain.gain.setValueAtTime(rVol(0.25), t)
  chimeGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  chime.connect(chimeGain)
  chime2.connect(chimeGain)
  chimeGain.connect(reverbInput)
  chime.start(t)
  chime2.start(t)
  chime.stop(t + 0.25)
  chime2.stop(t + 0.25)

  // Warm thud — grounds it, not too heavy
  const thud = c.createOscillator()
  const thudGain = c.createGain()
  thud.type = 'triangle'
  thud.frequency.setValueAtTime(rPitch(150), t)
  thud.frequency.exponentialRampToValueAtTime(rPitch(80), t + 0.1)
  thudGain.gain.setValueAtTime(rVol(0.3), t)
  thudGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  thud.connect(thudGain)
  thudGain.connect(master)
  thud.start(t)
  thud.stop(t + 0.12)

  // Shimmer tail — sparkly reverb
  const shimmer = c.createOscillator()
  const shimmerGain = c.createGain()
  shimmer.type = 'sine'
  shimmer.frequency.setValueAtTime(rPitch(1800), t + 0.05)
  shimmer.frequency.exponentialRampToValueAtTime(rPitch(2400), t + 0.2)
  shimmerGain.gain.setValueAtTime(0.001, t + 0.05)
  shimmerGain.gain.linearRampToValueAtTime(rVol(0.08), t + 0.08)
  shimmerGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  shimmer.connect(shimmerGain)
  shimmerGain.connect(reverbInput)
  shimmer.start(t + 0.05)
  shimmer.stop(t + 0.25)
}

export function playDashReady(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Quick rising chime — positive, light
  const chime = c.createOscillator()
  const chimeGain = c.createGain()
  chime.type = 'sine'
  chime.frequency.setValueAtTime(rPitch(600), t)
  chime.frequency.exponentialRampToValueAtTime(rPitch(900), t + 0.08)
  chimeGain.gain.setValueAtTime(rVol(0.2), t)
  chimeGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  chime.connect(chimeGain)
  chimeGain.connect(reverbInput)
  chime.start(t)
  chime.stop(t + 0.15)

  // Soft pop
  const pop = c.createOscillator()
  const popGain = c.createGain()
  pop.type = 'sine'
  pop.frequency.setValueAtTime(rPitch(200), t)
  pop.frequency.exponentialRampToValueAtTime(rPitch(120), t + 0.06)
  popGain.gain.setValueAtTime(rVol(0.15), t)
  popGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
  pop.connect(popGain)
  popGain.connect(master)
  pop.start(t)
  pop.stop(t + 0.08)
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

/** Node lock sound — pitch rises with progress (0-based index, total nodes) */
export function playNodeLock(progress: number, total: number): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Ascending pitch based on progress through the sequence
  const basePitch = 600 + (progress / Math.max(1, total - 1)) * 600

  // Punchy pluck — triangle for more body
  const osc = c.createOscillator()
  const oscGain = c.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(rPitch(basePitch), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(basePitch * 0.75), t + 0.18)
  oscGain.gain.setValueAtTime(rVol(0.45), t)
  oscGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
  osc.connect(oscGain)
  oscGain.connect(master)
  osc.start(t)
  osc.stop(t + 0.18)

  // Harmonic overtone
  const harm = c.createOscillator()
  const harmGain = c.createGain()
  harm.type = 'sine'
  harm.frequency.setValueAtTime(rPitch(basePitch * 2), t)
  harm.frequency.exponentialRampToValueAtTime(rPitch(basePitch * 1.5), t + 0.12)
  harmGain.gain.setValueAtTime(rVol(0.2), t)
  harmGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  harm.connect(harmGain)
  harmGain.connect(reverbInput)
  harm.start(t)
  harm.stop(t + 0.12)

  // Click transient — makes it audible even at low pitch
  const clickDur = 0.03
  const clickBuf = c.createBuffer(1, Math.floor(c.sampleRate * clickDur), c.sampleRate)
  const clickData = clickBuf.getChannelData(0)
  for (let i = 0; i < clickData.length; i++) clickData[i] = (Math.random() * 2 - 1) * 0.3
  const click = c.createBufferSource()
  click.buffer = clickBuf
  const clickFilter = c.createBiquadFilter()
  clickFilter.type = 'highpass'
  clickFilter.frequency.value = 3000
  const clickGain = c.createGain()
  clickGain.gain.setValueAtTime(rVol(0.3), t)
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + clickDur)
  click.connect(clickFilter)
  clickFilter.connect(clickGain)
  clickGain.connect(master)
  click.start(t)
  click.stop(t + clickDur)
}

/** Final node — bright bell ding */
export function playNodeComplete(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Bell fundamental
  const bell = c.createOscillator()
  const bellGain = c.createGain()
  bell.type = 'sine'
  bell.frequency.setValueAtTime(rPitch(1200), t)
  bellGain.gain.setValueAtTime(rVol(0.5), t)
  bellGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
  bell.connect(bellGain)
  bellGain.connect(master)
  bell.start(t)
  bell.stop(t + 0.5)

  // Bell overtone — octave + fifth
  const over1 = c.createOscillator()
  const over1Gain = c.createGain()
  over1.type = 'sine'
  over1.frequency.setValueAtTime(rPitch(1800), t)
  over1Gain.gain.setValueAtTime(rVol(0.25), t)
  over1Gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
  over1.connect(over1Gain)
  over1Gain.connect(master)
  over1.start(t)
  over1.stop(t + 0.35)

  // Second overtone — two octaves up
  const over2 = c.createOscillator()
  const over2Gain = c.createGain()
  over2.type = 'sine'
  over2.frequency.setValueAtTime(rPitch(2400), t)
  over2Gain.gain.setValueAtTime(rVol(0.15), t)
  over2Gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  over2.connect(over2Gain)
  over2Gain.connect(reverbInput)
  over2.start(t)
  over2.stop(t + 0.25)

  // Shimmer noise
  const noiseDur = 0.1
  const noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * noiseDur), c.sampleRate)
  const noiseData = noiseBuf.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.2
  const noise = c.createBufferSource()
  noise.buffer = noiseBuf
  const noiseFilter = c.createBiquadFilter()
  noiseFilter.type = 'highpass'
  noiseFilter.frequency.value = 4000
  const noiseGain = c.createGain()
  noiseGain.gain.setValueAtTime(rVol(0.15), t)
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + noiseDur)
  noise.connect(noiseFilter)
  noiseFilter.connect(noiseGain)
  noiseGain.connect(reverbInput)
  noise.start(t)
  noise.stop(t + noiseDur)
}

export function playSummonerSpawn(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Deep ominous rumble — dark energy releasing
  const rumble = c.createOscillator()
  const rumbleGain = c.createGain()
  rumble.type = 'sawtooth'
  rumble.frequency.setValueAtTime(rPitch(90), t)
  rumble.frequency.exponentialRampToValueAtTime(rPitch(35), t + 0.7)
  rumbleGain.gain.setValueAtTime(rVol(0.55), t)
  rumbleGain.gain.exponentialRampToValueAtTime(0.001, t + 0.7)
  const rumbleFilter = c.createBiquadFilter()
  rumbleFilter.type = 'lowpass'
  rumbleFilter.frequency.value = 250
  rumble.connect(rumbleFilter)
  rumbleFilter.connect(rumbleGain)
  rumbleGain.connect(master)
  rumble.start(t)
  rumble.stop(t + 0.7)

  // Second sub layer for weight
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(60), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(25), t + 0.6)
  subGain.gain.setValueAtTime(rVol(0.5), t)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6)
  sub.connect(subGain)
  subGain.connect(master)
  sub.start(t)
  sub.stop(t + 0.6)

  // Dark chord — minor third dissonance
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const chordGain = c.createGain()
  osc1.type = 'triangle'
  osc2.type = 'triangle'
  osc1.frequency.setValueAtTime(rPitch(130), t)
  osc1.frequency.exponentialRampToValueAtTime(rPitch(100), t + 0.6)
  osc2.frequency.setValueAtTime(rPitch(156), t) // minor third
  osc2.frequency.exponentialRampToValueAtTime(rPitch(120), t + 0.6)
  chordGain.gain.setValueAtTime(rVol(0.3), t)
  chordGain.gain.exponentialRampToValueAtTime(0.001, t + 0.6)
  osc1.connect(chordGain)
  osc2.connect(chordGain)
  chordGain.connect(reverbInput)
  osc1.start(t)
  osc2.start(t)
  osc1.stop(t + 0.6)
  osc2.stop(t + 0.6)

  // Whoosh noise burst — dark energy dispersing
  const noiseDur = 0.45
  const noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * noiseDur), c.sampleRate)
  const noiseData = noiseBuf.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.5
  const noise = c.createBufferSource()
  noise.buffer = noiseBuf
  const noiseFilter = c.createBiquadFilter()
  noiseFilter.type = 'lowpass'
  noiseFilter.frequency.setValueAtTime(1500, t)
  noiseFilter.frequency.exponentialRampToValueAtTime(200, t + noiseDur)
  const noiseGain = c.createGain()
  noiseGain.gain.setValueAtTime(rVol(0.35), t + 0.02)
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + noiseDur)
  noise.connect(noiseFilter)
  noiseFilter.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(t)
  noise.stop(t + noiseDur)
}

export function playTotemSpawn(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Layer 1: Warped descending tom — like something being ripped out
  const tom = c.createOscillator()
  const tomGain = c.createGain()
  tom.type = 'sine'
  tom.frequency.setValueAtTime(rPitch(250), t)
  tom.frequency.exponentialRampToValueAtTime(rPitch(50), t + 0.15)
  tomGain.gain.setValueAtTime(rVol(0.8), t)
  tomGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
  tom.connect(tomGain)
  tomGain.connect(master)
  tom.start(t)
  tom.stop(t + 0.2)

  // Layer 2: Distorted membrane — triangle pitching down fast for body
  const membrane = c.createOscillator()
  const memGain = c.createGain()
  const memDist = c.createWaveShaper()
  membrane.type = 'triangle'
  membrane.frequency.setValueAtTime(rPitch(180), t)
  membrane.frequency.exponentialRampToValueAtTime(rPitch(40), t + 0.12)
  memGain.gain.setValueAtTime(rVol(0.55), t)
  memGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  // Soft clip curve for grit
  const curve = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const x = (i / 128) - 1
    curve[i] = Math.tanh(x * 2.5)
  }
  memDist.curve = curve
  membrane.connect(memDist)
  memDist.connect(memGain)
  memGain.connect(master)
  membrane.start(t)
  membrane.stop(t + 0.15)

  // Layer 3: Ejection whoosh — noise with quick rising then falling bandpass
  const wooshDur = 0.3
  const wooshBuf = c.createBuffer(1, Math.floor(c.sampleRate * wooshDur), c.sampleRate)
  const wooshData = wooshBuf.getChannelData(0)
  for (let i = 0; i < wooshData.length; i++) wooshData[i] = (Math.random() * 2 - 1) * 0.6
  const woosh = c.createBufferSource()
  woosh.buffer = wooshBuf
  const wooshFilter = c.createBiquadFilter()
  wooshFilter.type = 'bandpass'
  wooshFilter.Q.value = 1.5
  wooshFilter.frequency.setValueAtTime(300, t)
  wooshFilter.frequency.exponentialRampToValueAtTime(1800, t + 0.08)
  wooshFilter.frequency.exponentialRampToValueAtTime(200, t + wooshDur)
  const wooshGain = c.createGain()
  wooshGain.gain.setValueAtTime(0.001, t)
  wooshGain.gain.linearRampToValueAtTime(rVol(0.5), t + 0.05)
  wooshGain.gain.exponentialRampToValueAtTime(0.001, t + wooshDur)
  woosh.connect(wooshFilter)
  wooshFilter.connect(wooshGain)
  wooshGain.connect(reverbInput)
  woosh.start(t)
  woosh.stop(t + wooshDur)
}

export function playBeatDash(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Layer 1: Sub thump — gut punch, fast attack
  const thump = c.createOscillator()
  const thumpGain = c.createGain()
  thump.type = 'sine'
  thump.frequency.setValueAtTime(rPitch(90), t)
  thump.frequency.exponentialRampToValueAtTime(rPitch(30), t + 0.2)
  thumpGain.gain.setValueAtTime(rVol(0.7), t)
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
  thump.connect(thumpGain)
  thumpGain.connect(master)
  thump.start(t)
  thump.stop(t + 0.2)

  // Layer 2: Chunky "whomp" — the satisfying part
  // Descending chord hit — two notes a fifth apart for richness
  const whomp1 = c.createOscillator()
  const whomp2 = c.createOscillator()
  const whompGain = c.createGain()
  whomp1.type = 'triangle'
  whomp2.type = 'triangle'
  whomp1.frequency.setValueAtTime(rPitch(220), t)
  whomp1.frequency.exponentialRampToValueAtTime(rPitch(110), t + 0.18)
  whomp2.frequency.setValueAtTime(rPitch(330), t)  // perfect fifth
  whomp2.frequency.exponentialRampToValueAtTime(rPitch(165), t + 0.18)
  whompGain.gain.setValueAtTime(rVol(0.4), t)
  whompGain.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
  whomp1.connect(whompGain)
  whomp2.connect(whompGain)
  whompGain.connect(master)
  whomp1.start(t)
  whomp2.start(t)
  whomp1.stop(t + 0.22)
  whomp2.stop(t + 0.22)

  // Layer 3: Bright accent — short, warm, through reverb for shimmer
  const accent = c.createOscillator()
  const accentGain = c.createGain()
  accent.type = 'sine'
  accent.frequency.setValueAtTime(rPitch(800), t)
  accent.frequency.exponentialRampToValueAtTime(rPitch(500), t + 0.1)
  accentGain.gain.setValueAtTime(rVol(0.3), t)
  accentGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  accent.connect(accentGain)
  accentGain.connect(reverbInput)
  accent.start(t)
  accent.stop(t + 0.12)

  // Layer 4: Happy ding — major third interval, slight delay for "reward" feel
  const ding = c.createOscillator()
  const ding2 = c.createOscillator()
  const dingGain = c.createGain()
  ding.type = 'sine'
  ding2.type = 'sine'
  ding.frequency.setValueAtTime(rPitch(1050), t + 0.03)
  ding2.frequency.setValueAtTime(rPitch(1320), t + 0.03)  // major third
  dingGain.gain.setValueAtTime(0.001, t + 0.03)
  dingGain.gain.linearRampToValueAtTime(rVol(0.15), t + 0.05)
  dingGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  ding.connect(dingGain)
  ding2.connect(dingGain)
  dingGain.connect(reverbInput)
  ding.start(t + 0.03)
  ding2.start(t + 0.03)
  ding.stop(t + 0.25)
  ding2.stop(t + 0.25)

  // Layer 5: Noise snap — punchy transient
  const noiseDur = 0.06
  const noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * noiseDur), c.sampleRate)
  const noiseData = noiseBuf.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.5
  const noise = c.createBufferSource()
  noise.buffer = noiseBuf
  const noiseFilter = c.createBiquadFilter()
  noiseFilter.type = 'highpass'
  noiseFilter.frequency.value = 1500
  const noiseGain = c.createGain()
  noiseGain.gain.setValueAtTime(rVol(0.4), t)
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + noiseDur)
  noise.connect(noiseFilter)
  noiseFilter.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(t)
  noise.stop(t + noiseDur)
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

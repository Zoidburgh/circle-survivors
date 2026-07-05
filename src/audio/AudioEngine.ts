import { initSynth, playKick, playBass, playChord, playPluck } from './MusicSynth.ts'
import { initBeatLoop, startBeatLoop, loadPreset, getCurrentPresetName, setGenerative, setBeatLoopScale, setPalette, setFeel } from './BeatLoop.ts'
import { BEAT_PRESETS } from './BeatPresets.ts'
import { PALETTES } from './Palettes.ts'
import { FEELS } from './Feels.ts'
import { initDrone, startDrone } from './MusicDrone.ts'
import { generateWaveMusic, pickMelodyNote, pickChordNotes, degreeToFreq } from './MusicScale.ts'
import type { WaveMusic } from './MusicScale.ts'
import { initMusicalSFX, setMusicalSFXMusic, playAttackNoteForEnemy, isScaleLock } from './MusicalSFX.ts'
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
let limiter: DynamicsCompressorNode
let reverbInput: GainNode
let reverbWet: GainNode

// ── Global voice budget ──────────────────────────────────────────────────────
// Web Audio has no built-in polyphony cap. Without one, a dense fight (swarm attacks, stacked
// explosions, the legacy non-scaleLock enemy path) spawns unbounded oscillators → CPU spikes and a
// mud of voices you can't read. We COUNT every voice by wrapping the context's node constructors
// (see ensureContext) and let high-density emitters refuse new low-priority voices near the ceiling.
// This is the CPU/mud half of the safety net; the brickwall limiter below is the amplitude half.
let activeVoices = 0
const HARD_VOICE_CAP = 72   // absolute ceiling — even high-priority sounds drop past this
const SOFT_VOICE_CAP = 48   // past this, only high-priority (player-relevant) voices are admitted
/** Current count of live oscillator/buffer voices (incl. the few continuous music voices). */
export function getActiveVoiceCount(): number { return activeVoices }
/** May a new sound spawn now? Low-priority (ambient/enemy chorus) yields first; high-priority
 *  (player-relevant: hits, explosions, dashes) holds out to the hard ceiling. */
function admitVoice(priority: 'high' | 'low'): boolean {
  if (activeVoices >= HARD_VOICE_CAP) return false
  if (priority === 'low' && activeVoices >= SOFT_VOICE_CAP) return false
  return true
}

const lastTickByType = new Map<string, number>()
const TICK_MIN_INTERVAL = AUDIO_THROTTLE_INTERVAL

let currentMusic: WaveMusic | null = null
let explodeWalkStep = 0   // walks the scale so successive explosions are different in-key notes

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
    // latencyHint 'interactive' = smallest practical output buffer → lowest scheduling delay.
    // This is the default, but pinning it guards against a browser picking a larger buffer.
    // Critical for reaction sounds (player hit) that must land on the exact off-beat frame.
    ctx = new AudioContext({ latencyHint: 'interactive' })

    // Count every oscillator/buffer voice globally for the voice budget. We use
    // addEventListener('ended') (NOT node.onended) so a caller's own onended handler still fires.
    // Continuous music voices (drone/pad/bass/LFOs) never "end" and so sit as a small baseline —
    // the caps below have ample headroom for that.
    const origOsc = ctx.createOscillator.bind(ctx)
    ctx.createOscillator = function (): OscillatorNode {
      const node = origOsc()
      activeVoices++
      node.addEventListener('ended', () => { activeVoices = Math.max(0, activeVoices - 1) })
      return node
    }
    const origBuf = ctx.createBufferSource.bind(ctx)
    ctx.createBufferSource = function (): AudioBufferSourceNode {
      const node = origBuf()
      activeVoices++
      node.addEventListener('ended', () => { activeVoices = Math.max(0, activeVoices - 1) })
      return node
    }

    compressor = ctx.createDynamicsCompressor()
    compressor.threshold.value = -12
    compressor.knee.value = 6
    compressor.ratio.value = 8
    compressor.attack.value = 0.003
    compressor.release.value = 0.1

    // Brickwall limiter — the FINAL node, so dense scenes can't clip past 0dBFS. Web Audio has no
    // true look-ahead limiter, but a hard-knee, high-ratio, 1ms-attack compressor pins peaks just
    // under 0. Glue compressor (musical gain reduction) → limiter (safety ceiling) → destination.
    limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -1.5
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.001
    limiter.release.value = 0.05
    compressor.connect(limiter)
    limiter.connect(ctx.destination)

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
    initMusicalSFX(ctx, reverbInput)   // musical combat-SFX layer (shares the bus)

    // Start with wave 1 music
    currentMusic = generateWaveMusic(1)
    setMusicalSFXMusic(currentMusic)
    setBeatLoopScale(currentMusic.melodyNotes)   // tracks follow the wave's key/mode (not fixed C minor)
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

/** Call every frame during gameplay — auto-fixes suspended AudioContext on mobile */
export function tickAudioHealth(): void {
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

let currentBeatIndex = 0
export function switchBeat(index: number): void {
  ensureContext()
  const preset = BEAT_PRESETS[index]
  if (preset) {
    currentBeatIndex = index
    loadPreset(preset)
    setGenerative(preset.name === 'Generative')
  }
}

/** Advance to the next beat preset (wraps). Used by the music-note HUD button. */
export function cycleBeat(): void {
  switchBeat((currentBeatIndex + 1) % BEAT_PRESETS.length)
}
export function getBeatIndex(): number { return currentBeatIndex }

export function getBeatName(): string {
  return getCurrentPresetName()
}

export function getBeatCount(): number {
  return BEAT_PRESETS.length
}

export function getBeatNames(): string[] {
  return BEAT_PRESETS.map(p => p.name)
}

// ── KIT / palette (voices + pad/bass + swing), orthogonal to the beat preset ──
let currentPaletteIndex = 0
export function switchPalette(index: number): void {
  ensureContext()
  const p = PALETTES[index]
  if (p) { currentPaletteIndex = index; setPalette(p) }
}
export function getPaletteIndex(): number { return currentPaletteIndex }
export function getPaletteNames(): string[] { return PALETTES.map(p => p.name) }

// ── TIME-FEEL (step-tempo scale + swing override), orthogonal to both KIT and TRACK ──
let currentFeelIndex = 0
export function switchFeel(index: number): void {
  ensureContext()
  const f = FEELS[index]
  if (f) { currentFeelIndex = index; setFeel(f) }
}
export function getFeelIndex(): number { return currentFeelIndex }
export function getFeelNames(): string[] { return FEELS.map(f => f.name) }

/** Get audio context time — single source of truth for all timing */
export function getAudioTime(): number {
  if (!ctx) return 0
  return ctx.currentTime
}

export function setWaveMusic(waveNum: number): void {
  ensureContext()
  currentMusic = generateWaveMusic(waveNum)
  setMusicalSFXMusic(currentMusic)
  setBeatLoopScale(currentMusic.melodyNotes)   // keep the tracks in the same key as everything else
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
  // Clean rising sine (the sound we like), consonant pitch variation so overlaps chord.
  const v = [1.0, 1.26, 1.5][Math.floor(Math.random() * 3)]!
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(330 * v), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(500 * v), t + 0.1)
  gain.gain.setValueAtTime(2.2, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  osc.connect(gain); gain.connect(master)
  osc.start(t); osc.stop(t + 0.15)
}

export function playKill(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Clean rising sine. Fuller pentatonic pitch set (root/M2/M3/5th/M6) so deaths vary more and still
  // chord when they overlap.
  const v = [1.0, 1.122, 1.26, 1.498, 1.682][Math.floor(Math.random() * 5)]!
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(440 * v), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(880 * v), t + 0.25)
  gain.gain.setValueAtTime(rVol(1.7), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  osc.connect(gain); gain.connect(reverbInput)
  osc.start(t); osc.stop(t + 0.3)
}

// Dramatic BOSS DEATH — a loud, punchy, cinematic explosion (NOT a musical scale). A big detonation
// (deep sub sweep + noise blast + power-down saw), then a DESCENDING cascade of punchy impacts — each
// an instant-attack pitched thud + sub + noise-click snap, pitch dropping and volume building — that
// lands on a huge final slam. Routed dry to master for real punch; the master compressor tames peaks.
export function playBossDeathBoom(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  const makeNoise = (dur: number): AudioBuffer => {
    const b = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate)
    const d = b.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    return b
  }

  // ── 1. Initial detonation ── the rewarding "hit confirm" PUNCH lands right on the kill
  // Click snap — bright transient attack (the crack of the impact) so the kill reads as a punch.
  const snap0 = c.createBufferSource(); snap0.buffer = makeNoise(0.06)
  const snap0hp = c.createBiquadFilter(); snap0hp.type = 'highpass'; snap0hp.frequency.value = 850
  const snap0g = c.createGain(); snap0g.gain.setValueAtTime(1.2, t); snap0g.gain.exponentialRampToValueAtTime(0.0004, t + 0.05)
  snap0.connect(snap0hp); snap0hp.connect(snap0g); snap0g.connect(master)
  snap0.start(t); snap0.stop(t + 0.06)
  // Mid crack — bright pitched attack sweeping down; makes the boom SPEAK (the satisfying, rewarding
  // punch — without it the impact is all low-end thud you feel but don't "hear crack").
  const crk = c.createOscillator(); const crkG = c.createGain()
  crk.type = 'triangle'
  crk.frequency.setValueAtTime(440, t)
  crk.frequency.exponentialRampToValueAtTime(85, t + 0.14)
  crkG.gain.setValueAtTime(1.5, t)                                    // instant, punchy
  crkG.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  crk.connect(crkG); crkG.connect(master)
  crk.start(t); crk.stop(t + 0.16)
  // Deep sub — instant punch, sweeping down
  const sub = c.createOscillator(); const subG = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(150, t)
  sub.frequency.exponentialRampToValueAtTime(34, t + 0.6)
  subG.gain.setValueAtTime(1.7, t)                                    // instant punch
  subG.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
  sub.connect(subG); subG.connect(master)
  sub.start(t); sub.stop(t + 0.92)

  const noise = c.createBufferSource(); noise.buffer = makeNoise(0.55)
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'
  lp.frequency.setValueAtTime(2400, t); lp.frequency.exponentialRampToValueAtTime(240, t + 0.45)
  const nG = c.createGain(); nG.gain.setValueAtTime(1.0, t); nG.gain.exponentialRampToValueAtTime(0.001, t + 0.55)
  noise.connect(lp); lp.connect(nG); nG.connect(master)
  noise.start(t); noise.stop(t + 0.55)

  const saw = c.createOscillator(); const sawG = c.createGain(); const sawF = c.createBiquadFilter()
  saw.type = 'sawtooth'
  saw.frequency.setValueAtTime(420, t); saw.frequency.exponentialRampToValueAtTime(58, t + 0.6)
  sawF.type = 'lowpass'; sawF.frequency.setValueAtTime(1500, t); sawF.frequency.exponentialRampToValueAtTime(260, t + 0.6)
  sawG.gain.setValueAtTime(0.0001, t); sawG.gain.linearRampToValueAtTime(0.3, t + 0.02); sawG.gain.exponentialRampToValueAtTime(0.001, t + 0.66)
  saw.connect(sawF); sawF.connect(sawG); sawG.connect(reverbInput)
  saw.start(t); saw.stop(t + 0.68)

  // ── 2. Descending punchy impact cascade → huge final slam ──
  let f = 300
  const hits = 5
  for (let k = 0; k < hits; k++) {
    const last = k === hits - 1
    const at = t + 0.1 + k * 0.075
    const vol = last ? 1.7 : 0.7 + k * 0.12                           // builds to the final slam
    // Body — pitched thud with a fast downward sweep = punch
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(f * 1.6, at)
    o.frequency.exponentialRampToValueAtTime(f * 0.55, at + 0.1)
    g.gain.setValueAtTime(vol * 0.55, at)                            // instant attack
    g.gain.exponentialRampToValueAtTime(0.001, at + (last ? 0.7 : 0.2))
    o.connect(g); g.connect(master)
    o.start(at); o.stop(at + (last ? 0.72 : 0.22))
    // Sub thud
    const s2 = c.createOscillator(); const sg2 = c.createGain()
    s2.type = 'sine'
    s2.frequency.setValueAtTime(f * 0.8, at)
    s2.frequency.exponentialRampToValueAtTime(f * 0.4, at + 0.12)
    sg2.gain.setValueAtTime(vol * 0.6, at)
    sg2.gain.exponentialRampToValueAtTime(0.001, at + (last ? 0.8 : 0.24))
    s2.connect(sg2); sg2.connect(master)
    s2.start(at); s2.stop(at + (last ? 0.82 : 0.26))
    // Click snap — the punch transient
    const cn = c.createBufferSource(); cn.buffer = makeNoise(0.05)
    const chp = c.createBiquadFilter(); chp.type = 'highpass'; chp.frequency.value = 1000
    const cg = c.createGain(); cg.gain.setValueAtTime(vol * 0.4, at); cg.gain.exponentialRampToValueAtTime(0.0004, at + 0.03)
    cn.connect(chp); chp.connect(cg); cg.connect(master)
    cn.start(at); cn.stop(at + 0.05)
    // Reverb throw on the final slam for a big cinematic tail
    if (last) { const rs = c.createGain(); rs.gain.value = 0.45; g.connect(rs); sg2.connect(rs); rs.connect(reverbInput) }
    f *= 0.8                                                          // descending collapse
  }
}

// Node DESTRUCTION boom — layered UNDER the metallic break note so a single node shattering has real
// body/weight to match the visual shatter burst, not just a ding. Short punchy sub thump + a lowpassed
// noise crack. delaySec matches the note's stagger so AOE breaks ring out together on the boom's decay.
export function playNodeBreak(delaySec = 0): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime + delaySec
  // ── Deep boom — the weight (sub + growl harmonics) ──
  const sub = c.createOscillator(); const subG = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(150, t)
  sub.frequency.exponentialRampToValueAtTime(26, t + 0.2)
  subG.gain.setValueAtTime(rVol(3.0), t)                             // instant punch, big boom
  subG.gain.exponentialRampToValueAtTime(0.001, t + 0.46)
  sub.connect(subG); subG.connect(master)
  sub.start(t); sub.stop(t + 0.48)
  const grw = c.createOscillator(); const grwG = c.createGain(); const grwLp = c.createBiquadFilter()
  grw.type = 'sawtooth'
  grw.frequency.setValueAtTime(115, t)
  grw.frequency.exponentialRampToValueAtTime(32, t + 0.18)
  grwLp.type = 'lowpass'; grwLp.frequency.setValueAtTime(620, t); grwLp.frequency.exponentialRampToValueAtTime(260, t + 0.18)
  grwG.gain.setValueAtTime(rVol(2.0), t)
  grwG.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
  grw.connect(grwLp); grwLp.connect(grwG); grwG.connect(master)
  grw.start(t); grw.stop(t + 0.3)
  const rs = c.createGain(); rs.gain.value = 0.5; grwG.connect(rs); rs.connect(reverbInput)   // cinematic tail

  // ── Sharp impact crack — the SNAP that makes it hit (bright noise + a pitched down-sweep) ──
  const cbuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.06), c.sampleRate)
  const cd = cbuf.getChannelData(0); for (let i = 0; i < cd.length; i++) cd[i] = Math.random() * 2 - 1
  const crackN = c.createBufferSource(); crackN.buffer = cbuf
  const chp = c.createBiquadFilter(); chp.type = 'highpass'; chp.frequency.value = 900
  const cnG = c.createGain(); cnG.gain.setValueAtTime(rVol(1.3), t); cnG.gain.exponentialRampToValueAtTime(0.0004, t + 0.05)
  crackN.connect(chp); chp.connect(cnG); cnG.connect(master)
  crackN.start(t); crackN.stop(t + 0.06)
  const crk = c.createOscillator(); const crkG = c.createGain()
  crk.type = 'triangle'
  crk.frequency.setValueAtTime(360, t)
  crk.frequency.exponentialRampToValueAtTime(58, t + 0.13)
  crkG.gain.setValueAtTime(rVol(1.5), t)
  crkG.gain.exponentialRampToValueAtTime(0.001, t + 0.14)
  crk.connect(crkG); crkG.connect(master)
  crk.start(t); crk.stop(t + 0.15)

  // ── Metallic SHATTER debris — bright INHARMONIC pings scattering into the reverb (the drama: the
  // node exploding into pieces, matching the shatter burst — dissonant ratios = clang, not a chord). ──
  const ratios = [1, 1.83, 2.61, 3.74, 5.2]
  for (let k = 0; k < ratios.length; k++) {
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'sine'
    o.frequency.value = 440 * ratios[k]! * (0.98 + Math.random() * 0.04)
    const st = t + Math.random() * 0.045                             // scatter timing
    g.gain.setValueAtTime(0.0001, st)
    g.gain.linearRampToValueAtTime(rVol(0.55 / (1 + k * 0.4)), st + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0005, st + 0.4 + Math.random() * 0.2)
    o.connect(g); g.connect(reverbInput)
    o.start(st); o.stop(st + 0.66)
  }
}

// Core "shield crash" synthesis — a descending dissonant shatter (ping + sub + noise + moan).
// Shared by the player damage hit and the shield-break event so the two stay in sync. `speed`
// scales every envelope time (smaller = quicker/snappier), `pitchMul` shifts all oscillators
// (higher = glassier), and the DRY layers (sub + noise) route to `dryDest` so a caller can
// color them through a filter; the WET layers (ping + moan) always feed reverb. The old player
// hit was a thin tonal stab that felt dinky — it now reuses this fuller crash instead.
function shieldCrash(speed: number, pitchMul: number, dryDest: AudioNode): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Descending dissonant crash — minor second interval, feels wrong
  const ping = c.createOscillator()
  const ping2 = c.createOscillator()
  const pingGain = c.createGain()
  ping.type = 'sawtooth'
  ping2.type = 'sawtooth'
  ping.frequency.setValueAtTime(rPitch(1400 * pitchMul), t)
  ping.frequency.exponentialRampToValueAtTime(rPitch(180 * pitchMul), t + 0.35 * speed)
  ping2.frequency.setValueAtTime(rPitch(1480 * pitchMul), t) // minor second = dissonance
  ping2.frequency.exponentialRampToValueAtTime(rPitch(170 * pitchMul), t + 0.35 * speed)
  pingGain.gain.setValueAtTime(rVol(0.3), t)
  pingGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4 * speed)
  const pingFilter = c.createBiquadFilter()
  pingFilter.type = 'lowpass'
  pingFilter.frequency.setValueAtTime(4000, t)
  pingFilter.frequency.exponentialRampToValueAtTime(500, t + 0.35 * speed)
  ping.connect(pingFilter)
  ping2.connect(pingFilter)
  pingFilter.connect(pingGain)
  pingGain.connect(reverbInput)
  ping.start(t)
  ping2.start(t)
  ping.stop(t + 0.4 * speed)
  ping2.stop(t + 0.4 * speed)

  // Heavy sub drop — ominous gut punch
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(120 * pitchMul), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(20 * pitchMul), t + 0.3 * speed)
  subGain.gain.setValueAtTime(rVol(0.6), t)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3 * speed)
  sub.connect(subGain)
  subGain.connect(dryDest)
  sub.start(t)
  sub.stop(t + 0.3 * speed)

  // Harsh shatter noise — loud, aggressive
  const noiseDur = 0.25 * speed
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
  noiseGain.connect(dryDest)
  noise.start(t)
  noise.stop(t + noiseDur)

  // Dark descending moan — tritone dissonance, something went wrong
  const moan = c.createOscillator()
  const moan2 = c.createOscillator()
  const moanGain = c.createGain()
  moan.type = 'triangle'
  moan2.type = 'triangle'
  moan.frequency.setValueAtTime(rPitch(300 * pitchMul), t + 0.05 * speed)
  moan.frequency.exponentialRampToValueAtTime(rPitch(150 * pitchMul), t + 0.5 * speed)
  moan2.frequency.setValueAtTime(rPitch(424 * pitchMul), t + 0.05 * speed) // tritone = devil's interval
  moan2.frequency.exponentialRampToValueAtTime(rPitch(212 * pitchMul), t + 0.5 * speed)
  moanGain.gain.setValueAtTime(0.001, t + 0.05 * speed)
  moanGain.gain.linearRampToValueAtTime(rVol(0.2), t + 0.12 * speed)
  moanGain.gain.exponentialRampToValueAtTime(0.001, t + 0.5 * speed)
  moan.connect(moanGain)
  moan2.connect(moanGain)
  moanGain.connect(reverbInput)
  moan.start(t + 0.05 * speed)
  moan2.start(t + 0.05 * speed)
  moan.stop(t + 0.5 * speed)
  moan2.stop(t + 0.5 * speed)
}

export function playPlayerHit(): void {
  // Was a thin tonal stab (too dinky) — now the fuller shield-crash body, sped up for a
  // snappier impact. Dry layers go straight to master: this is the "clean" reference version,
  // while playShieldBreak runs the same crash through a filter to stay distinct.
  shieldCrash(0.8, 1.0, master)
}

export function playVolatileExplosion(buildupSec = 1.0): void {
  ensureContext()
  const c = ctx!
  // ~12 voices per explosion — high priority (you must hear a detonation), but still bail at the
  // hard ceiling so a pile of simultaneous blasts can't blow the budget.
  if (!admitVoice('high')) return
  const t = c.currentTime
  // Boom lands ON the visual burst: the sound is triggered at the buildup START, the burst is
  // `buildupSec` later (−~one frame the trigger already consumed). Everything keys off popTime.
  const popTime = t + Math.max(0.12, buildupSec - 0.02)

  // Charge RISER — pitch + brightness + volume all rise together and resolve onto the key's ROOT
  // exactly on the boom. Smooth, accelerating tension (exponential ramps speed up toward the end)
  // that lands as a musical resolution into the bang. Two detuned saws through an opening lowpass
  // = the classic "about to blow" sweep, in-key so it sits in the music.
  // Build-up = a warm ASCENDING ARPEGGIO that climbs the scale and RESOLVES onto the boom's note.
  // Discrete in-key notes (musical + rhythmic, tension→resolution) instead of a continuous glide
  // (siren-like / annoying) or percussive thumps (clunky). It swells as it climbs, and the whole
  // figure is transposed by the walk so each explosion is a different phrase, like the rings.
  const baseDeg = explodeWalkStep++ % 5
  const tonic = currentMusic ? degreeToFreq(currentMusic, baseDeg, 0) : 262
  const boomTonic = tonic * 0.4   // lower-pitched boom
  if (currentMusic) {
    const aStart = t + 0.02   // present from the very start of the animation

    // Relaxing HUM that builds to the explosion — a warm sustained chord on a STABLE pitch (no
    // glide/siren), in-key (tonic + octave below + a detuned twin for chorus warmth). Audible from
    // the first instant and gently swelling (volume + a slowly-opening filter) into the boom, on
    // which it resolves. Calm, not annoying; the crescendo IS the build.
    const voices: { f: number; type: OscillatorType; g: number }[] = [
      { f: tonic * 0.5, type: 'sine', g: 0.15 },        // warm body, an octave below
      { f: tonic, type: 'triangle', g: 0.1 },           // the hum's note
      { f: tonic * 1.005, type: 'triangle', g: 0.1 },   // detuned twin → gentle chorus shimmer
    ]
    for (const v of voices) {
      const o = c.createOscillator()
      const g = c.createGain()
      const lp = c.createBiquadFilter()
      o.type = v.type
      o.frequency.setValueAtTime(v.f, aStart)           // stable — no pitch sweep
      lp.type = 'lowpass'; lp.Q.value = 0.6
      lp.frequency.setValueAtTime(650, aStart)
      lp.frequency.exponentialRampToValueAtTime(1500, popTime)   // opens gently as it builds (warm)
      g.gain.setValueAtTime(rVol(v.g * 0.7), aStart)    // clearly present from the first instant
      g.gain.linearRampToValueAtTime(rVol(v.g * 1.3), popTime)   // steady swell = the build
      g.gain.exponentialRampToValueAtTime(0.001, popTime + 0.06) // hands off to the boom
      o.connect(lp); lp.connect(g); g.connect(master)
      o.start(aStart); o.stop(popTime + 0.07)
    }

    // Fuse CRACKLE bed — one procedurally-generated crackle: irregular pops with short tails (like
    // a burning fuse), DENSER toward the boom so it reads as "the fuse is burning down, about to
    // pop." Warm (low-passed, opens as it intensifies) with a gentle in-key resonant tilt, swelling
    // subtly under the hum. Single buffer/source = cheap and sounds organic, not mechanical.
    const cspan = Math.max(0.1, popTime - aStart)
    const crBuf = c.createBuffer(1, Math.floor(c.sampleRate * cspan), c.sampleRate)
    const cd = crBuf.getChannelData(0)
    let popv = 0
    for (let i = 0; i < cd.length; i++) {
      const prog = i / cd.length
      const density = 0.0018 + prog * prog * 0.004       // audible from the start → busier near the boom
      if (Math.random() < density) popv = (Math.random() * 2 - 1) * (0.4 + Math.random() * 0.6)
      cd[i] = popv
      popv *= 0.9986                                      // short tail per pop = crackle, not clicks
    }
    const cr = c.createBufferSource()
    cr.buffer = crBuf
    const clp = c.createBiquadFilter()
    clp.type = 'lowpass'
    clp.frequency.setValueAtTime(900, aStart)
    clp.frequency.exponentialRampToValueAtTime(2200, popTime)   // opens as it intensifies (stays warm)
    // Two resonant peaks tuned to scale tones (root + a chord tone) give the noise a MUSICAL,
    // in-key colour — it rings faintly at notes from the song — while the noise underneath keeps
    // it a crackle, not a bell. Stronger Q/gain than before so the pitch tilt is actually audible.
    const cpk = c.createBiquadFilter()
    cpk.type = 'peaking'
    cpk.frequency.value = degreeToFreq(currentMusic, baseDeg, 1)
    cpk.Q.value = 1.6
    cpk.gain.value = 11
    const cpk2 = c.createBiquadFilter()
    cpk2.type = 'peaking'
    cpk2.frequency.value = degreeToFreq(currentMusic, baseDeg + 2, 1)  // a chord tone above
    cpk2.Q.value = 1.6
    cpk2.gain.value = 9
    const cg = c.createGain()
    cg.gain.setValueAtTime(rVol(0.07), aStart)
    cg.gain.linearRampToValueAtTime(rVol(0.18), popTime)        // subtle swell into the boom
    cg.gain.exponentialRampToValueAtTime(0.001, popTime + 0.05)
    cr.connect(clp); clp.connect(cpk); cpk.connect(cpk2); cpk2.connect(cg); cg.connect(master)
    cr.start(aStart); cr.stop(popTime + 0.06)
  }

  // Boom — energy lives in the AUDIBLE low-mids (100-200Hz) that any speaker reproduces, so you
  // actually HEAR it, with only a modest deep-sub layer for chest depth.

  // Low-mid body — the clean low fundamental (the "felt" weight).
  const body = c.createOscillator()
  const bodyGain = c.createGain()
  body.type = 'sine'
  body.frequency.setValueAtTime(boomTonic * 1.45, popTime)
  body.frequency.exponentialRampToValueAtTime(boomTonic, popTime + 0.24)
  bodyGain.gain.setValueAtTime(rVol(2.6), popTime)
  bodyGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.24)
  body.connect(bodyGain); bodyGain.connect(master)
  body.start(popTime); body.stop(popTime + 0.24)

  // GROWL — a sawtooth on the SAME low note through a moderate lowpass. Its rich harmonic stack
  // (200/300/400…Hz) is what your ear actually HEARS as bass on small speakers — without it the
  // pure-sine body reads as a muffled thud. This is what turns the boom into a real bass note.
  const growl = c.createOscillator()
  const growlGain = c.createGain()
  const growlLp = c.createBiquadFilter()
  growl.type = 'sawtooth'
  growl.frequency.setValueAtTime(boomTonic * 1.45, popTime)
  growl.frequency.exponentialRampToValueAtTime(boomTonic, popTime + 0.22)
  growlLp.type = 'lowpass'
  growlLp.frequency.setValueAtTime(900, popTime)            // lets several harmonics through = audible growl
  growlLp.frequency.exponentialRampToValueAtTime(420, popTime + 0.22)
  growlGain.gain.setValueAtTime(rVol(1.5), popTime)
  growlGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.22)
  growl.connect(growlLp); growlLp.connect(growlGain); growlGain.connect(master)
  growl.start(popTime); growl.stop(popTime + 0.23)

  // Sub — chest depth an octave below the note, modest so it doesn't pump the compressor.
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(boomTonic * 0.85, popTime)
  sub.frequency.exponentialRampToValueAtTime(boomTonic * 0.5, popTime + 0.18)
  subGain.gain.setValueAtTime(rVol(1.45), popTime)
  subGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.18)
  sub.connect(subGain); subGain.connect(master)
  sub.start(popTime); sub.stop(popTime + 0.18)

  // Mid crack — bright attack (tuned up from the note) that makes the boom SPEAK on small speakers.
  const crack = c.createOscillator()
  const crackGain = c.createGain()
  crack.type = 'triangle'
  crack.frequency.setValueAtTime(boomTonic * 2.6, popTime)
  crack.frequency.exponentialRampToValueAtTime(boomTonic * 0.85, popTime + 0.12)
  crackGain.gain.setValueAtTime(rVol(1.8), popTime)
  crackGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.12)
  crack.connect(crackGain); crackGain.connect(master)
  crack.start(popTime); crack.stop(popTime + 0.12)

  // Short noise transient — grit + presence, low-passed but with enough mid to be heard.
  const boomBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.1), c.sampleRate)
  const boomData = boomBuf.getChannelData(0)
  for (let i = 0; i < boomData.length; i++) boomData[i] = (Math.random() * 2 - 1) * 0.7
  const boomNoise = c.createBufferSource()
  boomNoise.buffer = boomBuf
  const boomFilter = c.createBiquadFilter()
  boomFilter.type = 'lowpass'
  boomFilter.frequency.setValueAtTime(1300, popTime)
  boomFilter.frequency.exponentialRampToValueAtTime(320, popTime + 0.1)
  const boomGain = c.createGain()
  boomGain.gain.setValueAtTime(rVol(1.0), popTime)
  boomGain.gain.exponentialRampToValueAtTime(0.001, popTime + 0.1)
  boomNoise.connect(boomFilter); boomFilter.connect(boomGain); boomGain.connect(master)
  boomNoise.start(popTime); boomNoise.stop(popTime + 0.1)

  // DETONATION punch — the same chest-hitting weight as the boss-death boom, layered UNDER the in-key
  // boom on the final impact: a fixed deep sub sweep (below the tuned layers) + a high-passed click
  // snap for the punch attack. Instant attack = punchy. Modest gain since volatiles fire often — the
  // master compressor + voice cap keep simultaneous blasts from blowing the budget.
  const det = c.createOscillator(); const detG = c.createGain()
  det.type = 'sine'
  det.frequency.setValueAtTime(140, popTime)
  det.frequency.exponentialRampToValueAtTime(36, popTime + 0.45)
  detG.gain.setValueAtTime(rVol(1.6), popTime)                  // instant punch
  detG.gain.exponentialRampToValueAtTime(0.001, popTime + 0.6)
  det.connect(detG); detG.connect(master)
  det.start(popTime); det.stop(popTime + 0.62)

  const snapBuf = c.createBuffer(1, Math.floor(c.sampleRate * 0.05), c.sampleRate)
  const snapData = snapBuf.getChannelData(0)
  for (let i = 0; i < snapData.length; i++) snapData[i] = Math.random() * 2 - 1
  const snap = c.createBufferSource(); snap.buffer = snapBuf
  const snapHp = c.createBiquadFilter(); snapHp.type = 'highpass'; snapHp.frequency.value = 1100
  const snapG = c.createGain()
  snapG.gain.setValueAtTime(rVol(0.7), popTime)
  snapG.gain.exponentialRampToValueAtTime(0.0004, popTime + 0.03)
  snap.connect(snapHp); snapHp.connect(snapG); snapG.connect(master)
  snap.start(popTime); snap.stop(popTime + 0.05)
}

// Heal-mode explosion — the NOURISH counterpart to playVolatileExplosion. Same buildup→resolve
// timing (so it lands on the visual burst), but instead of a boom it blooms into a soft, bright
// in-key MAJOR chord — a bell/harp "halo" that resolves up rather than detonating down. Routed
// partly through reverb for an airy shimmer. Reads unmistakably as benevolent.
// `full` = the blast will actually heal someone (player or an enemy below max HP). When false the
// BLOOM is kept tame so a no-op heal blast (everyone already topped up) doesn't blare; when true the
// resolve rings out at its normal level. The glitter buildup is the same either way (just gentle).
export function playHealExplosion(buildupSec = 1.0, full = false): void {
  ensureContext()
  const c = ctx!
  if (!admitVoice('high')) return
  const t = c.currentTime
  const popTime = t + Math.max(0.12, buildupSec - 0.02)
  const baseDeg = explodeWalkStep++ % 5
  const bloom = full ? 1 : 0.7    // bloom loudness — louder when it doesn't hit the player (the player-hit
                                  // `full` case is already loud enough at 1.0)

  // Buildup — GLITTER/FAIRY-DUST: a sprinkle of tiny high in-key bell twinkles scattered across the
  // window, gently getting denser toward the bloom. Each is a soft, short, high sine ping through
  // reverb — discrete sparkles (magical) rather than a continuous tone (which read as a siren).
  if (currentMusic) {
    const aStart = t + 0.02
    const span = Math.max(0.12, popTime - aStart)
    const twinkles = Math.min(14, Math.max(5, Math.round(span * 12)))
    for (let i = 0; i < twinkles; i++) {
      // Bias placement toward the end so the glitter accelerates into the heal (denser late).
      const frac = Math.pow(Math.random(), 0.6)
      const tt = aStart + frac * span
      // High, airy in-key notes (octaves 2–3) — pentatonic-ish via scale degrees = always pretty.
      const deg = (baseDeg + [0, 2, 4, 7, 9][Math.floor(Math.random() * 5)]!) % 7
      const oct = 2 + (Math.random() < 0.45 ? 1 : 0)
      const f = degreeToFreq(currentMusic, deg, oct)
      const o = c.createOscillator()
      const g = c.createGain()
      o.type = 'sine'
      o.frequency.setValueAtTime(f, tt)
      // Soft pings that grow louder (linearly) as the glitter densifies toward the bloom.
      const lvl = rVol(0.014 + 0.026 * frac)
      const dur = 0.1 + Math.random() * 0.14
      g.gain.setValueAtTime(0.0001, tt)
      g.gain.linearRampToValueAtTime(lvl, tt + 0.006)          // tiny attack = a "ting"
      g.gain.exponentialRampToValueAtTime(0.001, tt + dur)     // quick sparkle decay
      o.connect(g); g.connect(reverbInput)                     // reverb only = airy, distant glitter
      o.start(tt); o.stop(tt + dur + 0.02)
    }
  }

  // The BLOOM — a SOFT warm major chord (root + third + fifth + octave) on gentle sine bells. Toned
  // way down from the original so the resolve is a quiet, pretty chime, not a punchy hit. Slow-ish
  // attack + floaty tail, all through plenty of reverb for a distant, magical halo.
  const degrees = [0, 2, 4, 7]   // in-key major triad + octave
  degrees.forEach((deg, idx) => {
    const f = currentMusic ? degreeToFreq(currentMusic, deg, 1) : 440 * Math.pow(2, idx / 4)
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(f, popTime)
    const peak = rVol((idx === 0 ? 0.22 : 0.13) * bloom)       // tamed unless the blast actually heals
    g.gain.setValueAtTime(0.0001, popTime)
    g.gain.linearRampToValueAtTime(peak, popTime + 0.03)       // gentler attack — no snap
    g.gain.exponentialRampToValueAtTime(0.001, popTime + 0.5 + idx * 0.05)
    o.connect(g); g.connect(master)
    // Generous reverb send on every tone so the chime sits back as an airy halo, not in your face.
    const rs = c.createGain(); rs.gain.value = rVol((idx === 0 ? 0.14 : 0.2) * bloom); g.connect(rs); rs.connect(reverbInput)
    o.start(popTime); o.stop(popTime + 0.65 + idx * 0.05)
  })

  // Sparkle — a single high bell on the resolve, very soft, tying the glitter into the bloom.
  {
    const f = currentMusic ? degreeToFreq(currentMusic, baseDeg, 3) : 1760
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(f, popTime)
    g.gain.setValueAtTime(0.0001, popTime)
    g.gain.linearRampToValueAtTime(rVol(0.07 * bloom), popTime + 0.01)  // softer + tamed unless healing
    g.gain.exponentialRampToValueAtTime(0.001, popTime + 0.3)
    o.connect(g); g.connect(reverbInput)
    o.start(popTime); o.stop(popTime + 0.35)
  }
}

// Wall heal zone — PLAYER got healed. A bright, friendly two-note rising bell (root → fifth) with a
// high sparkle, in-key, short. Reads clearly "good / you were nourished."
export function playWallHealPlayer(): void {
  ensureContext()
  const c = ctx!
  if (!admitVoice('low')) return
  const t = c.currentTime
  const notes = [
    { f: currentMusic ? degreeToFreq(currentMusic, 0, 1) : 523, at: t,        g: 0.16 },
    { f: currentMusic ? degreeToFreq(currentMusic, 4, 1) : 784, at: t + 0.055, g: 0.14 },
  ]
  for (const n of notes) {
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(n.f, n.at)
    g.gain.setValueAtTime(0.0001, n.at)
    g.gain.linearRampToValueAtTime(rVol(n.g), n.at + 0.012)
    g.gain.exponentialRampToValueAtTime(0.001, n.at + 0.3)
    o.connect(g); g.connect(master)
    const rs = c.createGain(); rs.gain.value = rVol(0.12); g.connect(rs); rs.connect(reverbInput)
    o.start(n.at); o.stop(n.at + 0.34)
  }
  // High sparkle on top
  const s = c.createOscillator(); const sg = c.createGain()
  s.type = 'sine'
  s.frequency.setValueAtTime(currentMusic ? degreeToFreq(currentMusic, 0, 3) : 2093, t + 0.05)
  sg.gain.setValueAtTime(0.0001, t + 0.05)
  sg.gain.linearRampToValueAtTime(rVol(0.06), t + 0.062)
  sg.gain.exponentialRampToValueAtTime(0.001, t + 0.26)
  s.connect(sg); sg.connect(reverbInput)
  s.start(t + 0.05); s.stop(t + 0.29)
}

// Player got HEALED (volatile nourish blast OR wall heal zone). A warm, uplifting in-key bell
// ARPEGGIO (root → third → fifth → octave) rising quickly, capped with a high sustained shimmer —
// resolves the glittering twinkle of the heal buildup into a clear "you were nourished" chime.
// Shared by volatile + walls; callers fire it only when HP was actually restored.
let lastHealSfx = 0
export function playHeal(): void {
  ensureContext()
  const c = ctx!
  // Throttle — a multi-target heal frame (e.g. a big blast) shouldn't stack several chimes into a blare.
  if (c.currentTime - lastHealSfx < 0.08) return
  lastHealSfx = c.currentTime
  // HIGH priority — heal is player-relevant feedback that fires right as the (high-priority) heal
  // explosion is consuming the voice budget; 'low' got denied past the soft cap so it never sounded.
  if (!admitVoice('high')) return
  // Start a hair after the blast transient so the chime reads ON TOP of the boom, not buried in it.
  const t = c.currentTime + 0.05
  const degs = [0, 2, 4, 7]                       // rising root → third → fifth → octave
  const fallback = [523, 659, 784, 1047]          // C-major arpeggio if no music key is set
  for (let i = 0; i < degs.length; i++) {
    const at = t + i * 0.045                       // staggered upward, flows like the twinkle resolving
    const f = currentMusic ? degreeToFreq(currentMusic, degs[i]!, 1) : fallback[i]!
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(f, at)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(rVol(0.46 - i * 0.03), at + 0.012)   // louder heal chime
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.34)
    o.connect(g); g.connect(master)
    const rs = c.createGain(); rs.gain.value = rVol(0.14); g.connect(rs); rs.connect(reverbInput)
    o.start(at); o.stop(at + 0.38)
  }
  // High sustained shimmer on top — the twinkle's sparkle, resolving the buildup.
  const s = c.createOscillator(); const sg = c.createGain()
  s.type = 'sine'
  s.frequency.setValueAtTime(currentMusic ? degreeToFreq(currentMusic, 0, 3) : 2093, t + 0.13)
  sg.gain.setValueAtTime(0.0001, t + 0.13)
  sg.gain.linearRampToValueAtTime(rVol(0.07), t + 0.15)
  sg.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
  s.connect(sg); sg.connect(reverbInput)
  s.start(t + 0.13); s.stop(t + 0.52)
}

// Wall heal zone — an ENEMY got healed (bad for the player). A dull, slightly ominous low tone that
// sags downward, low-passed so it reads muted/heavy, with a faintly detuned twin for unease. Clearly
// distinct from the bright player-heal chime.
export function playWallHealEnemy(): void {
  ensureContext()
  const c = ctx!
  if (!admitVoice('low')) return
  const t = c.currentTime
  const f0 = currentMusic ? degreeToFreq(currentMusic, 0, 0) : 196
  const lp = c.createBiquadFilter()
  lp.type = 'lowpass'; lp.frequency.value = 680
  const g = c.createGain()
  g.gain.setValueAtTime(0.0001, t)
  g.gain.linearRampToValueAtTime(rVol(0.15), t + 0.02)
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
  lp.connect(g); g.connect(master)
  const o = c.createOscillator()
  o.type = 'triangle'
  o.frequency.setValueAtTime(f0, t)
  o.frequency.exponentialRampToValueAtTime(f0 * 0.84, t + 0.24)   // downward sag = "wrong"
  o.connect(lp); o.start(t); o.stop(t + 0.32)
  const o2 = c.createOscillator()
  o2.type = 'triangle'
  o2.frequency.setValueAtTime(f0 * 1.018, t)                      // slight detune → uneasy beating
  o2.frequency.exponentialRampToValueAtTime(f0 * 0.855, t + 0.24)
  o2.connect(lp); o2.start(t); o2.stop(t + 0.32)
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

// Enemy shield fuse — higher pitch than player's. One global instance — newest start
// replaces old. Same crackle + rising hum vocabulary, just shifted up.
let enemyFuseBurnNodes: { gain: GainNode; sources: AudioBufferSourceNode[] } | null = null

export function startEnemyShieldFuseBurn(duration: number): void {
  ensureContext()
  stopEnemyShieldFuseBurn()
  const c = ctx!
  const t = c.currentTime
  const bufLen = 2
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * bufLen), c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (Math.random() < 0.05 ? 0.8 : 0.2)
  }
  const noise = c.createBufferSource()
  noise.buffer = buf
  noise.loop = true
  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 3
  // Higher than player's 800→2500→4000
  filter.frequency.setValueAtTime(1500, t)
  filter.frequency.exponentialRampToValueAtTime(4500, t + duration * 0.8)
  filter.frequency.exponentialRampToValueAtTime(7000, t + duration)
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(rVol(0.06), t + 0.5)
  gain.gain.linearRampToValueAtTime(rVol(0.12), t + duration * 0.5)
  gain.gain.linearRampToValueAtTime(rVol(0.20), t + duration)
  noise.connect(filter)
  filter.connect(gain)
  gain.connect(reverbInput)
  noise.start(t)
  noise.stop(t + duration + 0.5)

  // Higher hum than player's 120→300 — uses a triangle for a more "electric" feel
  const hum = c.createOscillator()
  const humGain = c.createGain()
  hum.type = 'triangle'
  hum.frequency.setValueAtTime(rPitch(280), t)
  hum.frequency.exponentialRampToValueAtTime(rPitch(640), t + duration)
  humGain.gain.setValueAtTime(0.001, t)
  humGain.gain.linearRampToValueAtTime(rVol(0.04), t + 0.5)
  humGain.gain.linearRampToValueAtTime(rVol(0.10), t + duration * 0.5)
  humGain.gain.linearRampToValueAtTime(rVol(0.16), t + duration)
  hum.connect(humGain)
  humGain.connect(master)
  hum.start(t)
  hum.stop(t + duration + 0.5)

  enemyFuseBurnNodes = { gain, sources: [noise, hum as unknown as AudioBufferSourceNode] }
}

export function stopEnemyShieldFuseBurn(): void {
  if (enemyFuseBurnNodes) {
    try {
      enemyFuseBurnNodes.gain.gain.cancelScheduledValues(0)
      enemyFuseBurnNodes.gain.gain.setValueAtTime(0, 0)
      for (const s of enemyFuseBurnNodes.sources) try { s.stop() } catch {}
    } catch {}
    enemyFuseBurnNodes = null
  }
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

// Throttled enemy shield events — distinct from player's so you can hear who's affected.
let lastEnemyShieldBreakTime = 0
let lastEnemyShieldRestoreTime = 0
export function playEnemyShieldBreak(): void {
  ensureContext()
  const t = ctx!.currentTime
  if (t - lastEnemyShieldBreakTime < 0.06) return
  lastEnemyShieldBreakTime = t
  playShieldBreak()
}
// Enemy shield restore — "powering up and online" feel, distinct from player's deep sweep.
// Rising sine harmonics (no noise click) — soft attack, sustained shimmer, slow release.
export function playEnemyShieldRestore(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  if (t - lastEnemyShieldRestoreTime < 0.06) return
  lastEnemyShieldRestoreTime = t

  const dur = 0.45
  // Rising fundamental — feels like power building
  const o1 = c.createOscillator()
  o1.type = 'sine'
  o1.frequency.setValueAtTime(rPitch(500), t)
  o1.frequency.exponentialRampToValueAtTime(rPitch(900), t + 0.25)
  o1.frequency.exponentialRampToValueAtTime(rPitch(880), t + dur)   // settles into sustain
  // Octave shimmer — sweetens the top
  const o2 = c.createOscillator()
  o2.type = 'sine'
  o2.frequency.setValueAtTime(rPitch(1000), t)
  o2.frequency.exponentialRampToValueAtTime(rPitch(1800), t + 0.25)
  o2.frequency.exponentialRampToValueAtTime(rPitch(1760), t + dur)
  // Soft attack, peak around the "settle" moment, slow release
  const g = c.createGain()
  g.gain.setValueAtTime(0.001, t)
  g.gain.linearRampToValueAtTime(rVol(0.18), t + 0.18)   // ramp up over 180ms (no click)
  g.gain.linearRampToValueAtTime(rVol(0.20), t + 0.28)   // brief sustain at peak
  g.gain.exponentialRampToValueAtTime(0.001, t + dur)
  o1.connect(g)
  o2.connect(g)
  g.connect(reverbInput)   // reverb adds the "hum coming online" room feel
  o1.start(t)
  o2.start(t)
  o1.stop(t + dur)
  o2.stop(t + dur)
}

export function playShieldBreak(): void {
  ensureContext()
  const c = ctx!
  // Same crash as the player hit, made UNIQUE so the two don't sound identical: pitched up a
  // touch for a glassier shatter, and the dry layers run through a resonant peaking filter
  // (metallic/crystalline ring) instead of going flat to master. Sped up the most for a sharp
  // "shield shattered" snap.
  const glass = c.createBiquadFilter()
  glass.type = 'peaking'
  glass.frequency.value = 2600
  glass.Q.value = 1.8
  glass.gain.value = 9
  glass.connect(master)
  shieldCrash(0.75, 1.12, glass)
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

/** UI hover — subtle soft tick */
export function playUIHover(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  const tick = c.createOscillator()
  const tickGain = c.createGain()
  tick.type = 'sine'
  tick.frequency.setValueAtTime(rPitch(1200), t)
  tick.frequency.exponentialRampToValueAtTime(rPitch(800), t + 0.04)
  tickGain.gain.setValueAtTime(rVol(0.08), t)
  tickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.05)
  tick.connect(tickGain)
  tickGain.connect(master)
  tick.start(t)
  tick.stop(t + 0.05)
}

/** UI click — short satisfying snap */
export function playUIClick(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Click pop
  const pop = c.createOscillator()
  const popGain = c.createGain()
  pop.type = 'sine'
  pop.frequency.setValueAtTime(rPitch(600), t)
  pop.frequency.exponentialRampToValueAtTime(rPitch(300), t + 0.06)
  popGain.gain.setValueAtTime(rVol(0.2), t)
  popGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
  pop.connect(popGain)
  popGain.connect(master)
  pop.start(t)
  pop.stop(t + 0.08)
  // Tiny noise snap
  const nDur = 0.03
  const nBuf = c.createBuffer(1, Math.floor(c.sampleRate * nDur), c.sampleRate)
  const nData = nBuf.getChannelData(0)
  for (let i = 0; i < nData.length; i++) nData[i] = (Math.random() * 2 - 1) * 0.3
  const noise = c.createBufferSource()
  noise.buffer = nBuf
  const nFilter = c.createBiquadFilter()
  nFilter.type = 'highpass'
  nFilter.frequency.value = 3000
  const nGain = c.createGain()
  nGain.gain.setValueAtTime(rVol(0.12), t)
  nGain.gain.exponentialRampToValueAtTime(0.001, t + nDur)
  noise.connect(nFilter)
  nFilter.connect(nGain)
  nGain.connect(master)
  noise.start(t)
  noise.stop(t + nDur)
}

/** Challenge select click — explosive burst + descending spiral whoosh (0.7s to match iris) */
export function playIrisClose(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Impact hit — loud punchy transient
  const hit = c.createOscillator()
  const hitGain = c.createGain()
  hit.type = 'sine'
  hit.frequency.setValueAtTime(rPitch(500), t)
  hit.frequency.exponentialRampToValueAtTime(rPitch(60), t + 0.2)
  hitGain.gain.setValueAtTime(rVol(0.7), t)
  hitGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25)
  hit.connect(hitGain)
  hitGain.connect(master)
  hit.start(t)
  hit.stop(t + 0.25)

  // Heavy sub thump
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(90), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(20), t + 0.35)
  subGain.gain.setValueAtTime(rVol(0.6), t)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
  sub.connect(subGain)
  subGain.connect(master)
  sub.start(t)
  sub.stop(t + 0.35)

  // Long descending whoosh — covers full 0.7s iris duration
  const whooshDur = 0.7
  const whooshBuf = c.createBuffer(1, Math.floor(c.sampleRate * whooshDur), c.sampleRate)
  const whooshData = whooshBuf.getChannelData(0)
  for (let i = 0; i < whooshData.length; i++) whooshData[i] = (Math.random() * 2 - 1) * 0.6
  const whoosh = c.createBufferSource()
  whoosh.buffer = whooshBuf
  const whooshFilter = c.createBiquadFilter()
  whooshFilter.type = 'bandpass'
  whooshFilter.Q.value = 1.5
  whooshFilter.frequency.setValueAtTime(4000, t)
  whooshFilter.frequency.exponentialRampToValueAtTime(150, t + whooshDur)
  const whooshGain = c.createGain()
  whooshGain.gain.setValueAtTime(rVol(0.5), t)
  whooshGain.gain.linearRampToValueAtTime(rVol(0.6), t + 0.2)
  whooshGain.gain.exponentialRampToValueAtTime(0.001, t + whooshDur)
  whoosh.connect(whooshFilter)
  whooshFilter.connect(whooshGain)
  whooshGain.connect(master)
  whoosh.start(t)
  whoosh.stop(t + whooshDur)

  // Descending tone — spiral feel, covers full duration
  const spiral = c.createOscillator()
  const spiral2 = c.createOscillator()
  const spiralGain = c.createGain()
  spiral.type = 'sawtooth'
  spiral2.type = 'sawtooth'
  spiral.frequency.setValueAtTime(rPitch(600), t + 0.1)
  spiral.frequency.exponentialRampToValueAtTime(rPitch(80), t + 0.65)
  spiral2.frequency.setValueAtTime(rPitch(620), t + 0.1)
  spiral2.frequency.exponentialRampToValueAtTime(rPitch(85), t + 0.65)
  spiralGain.gain.setValueAtTime(0.001, t + 0.1)
  spiralGain.gain.linearRampToValueAtTime(rVol(0.2), t + 0.2)
  spiralGain.gain.exponentialRampToValueAtTime(0.001, t + 0.7)
  const spiralFilter = c.createBiquadFilter()
  spiralFilter.type = 'lowpass'
  spiralFilter.frequency.setValueAtTime(2000, t + 0.1)
  spiralFilter.frequency.exponentialRampToValueAtTime(300, t + 0.65)
  spiral.connect(spiralFilter)
  spiral2.connect(spiralFilter)
  spiralFilter.connect(spiralGain)
  spiralGain.connect(reverbInput)
  spiral.start(t + 0.1)
  spiral2.start(t + 0.1)
  spiral.stop(t + 0.7)
  spiral2.stop(t + 0.7)

  // Noise crackle tail
  const crackDur = 0.3
  const crackBuf = c.createBuffer(1, Math.floor(c.sampleRate * crackDur), c.sampleRate)
  const crackData = crackBuf.getChannelData(0)
  for (let i = 0; i < crackData.length; i++) crackData[i] = (Math.random() * 2 - 1) * 0.4
  const crack = c.createBufferSource()
  crack.buffer = crackBuf
  const crackFilter = c.createBiquadFilter()
  crackFilter.type = 'highpass'
  crackFilter.frequency.value = 2000
  const crackGain = c.createGain()
  crackGain.gain.setValueAtTime(rVol(0.3), t)
  crackGain.gain.exponentialRampToValueAtTime(0.001, t + crackDur)
  crack.connect(crackFilter)
  crackFilter.connect(crackGain)
  crackGain.connect(master)
  crack.start(t)
  crack.stop(t + crackDur)
}

/** Challenge opening / restart — dramatic rising reveal (0.5s to match iris) */
export function playIrisOpen(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Big rising whoosh — covers full open duration
  const whooshDur = 0.5
  const whooshBuf = c.createBuffer(1, Math.floor(c.sampleRate * whooshDur), c.sampleRate)
  const whooshData = whooshBuf.getChannelData(0)
  for (let i = 0; i < whooshData.length; i++) whooshData[i] = (Math.random() * 2 - 1) * 0.6
  const whoosh = c.createBufferSource()
  whoosh.buffer = whooshBuf
  const whooshFilter = c.createBiquadFilter()
  whooshFilter.type = 'bandpass'
  whooshFilter.Q.value = 1.5
  whooshFilter.frequency.setValueAtTime(150, t)
  whooshFilter.frequency.exponentialRampToValueAtTime(4000, t + whooshDur)
  const whooshGain = c.createGain()
  whooshGain.gain.setValueAtTime(0.001, t)
  whooshGain.gain.linearRampToValueAtTime(rVol(0.5), t + whooshDur * 0.7)
  whooshGain.gain.exponentialRampToValueAtTime(0.001, t + whooshDur)
  whoosh.connect(whooshFilter)
  whooshFilter.connect(whooshGain)
  whooshGain.connect(master)
  whoosh.start(t)
  whoosh.stop(t + whooshDur)

  // Rising spiral tone — opposite of close
  const spiral = c.createOscillator()
  const spiral2 = c.createOscillator()
  const spiralGain = c.createGain()
  spiral.type = 'sawtooth'
  spiral2.type = 'sawtooth'
  spiral.frequency.setValueAtTime(rPitch(80), t)
  spiral.frequency.exponentialRampToValueAtTime(rPitch(500), t + 0.4)
  spiral2.frequency.setValueAtTime(rPitch(85), t)
  spiral2.frequency.exponentialRampToValueAtTime(rPitch(520), t + 0.4)
  spiralGain.gain.setValueAtTime(0.001, t)
  spiralGain.gain.linearRampToValueAtTime(rVol(0.18), t + 0.15)
  spiralGain.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
  const spiralFilter = c.createBiquadFilter()
  spiralFilter.type = 'lowpass'
  spiralFilter.frequency.setValueAtTime(300, t)
  spiralFilter.frequency.exponentialRampToValueAtTime(2500, t + 0.4)
  spiral.connect(spiralFilter)
  spiral2.connect(spiralFilter)
  spiralFilter.connect(spiralGain)
  spiralGain.connect(reverbInput)
  spiral.start(t)
  spiral2.start(t)
  spiral.stop(t + 0.45)
  spiral2.stop(t + 0.45)

  // Rising chime — bright arrival, fifth interval
  const chime = c.createOscillator()
  const chime2 = c.createOscillator()
  const chimeGain = c.createGain()
  chime.type = 'sine'
  chime2.type = 'sine'
  chime.frequency.setValueAtTime(rPitch(500), t + 0.1)
  chime.frequency.exponentialRampToValueAtTime(rPitch(1000), t + 0.3)
  chime2.frequency.setValueAtTime(rPitch(750), t + 0.1)
  chime2.frequency.exponentialRampToValueAtTime(rPitch(1500), t + 0.3)
  chimeGain.gain.setValueAtTime(0.001, t + 0.1)
  chimeGain.gain.linearRampToValueAtTime(rVol(0.3), t + 0.2)
  chimeGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  chime.connect(chimeGain)
  chime2.connect(chimeGain)
  chimeGain.connect(reverbInput)
  chime.start(t + 0.1)
  chime2.start(t + 0.1)
  chime.stop(t + 0.4)
  chime2.stop(t + 0.4)

  // Sub lift — heavy
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(30), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(90), t + 0.35)
  subGain.gain.setValueAtTime(0.001, t)
  subGain.gain.linearRampToValueAtTime(rVol(0.45), t + 0.2)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.4)
  sub.connect(subGain)
  subGain.connect(master)
  sub.start(t)
  sub.stop(t + 0.4)

  // Bright crack at the end — "arrival" snap
  const crackDur = 0.08
  const crackBuf = c.createBuffer(1, Math.floor(c.sampleRate * crackDur), c.sampleRate)
  const crackData = crackBuf.getChannelData(0)
  for (let i = 0; i < crackData.length; i++) crackData[i] = (Math.random() * 2 - 1) * 0.5
  const crack = c.createBufferSource()
  crack.buffer = crackBuf
  const crackFilter = c.createBiquadFilter()
  crackFilter.type = 'highpass'
  crackFilter.frequency.value = 3000
  const crackGain = c.createGain()
  crackGain.gain.setValueAtTime(rVol(0.35), t + 0.25)
  crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25 + crackDur)
  crack.connect(crackFilter)
  crackFilter.connect(crackGain)
  crackGain.connect(master)
  crack.start(t + 0.25)
  crack.stop(t + 0.25 + crackDur)
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

// Enemy dodge — short whoosh: filtered noise sweeping down. Distinct from player's dash
// (which is breathy sine). Throttled so swarms of dodgers don't blow out audio.
let lastEnemyDodgeTime = 0
// "Quiet Storm" charge-ready chime — plays once when the player's stand-still charge
// completes. Bright, brief, and unmistakable so the player knows their next dash is loaded.
export function playChargeReady(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Two-tone arpeggio (perfect fifth) with bell-like envelope
  const f1 = rPitch(880)
  const f2 = rPitch(1320)
  for (const [freq, delay] of [[f1, 0], [f2, 0.05]] as const) {
    const osc = c.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, t + delay)
    const gain = c.createGain()
    gain.gain.setValueAtTime(0.001, t + delay)
    gain.gain.linearRampToValueAtTime(rVol(0.5), t + delay + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.001, t + delay + 0.40)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t + delay)
    osc.stop(t + delay + 0.45)
  }
}

// Reverb shock push — deep bass thump + brief noise burst for the player's beat-dash push
// wave. Heavier than the boing (this is the player DEALING the push, not receiving it).
let lastShockPushTime = 0
export function playShockPush(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  if (t - lastShockPushTime < 0.05) return
  lastShockPushTime = t
  // Sub-bass drop
  const osc = c.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(rPitch(160), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(45), t + 0.22)
  const oGain = c.createGain()
  oGain.gain.setValueAtTime(rVol(0.9), t)
  oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
  osc.connect(oGain)
  oGain.connect(master)
  osc.start(t)
  osc.stop(t + 0.3)
  // Noise burst for the "whoomph" air-displacement texture
  const dur = 0.18
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise = c.createBufferSource()
  noise.buffer = buf
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(1200, t)
  filter.frequency.exponentialRampToValueAtTime(200, t + dur)
  const nGain = c.createGain()
  nGain.gain.setValueAtTime(0.001, t)
  nGain.gain.linearRampToValueAtTime(rVol(0.5), t + 0.01)
  nGain.gain.exponentialRampToValueAtTime(0.001, t + dur)
  noise.connect(filter)
  filter.connect(nGain)
  nGain.connect(master)
  noise.start(t)
  noise.stop(t + dur)
}

// Sustained lightning crackle for a Bolt projectile in flight. Multiple bolts can fly
// concurrently (Triple Dash + Bolt etc.), so instances are tracked in a Map keyed by id.
// startDashShotCrackle returns the id; stopDashShotCrackle(id) fades and disposes the nodes.
// Designed quiet — ambient flight texture under the main mix, not foreground.
interface DashShotCrackleNodes {
  gain: GainNode
  source: AudioBufferSourceNode
}
const dashShotCrackleInstances = new Map<number, DashShotCrackleNodes>()
let dashShotCrackleNextId = 1
export function startDashShotCrackle(duration: number): number {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Looped bandpassed noise — random pops give the snap-crackle electric texture
  const bufLen = 2
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * bufLen), c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (Math.random() < 0.04 ? 0.7 : 0.18)
  }
  const noise = c.createBufferSource()
  noise.buffer = buf
  noise.loop = true
  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 3.5
  filter.frequency.value = 1600
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(rVol(0.10), t + 0.06)
  noise.connect(filter)
  filter.connect(gain)
  gain.connect(master)
  noise.start(t)
  noise.stop(t + duration + 0.5)   // safety stop in case caller doesn't
  const id = dashShotCrackleNextId++
  dashShotCrackleInstances.set(id, { gain, source: noise })
  return id
}
export function stopDashShotCrackle(id: number): void {
  if (!ctx) return
  const inst = dashShotCrackleInstances.get(id)
  if (!inst) return
  const t = ctx.currentTime
  inst.gain.gain.cancelScheduledValues(t)
  inst.gain.gain.setValueAtTime(inst.gain.gain.value, t)
  inst.gain.gain.linearRampToValueAtTime(0.001, t + 0.06)
  try { inst.source.stop(t + 0.08) } catch { /* may already be stopped */ }
  dashShotCrackleInstances.delete(id)
}

// Warm electric "fwoom" for Bolt (Dash-shot) spawn — discharge thump. Sine + triangle in the
// low-mid range so it reads as energetic without the squeaky high-square harshness, layered
// with a lowpassed noise crackle for the electric texture.
let lastDashShotFireTime = 0
export function playDashShotFire(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  if (t - lastDashShotFireTime < 0.05) return
  lastDashShotFireTime = t
  // Sub-bass body — the "fwoom" thump
  const sub = c.createOscillator()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(220), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(60), t + 0.10)
  const subGain = c.createGain()
  subGain.gain.setValueAtTime(rVol(0.7), t)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
  sub.connect(subGain)
  subGain.connect(master)
  sub.start(t)
  sub.stop(t + 0.18)
  // Mid triangle — adds electric character without piercing highs
  const mid = c.createOscillator()
  mid.type = 'triangle'
  mid.frequency.setValueAtTime(rPitch(420), t)
  mid.frequency.exponentialRampToValueAtTime(rPitch(110), t + 0.09)
  const midGain = c.createGain()
  midGain.gain.setValueAtTime(rVol(0.32), t)
  midGain.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
  mid.connect(midGain)
  midGain.connect(master)
  mid.start(t)
  mid.stop(t + 0.14)
  // Warm noise crackle — lowpassed so it's a "vrooom" texture, not a hissy zap
  const dur = 0.13
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise = c.createBufferSource()
  noise.buffer = buf
  const filter = c.createBiquadFilter()
  filter.type = 'lowpass'
  filter.frequency.setValueAtTime(1500, t)
  filter.frequency.exponentialRampToValueAtTime(500, t + dur)
  const nGain = c.createGain()
  nGain.gain.setValueAtTime(0.001, t)
  nGain.gain.linearRampToValueAtTime(rVol(0.35), t + 0.008)
  nGain.gain.exponentialRampToValueAtTime(0.001, t + dur)
  noise.connect(filter)
  filter.connect(nGain)
  nGain.connect(master)
  noise.start(t)
  noise.stop(t + dur)
}

// Dash sweep — a satisfying in-key "DING" that LAYERS on top of the normal attack/hit sound (a
// tonal bell, so it doesn't mask the hit the way a noise swish did), plus a low thump so the sweep
// still feels DAMAGING. Tuned to the wave's root + fifth. Throttled so a beat's ring peaks don't stack.
let lastDashSweepTime = 0
// `strength` scales the smear's loudness + tier to the actual rendered length (see HitDetection):
//   ~0.3 short flick → quiet body only · ~1.0 well-timed 30% dash → the solid sweep ·
//   >1.3 long connected double-dash → full body + an ascending BONUS shimmer that rings out.
export function playDashSweep(strength = 1): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  if (t - lastDashSweepTime < 0.08) return
  lastDashSweepTime = t
  // Clamp into a controlled band so a huge chain can't slam the compressor, and a tiny flick still
  // reads. vm: overall loudness follows length; small/long pick which layers play.
  const s = Math.max(0.3, Math.min(1.8, strength))
  const vm = 0.3 + 0.7 * Math.min(1.2, s)   // 0.51 at s=0.3 · 1.0 at s=1.0 · 1.14 at s≥1.2
  const small = s < 0.6
  const long = s > 1.3
  const m = currentMusic
  // Vary the bell across the scale each dash → a different open chord every time (not the same ding).
  const base = m ? Math.floor(Math.random() * m.melodyNotes.length) : 0
  const root = (m ? m.melodyNotes[base]! : 262) * 2
  const fifth = (m ? m.melodyNotes[(base + 2) % m.melodyNotes.length]! : 392) * 2   // a consonant pentatonic interval up
  // Bell ding — root + interval + a faint octave shimmer, through reverb. A bit louder now. The LONG
  // (combined double-dash) smear skips this bright bell — it gets its own fat power-chord voice below.
  const bell: [number, number, number][] = [[root, 0.44, 0.55], [fifth, 0.27, 0.48], [root * 2, 0.15, 0.32]]
  if (!long) for (const [freq, vol, dur] of bell) {
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.value = freq
    g.gain.setValueAtTime(0.0005, t)
    g.gain.linearRampToValueAtTime(rVol(vol * vm), t + 0.004)   // quick attack = a clean "ting"
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur)   // bell ring-out
    o.connect(g); g.connect(reverbInput)
    o.start(t); o.stop(t + dur + 0.02)
  }
  // Punchy low thump — dry impact body so the sweep lands as DAMAGE, not just a chime.
  const th = c.createOscillator()
  const thg = c.createGain()
  th.type = 'sine'
  th.frequency.setValueAtTime(220, t)
  th.frequency.exponentialRampToValueAtTime(55, t + 0.14)
  thg.gain.setValueAtTime(rVol(0.9 * vm), t)
  thg.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
  th.connect(thg); thg.connect(master)
  th.start(t); th.stop(t + 0.17)
  // Cinematic SUB + downward "vwoom" — the dramatic chest-felt body. A short flick smear skips
  // these (just the ting + thump), so tiny smears stay small and don't drag on the mix.
  if (!small) {
    const sub = c.createOscillator()
    const subg = c.createGain()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(62, t)
    sub.frequency.exponentialRampToValueAtTime(38, t + 0.4)
    subg.gain.setValueAtTime(0.0008, t)
    subg.gain.linearRampToValueAtTime(rVol(0.55 * vm), t + 0.02)
    subg.gain.exponentialRampToValueAtTime(0.001, t + 0.42)
    sub.connect(subg); subg.connect(master)
    sub.start(t); sub.stop(t + 0.44)
    // Downward "vwoom" sweep — a sawtooth gliding down through a closing lowpass = dramatic impact tail.
    const sw = c.createOscillator()
    const swf = c.createBiquadFilter()
    const swg = c.createGain()
    sw.type = 'sawtooth'
    sw.frequency.setValueAtTime(480, t)
    sw.frequency.exponentialRampToValueAtTime(65, t + 0.26)
    swf.type = 'lowpass'
    swf.frequency.setValueAtTime(1400, t)
    swf.frequency.exponentialRampToValueAtTime(320, t + 0.26)
    swg.gain.setValueAtTime(0.0008, t)
    swg.gain.linearRampToValueAtTime(rVol(0.32 * vm), t + 0.01)
    swg.gain.exponentialRampToValueAtTime(0.001, t + 0.28)
    sw.connect(swf); swf.connect(swg); swg.connect(master)
    sw.start(t); sw.stop(t + 0.3)
  }
  // Metallic clang — an INHARMONIC overtone (not a clean octave) gives the bell a hard, aggressive
  // edge so the ding reads as a strike, not a soft chime. (Off for long — it's part of the bell voice.)
  if (!long) {
    const cl = c.createOscillator()
    const clg = c.createGain()
    cl.type = 'triangle'
    cl.frequency.value = root * 2.76
    clg.gain.setValueAtTime(0.0005, t)
    clg.gain.linearRampToValueAtTime(rVol(0.13 * vm), t + 0.003)
    clg.gain.exponentialRampToValueAtTime(0.0005, t + 0.12)
    cl.connect(clg); clg.connect(master)
    cl.start(t); cl.stop(t + 0.14)
  }
  // Noise crack — short low-passed burst at the attack = the impact transient (the "hit").
  const nlen = Math.floor(c.sampleRate * 0.045)
  const nbuf = c.createBuffer(1, nlen, c.sampleRate)
  const nd = nbuf.getChannelData(0)
  for (let i = 0; i < nlen; i++) nd[i] = Math.random() * 2 - 1
  const ns = c.createBufferSource()
  ns.buffer = nbuf
  const nlp = c.createBiquadFilter()
  nlp.type = 'lowpass'
  nlp.frequency.value = 1900
  const ng = c.createGain()
  ng.gain.setValueAtTime(rVol(0.42 * vm), t)
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.045)
  ns.connect(nlp); nlp.connect(ng); ng.connect(master)
  ns.start(t); ns.stop(t + 0.05)
  // LONG (combined double-dash) smear — a BIG, BRIGHT power-slash, not a low muffled bwomp. A sharp
  // metallic SHING up front, a wide in-key power chord whose filter snaps WIDE OPEN and rings out
  // through reverb (bright + sustained = epic, the opposite of a dinky fart), and a hard punchy sub
  // for chest weight. Loud and present on top of the shared body (thump/sub/sweep/crack).
  if (long) {
    // 1) Metallic SHING — a bright highpassed noise crack = the sharp leading edge of the slash.
    const shl = Math.floor(c.sampleRate * 0.06)
    const shb = c.createBuffer(1, shl, c.sampleRate)
    const shd = shb.getChannelData(0)
    for (let i = 0; i < shl; i++) shd[i] = (Math.random() * 2 - 1) * (1 - i / shl)
    const shs = c.createBufferSource(); shs.buffer = shb
    const shf = c.createBiquadFilter(); shf.type = 'highpass'; shf.frequency.value = 2800
    const shg = c.createGain()
    shg.gain.setValueAtTime(rVol(0.55 * vm), t)
    shg.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
    shs.connect(shf); shf.connect(shg); shg.connect(master)
    shs.start(t); shs.stop(t + 0.07)

    // 2) Wide bright power chord — root/fifth/octave across a full register, detuned saws. Filter snaps
    //    WIDE open then settles BRIGHT (not muffled). Split dry (punch → master) + wet (long ring →
    //    reverb) so it sustains like a struck chord instead of a blip.
    const chordF = [root * 0.5, root, fifth, root * 2]
    const pcf = c.createBiquadFilter(); pcf.type = 'lowpass'
    pcf.frequency.setValueAtTime(700, t)
    pcf.frequency.exponentialRampToValueAtTime(6800, t + 0.025)   // snap WIDE open = the strike
    pcf.frequency.exponentialRampToValueAtTime(2200, t + 0.45)    // settle BRIGHT (never muffled)
    const pcgDry = c.createGain()
    pcgDry.gain.setValueAtTime(0.0008, t)
    pcgDry.gain.linearRampToValueAtTime(rVol(0.12 * vm), t + 0.01)
    pcgDry.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
    const pcgWet = c.createGain()
    pcgWet.gain.setValueAtTime(0.0008, t)
    pcgWet.gain.linearRampToValueAtTime(rVol(0.1 * vm), t + 0.03)
    pcgWet.gain.exponentialRampToValueAtTime(0.001, t + 0.7)      // long ring-out
    pcf.connect(pcgDry); pcgDry.connect(master)
    pcf.connect(pcgWet); pcgWet.connect(reverbInput)
    for (const f of chordF) {
      for (const det of [-8, 8]) {                                // super-saw detune for thickness
        const o = c.createOscillator()
        o.type = 'sawtooth'
        o.frequency.value = f * (1 + det / 1000)
        o.connect(pcf)
        o.start(t); o.stop(t + 0.55)
      }
    }

    // 3) Hard punchy sub — a deep kick-sub that HITS immediately and decays fast (a quick drop, NOT a
    //    long farty glide) = chest weight without mud.
    const bo = c.createOscillator(); const bog = c.createGain()
    bo.type = 'sine'
    bo.frequency.setValueAtTime(95, t)
    bo.frequency.exponentialRampToValueAtTime(48, t + 0.09)
    bog.gain.setValueAtTime(rVol(0.95 * vm), t)                   // hits hard on the transient
    bog.gain.exponentialRampToValueAtTime(0.001, t + 0.24)
    bo.connect(bog); bog.connect(master)
    bo.start(t); bo.stop(t + 0.26)

    // 4) Crunch — a short decaying low-passed noise body = the impact damage under the SHING.
    const dl = Math.floor(c.sampleRate * 0.12)
    const dbf = c.createBuffer(1, dl, c.sampleRate)
    const dd = dbf.getChannelData(0)
    for (let i = 0; i < dl; i++) dd[i] = (Math.random() * 2 - 1) * (1 - i / dl)
    const dsn = c.createBufferSource(); dsn.buffer = dbf
    const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 1400
    const dgn = c.createGain()
    dgn.gain.setValueAtTime(rVol(0.28 * vm), t)
    dgn.gain.exponentialRampToValueAtTime(0.001, t + 0.12)
    dsn.connect(dlp); dlp.connect(dgn); dgn.connect(master)
    dsn.start(t); dsn.stop(t + 0.13)
  }
}

// Quick "boingngng" — cartoony spring sound for when an entity gets launched by a wall
// spring or pusher enemy. `loud` (true for player pushes) raises gain ~3× so the player's
// own bounce reads above the chorus when multiple things get pushed at once.
let lastBoingTime = 0
export function playBoing(loud = false): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Throttle so a crowd of enemies pushed simultaneously doesn't stack into noise. Player
  // pushes bypass the throttle so the player's own boing is never dropped.
  if (!loud && t - lastBoingTime < 0.05) return
  lastBoingTime = t
  const dur = 0.18
  const osc = c.createOscillator()
  osc.type = 'triangle'
  // Pitch sweep — quick up-and-down warble that gives the classic "boing" feel.
  osc.frequency.setValueAtTime(rPitch(180), t)
  osc.frequency.exponentialRampToValueAtTime(rPitch(720), t + 0.04)
  osc.frequency.exponentialRampToValueAtTime(rPitch(290), t + 0.10)
  osc.frequency.exponentialRampToValueAtTime(rPitch(420), t + 0.18)
  // Small detuned oscillator for body
  const osc2 = c.createOscillator()
  osc2.type = 'sine'
  osc2.frequency.setValueAtTime(rPitch(90), t)
  osc2.frequency.exponentialRampToValueAtTime(rPitch(160), t + 0.06)
  osc2.frequency.exponentialRampToValueAtTime(rPitch(70), t + dur)
  const gain = c.createGain()
  const peak = loud ? 0.85 : 0.32
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(rVol(peak), t + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
  const sub = c.createGain()
  sub.gain.setValueAtTime(rVol(peak * 0.4), t)
  sub.gain.exponentialRampToValueAtTime(0.001, t + dur)
  osc.connect(gain)
  osc2.connect(sub)
  gain.connect(master)
  sub.connect(master)
  osc.start(t)
  osc.stop(t + dur)
  osc2.start(t)
  osc2.stop(t + dur)
}

export function playEnemyDodge(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  if (t - lastEnemyDodgeTime < 0.04) return   // throttle: max ~25 dodges/sec audible
  lastEnemyDodgeTime = t
  const dur = 0.18
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  const noise = c.createBufferSource()
  noise.buffer = buf
  const filter = c.createBiquadFilter()
  filter.type = 'bandpass'
  filter.Q.value = 2
  filter.frequency.setValueAtTime(2200, t)
  filter.frequency.exponentialRampToValueAtTime(550, t + dur)
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(rVol(0.22), t + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
  noise.connect(filter)
  filter.connect(gain)
  gain.connect(master)
  noise.start(t)
  noise.stop(t + dur)
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
  gain.gain.linearRampToValueAtTime(rVol(0.35), t + 0.04)
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
  rumble.frequency.exponentialRampToValueAtTime(rPitch(35), t + 1.05)
  rumbleGain.gain.setValueAtTime(rVol(1.2), t)
  rumbleGain.gain.exponentialRampToValueAtTime(0.001, t + 1.05)
  const rumbleFilter = c.createBiquadFilter()
  rumbleFilter.type = 'lowpass'
  rumbleFilter.frequency.value = 250
  rumble.connect(rumbleFilter)
  rumbleFilter.connect(rumbleGain)
  rumbleGain.connect(master)
  rumble.start(t)
  rumble.stop(t + 1.05)

  // Second sub layer for weight
  const sub = c.createOscillator()
  const subGain = c.createGain()
  sub.type = 'sine'
  sub.frequency.setValueAtTime(rPitch(60), t)
  sub.frequency.exponentialRampToValueAtTime(rPitch(25), t + 0.9)
  subGain.gain.setValueAtTime(rVol(1.0), t)
  subGain.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
  sub.connect(subGain)
  subGain.connect(master)
  sub.start(t)
  sub.stop(t + 0.9)

  // Dark chord — minor third dissonance, raised an octave for audibility
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const chordGain = c.createGain()
  osc1.type = 'triangle'
  osc2.type = 'triangle'
  osc1.frequency.setValueAtTime(rPitch(260), t)
  osc1.frequency.exponentialRampToValueAtTime(rPitch(200), t + 0.9)
  osc2.frequency.setValueAtTime(rPitch(312), t) // minor third up
  osc2.frequency.exponentialRampToValueAtTime(rPitch(240), t + 0.9)
  chordGain.gain.setValueAtTime(rVol(0.85), t)
  chordGain.gain.exponentialRampToValueAtTime(0.001, t + 0.9)
  osc1.connect(chordGain)
  osc2.connect(chordGain)
  chordGain.connect(master)
  osc1.start(t)
  osc2.start(t)
  osc1.stop(t + 0.9)
  osc2.stop(t + 0.9)

  // Mid-range thunk — sharp attack that punches through any speaker
  const thunk = c.createOscillator()
  const thunkGain = c.createGain()
  thunk.type = 'sawtooth'
  thunk.frequency.setValueAtTime(rPitch(400), t)
  thunk.frequency.exponentialRampToValueAtTime(rPitch(120), t + 0.25)
  const thunkFilter = c.createBiquadFilter()
  thunkFilter.type = 'lowpass'
  thunkFilter.frequency.setValueAtTime(2200, t)
  thunkFilter.frequency.exponentialRampToValueAtTime(600, t + 0.3)
  thunkGain.gain.setValueAtTime(rVol(0.9), t)
  thunkGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
  thunk.connect(thunkFilter)
  thunkFilter.connect(thunkGain)
  thunkGain.connect(master)
  thunk.start(t)
  thunk.stop(t + 0.35)

  // Whoosh noise burst — dark energy dispersing (brighter + louder for audibility)
  const noiseDur = 0.7
  const noiseBuf = c.createBuffer(1, Math.floor(c.sampleRate * noiseDur), c.sampleRate)
  const noiseData = noiseBuf.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = (Math.random() * 2 - 1) * 0.7
  const noise = c.createBufferSource()
  noise.buffer = noiseBuf
  const noiseFilter = c.createBiquadFilter()
  noiseFilter.type = 'bandpass'
  noiseFilter.Q.value = 1.2
  noiseFilter.frequency.setValueAtTime(2400, t)
  noiseFilter.frequency.exponentialRampToValueAtTime(500, t + noiseDur)
  const noiseGain = c.createGain()
  noiseGain.gain.setValueAtTime(rVol(1.1), t + 0.02)
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
  tomGain.gain.setValueAtTime(rVol(1.1), t)
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
  memGain.gain.setValueAtTime(rVol(0.8), t)
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
  wooshGain.gain.linearRampToValueAtTime(rVol(0.75), t + 0.05)
  wooshGain.gain.exponentialRampToValueAtTime(0.001, t + wooshDur)
  woosh.connect(wooshFilter)
  wooshFilter.connect(wooshGain)
  wooshGain.connect(reverbInput)
  woosh.start(t)
  woosh.stop(t + wooshDur)
}

// Short tick + airy whoosh — placed at the start of an Aftershock fuse so the player gets
// audible confirmation that the bomb is armed before the visual pie even starts ticking.
export function playFuseStart(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Tick — short metallic click
  const tick = c.createOscillator()
  const tickGain = c.createGain()
  tick.type = 'square'
  tick.frequency.setValueAtTime(rPitch(1200), t)
  tick.frequency.exponentialRampToValueAtTime(rPitch(600), t + 0.05)
  tickGain.gain.setValueAtTime(rVol(0.18), t)
  tickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.08)
  tick.connect(tickGain)
  tickGain.connect(master)
  tick.start(t)
  tick.stop(t + 0.08)

  // Low body — gives the tick weight without competing with playBeatDash later
  const body = c.createOscillator()
  const bodyGain = c.createGain()
  body.type = 'sine'
  body.frequency.setValueAtTime(rPitch(200), t)
  body.frequency.exponentialRampToValueAtTime(rPitch(120), t + 0.12)
  bodyGain.gain.setValueAtTime(rVol(0.22), t)
  bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  body.connect(bodyGain)
  bodyGain.connect(master)
  body.start(t)
  body.stop(t + 0.15)
}

// Wall-spring fire — percussive "thock" with INSTANT attack. The envelope's loudest moment
// is at trigger (t=0), so the punch lands exactly when the spring fires. Previous version
// had a 70ms pitch-swoop-up that pushed the perceptual peak ~70ms after trigger, making
// every fire feel late even when timing was perfect.
let lastSpringTime = 0
export function playWallSpringFire(scheduleAt?: number): void {
  ensureContext()
  const c = ctx!
  // Schedule at the requested ideal audio time if provided; clamp to currentTime if it's
  // already in the past (best we can do without complex pre-scheduling).
  const t = Math.max(c.currentTime, scheduleAt ?? c.currentTime)
  if (t - lastSpringTime < 0.05) return   // anti-stack throttle
  lastSpringTime = t

  // Sub-thump — sine that PEAKS at t=0 and decays. Frequency drops from 150→50 (downward
  // pitch envelope = "released" feel, like a snap). Gain is full at t=0 — no ramp-in.
  const thump = c.createOscillator()
  const thumpGain = c.createGain()
  thump.type = 'sine'
  thump.frequency.setValueAtTime(rPitch(150), t)
  thump.frequency.exponentialRampToValueAtTime(rPitch(50), t + 0.15)
  thumpGain.gain.setValueAtTime(rVol(0.6), t)              // instant peak — no attack ramp
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.15)
  thump.connect(thumpGain)
  thumpGain.connect(master)
  thump.start(t)
  thump.stop(t + 0.16)

  // Brief high click — adds the sharp "edge" on the attack moment. Also peaks instantly.
  const click = c.createOscillator()
  const clickGain = c.createGain()
  click.type = 'square'
  click.frequency.setValueAtTime(rPitch(800), t)
  click.frequency.exponentialRampToValueAtTime(rPitch(220), t + 0.04)
  clickGain.gain.setValueAtTime(rVol(0.22), t)              // instant peak
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.045)
  click.connect(clickGain)
  clickGain.connect(master)
  click.start(t)
  click.stop(t + 0.05)
}

// Soft icy whoosh — fires on Chill Zone placement. Low-volume "frosting over" texture so it
// doesn't compete with the beat-dash boom that fires simultaneously.
export function playChillZonePlace(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  // Filtered noise sweep — descending highpass for "settling frost" feel
  const dur = 0.35
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
  const noise = c.createBufferSource()
  noise.buffer = buf
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.setValueAtTime(3000, t)
  hp.frequency.exponentialRampToValueAtTime(700, t + dur)
  const gain = c.createGain()
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(rVol(0.16), t + 0.04)
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
  noise.connect(hp)
  hp.connect(gain)
  gain.connect(master)
  noise.start(t)
}

// Sharp glass crack + crystalline tinkle — the climax SFX for the old zone shattering.
// Three layers: a sub-thump for impact, mid crackle for glass, high shimmer for crystal.
export function playIceShardBurst(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // Layer 1: Sub-thump impact
  const thump = c.createOscillator()
  const thumpGain = c.createGain()
  thump.type = 'sine'
  thump.frequency.setValueAtTime(rPitch(140), t)
  thump.frequency.exponentialRampToValueAtTime(rPitch(50), t + 0.15)
  thumpGain.gain.setValueAtTime(rVol(0.45), t)
  thumpGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
  thump.connect(thumpGain)
  thumpGain.connect(master)
  thump.start(t)
  thump.stop(t + 0.2)

  // Layer 2: Glass crack — fast noise burst, bandpassed mid
  const crackBuf = c.createBuffer(1, c.sampleRate * 0.18, c.sampleRate)
  const crackData = crackBuf.getChannelData(0)
  for (let i = 0; i < crackData.length; i++) crackData[i] = (Math.random() * 2 - 1) * (1 - i / crackData.length)
  const crack = c.createBufferSource()
  crack.buffer = crackBuf
  const bp = c.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.setValueAtTime(2200, t)
  bp.Q.setValueAtTime(2, t)
  const crackGain = c.createGain()
  crackGain.gain.setValueAtTime(rVol(0.55), t)
  crackGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18)
  crack.connect(bp)
  bp.connect(crackGain)
  crackGain.connect(master)
  crack.start(t)

  // Layer 3: Crystalline tinkles — three quick descending notes for the "shards falling" feel
  const notes = [rPitch(2400), rPitch(2000), rPitch(1600)]
  for (let i = 0; i < notes.length; i++) {
    const tn = t + i * 0.04
    const osc = c.createOscillator()
    const oGain = c.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(notes[i]!, tn)
    oGain.gain.setValueAtTime(rVol(0.18), tn)
    oGain.gain.exponentialRampToValueAtTime(0.001, tn + 0.18)
    osc.connect(oGain)
    oGain.connect(master)
    osc.start(tn)
    osc.stop(tn + 0.2)
  }
}

// Ghostly upward-pitching whoosh — fires at the start of an Echo Step recall and runs about
// as long as the 0.5s ghost-traversal so the audio reaches its peak as the player lands.
export function playRecallStart(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // High shimmering body — sine that pitches up over the recall window
  const tone = c.createOscillator()
  const toneGain = c.createGain()
  tone.type = 'sine'
  tone.frequency.setValueAtTime(rPitch(320), t)
  tone.frequency.exponentialRampToValueAtTime(rPitch(1200), t + 0.45)
  toneGain.gain.setValueAtTime(0.001, t)
  toneGain.gain.linearRampToValueAtTime(rVol(0.28), t + 0.04)
  toneGain.gain.exponentialRampToValueAtTime(0.001, t + 0.48)
  tone.connect(toneGain)
  toneGain.connect(master)
  tone.start(t)
  tone.stop(t + 0.5)

  // Air whoosh — noise burst high-passed for the "passing through space" texture
  const buf = c.createBuffer(1, c.sampleRate * 0.45, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
  const noise = c.createBufferSource()
  noise.buffer = buf
  const hp = c.createBiquadFilter()
  hp.type = 'highpass'
  hp.frequency.setValueAtTime(800, t)
  hp.frequency.linearRampToValueAtTime(2400, t + 0.45)
  const noiseGain = c.createGain()
  noiseGain.gain.setValueAtTime(0.001, t)
  noiseGain.gain.linearRampToValueAtTime(rVol(0.18), t + 0.05)
  noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.48)
  noise.connect(hp)
  hp.connect(noiseGain)
  noiseGain.connect(master)
  noise.start(t)
}

export function playBeatDash(): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime

  // The low body (sub thump + whomp) is offset a hair so its sharp attack doesn't land on the exact
  // same sample as a coincident smear's thump — two separate transients duck the shared compressor
  // far less than one doubled one, so the AOE and the smear LAYER instead of eating each other. The
  // noise snap (Layer 5) stays at t as the on-beat detonation crack, so nothing reads as late.
  const lowT = t + 0.022

  // Layer 1: Sub thump — gut punch, fast attack
  const thump = c.createOscillator()
  const thumpGain = c.createGain()
  thump.type = 'sine'
  thump.frequency.setValueAtTime(rPitch(90), lowT)
  thump.frequency.exponentialRampToValueAtTime(rPitch(30), lowT + 0.2)
  thumpGain.gain.setValueAtTime(rVol(0.7), lowT)
  thumpGain.gain.exponentialRampToValueAtTime(0.001, lowT + 0.2)
  thump.connect(thumpGain)
  thumpGain.connect(master)
  thump.start(lowT)
  thump.stop(lowT + 0.2)

  // Layer 2: Chunky "whomp" — the satisfying part
  // Descending chord hit — two notes a fifth apart for richness
  const whomp1 = c.createOscillator()
  const whomp2 = c.createOscillator()
  const whompGain = c.createGain()
  whomp1.type = 'triangle'
  whomp2.type = 'triangle'
  whomp1.frequency.setValueAtTime(rPitch(220), lowT)
  whomp1.frequency.exponentialRampToValueAtTime(rPitch(110), lowT + 0.18)
  whomp2.frequency.setValueAtTime(rPitch(330), lowT)  // perfect fifth
  whomp2.frequency.exponentialRampToValueAtTime(rPitch(165), lowT + 0.18)
  whompGain.gain.setValueAtTime(rVol(0.4), lowT)
  whompGain.gain.exponentialRampToValueAtTime(0.001, lowT + 0.22)
  whomp1.connect(whompGain)
  whomp2.connect(whompGain)
  whompGain.connect(master)
  whomp1.start(lowT)
  whomp2.start(lowT)
  whomp1.stop(lowT + 0.22)
  whomp2.stop(lowT + 0.22)

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
  // Two-note ascending chime — the pickup itself (tail extended so it lingers a bit more)
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'sine'
  osc1.frequency.value = rPitch(700)
  osc2.type = 'sine'
  osc2.frequency.value = rPitch(1050)
  gain.gain.setValueAtTime(rVol(0.5), t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22)
  osc1.connect(gain)
  osc2.connect(gain)
  gain.connect(reverbInput)
  osc1.start(t)
  osc2.start(t + 0.04)
  osc1.stop(t + 0.1)
  osc2.stop(t + 0.22)
  // Heal twinkle tail — sparkles on CONSONANT harmonics of the chime's top note (fifth, octave, +an
  // octave), starting DURING the chime's ring so it fuses into one satisfying "collect + heal" glow
  // instead of sounding like a separate arpeggio. Quiet, rising, reverb.
  const twMul = [1.5, 2.0, 3.0]
  for (let i = 0; i < twMul.length; i++) {
    const at = t + 0.055 + i * 0.04                 // overlaps the chime's sustain (no gap)
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'sine'; o.frequency.setValueAtTime(rPitch(1050 * twMul[i]!), at)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(rVol(0.11 - i * 0.02), at + 0.008)
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.32)
    o.connect(g); g.connect(reverbInput)
    o.start(at); o.stop(at + 0.34)
  }
}

// Speed-boost surge — plays the instant an overheal heart grants the boost (with the star burst).
// Designed to LAYER over playCollect (a 700→1050Hz chime): a rising "launch" whoosh under it, an
// airy noise swoosh for speed, and a sparkle ping above — together they read as "collect + surge"
// without masking the collect chime.
export function playSpeedBoost(count = 1): void {
  ensureContext()
  const c = ctx!
  const t = c.currentTime
  const baseDeg = explodeWalkStep++ % 5   // vary the phrase per pickup so repeats don't feel samey
  const lvl = Math.max(0, Math.min(1, (count - 1) / 2))   // 0/0.5/1 at count 1/2/3 → bigger at 200%
  // (1) Ascending in-key POWER-UP arpeggio that resolves UP — the satisfying "level up" hit. Each
  // note brighter, the last one a sustained triangle bell with reverb = a clear, rewarding resolve.
  // A 3-overheal (200%) grab adds an extra octave note on top so the phrase climbs higher.
  const degs = lvl >= 1 ? [0, 2, 4, 7, 9] : [0, 2, 4, 7]
  degs.forEach((deg, i) => {
    const last = i === degs.length - 1
    const f = currentMusic ? degreeToFreq(currentMusic, baseDeg + deg, 1) : 523 * Math.pow(2, i / 3.5)
    const at = t + i * 0.05
    const o = c.createOscillator(); const g = c.createGain()
    o.type = last ? 'triangle' : 'sine'
    o.frequency.setValueAtTime(f, at)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(rVol((last ? 0.16 : 0.10) * (1 + lvl * 0.25)), at + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, at + (last ? 0.5 : 0.14))
    o.connect(g); g.connect(master)
    const rs = c.createGain(); rs.gain.value = rVol(last ? 0.09 : 0.05); g.connect(rs); rs.connect(reverbInput)
    o.start(at); o.stop(at + (last ? 0.54 : 0.16))
  })
  // (2) Glitter cascade — quick high in-key sparkles for the magical fairy shimmer (ties to the
  // star burst), climbing as the arpeggio resolves. More sparkles at higher counts.
  const glitterDegs = [0, 2, 4, 7, 9, 11]
  const glitterN = 6 + Math.round(lvl * 4)   // 6 / 8 / 10
  for (let i = 0; i < glitterN; i++) {
    const at = t + 0.02 + i * 0.028
    const deg = glitterDegs[i % glitterDegs.length]!
    const f = currentMusic ? degreeToFreq(currentMusic, baseDeg + deg, 2 + Math.floor(i / glitterDegs.length)) : 1400 + i * 220
    const o = c.createOscillator(); const g = c.createGain()
    o.type = 'sine'; o.frequency.setValueAtTime(f, at)
    g.gain.setValueAtTime(0.0001, at)
    g.gain.linearRampToValueAtTime(rVol(0.05), at + 0.006)
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.18)
    o.connect(g); g.connect(reverbInput)
    o.start(at); o.stop(at + 0.2)
  }
  // (3) Launch whoosh underneath — the speed/surge texture, sweeping up.
  const wo = c.createOscillator(); const wg = c.createGain(); const wlp = c.createBiquadFilter()
  wo.type = 'triangle'
  wo.frequency.setValueAtTime(rPitch(300), t)
  wo.frequency.exponentialRampToValueAtTime(rPitch(1150), t + 0.2)
  wlp.type = 'lowpass'; wlp.frequency.setValueAtTime(600, t); wlp.frequency.exponentialRampToValueAtTime(3000, t + 0.2)
  wg.gain.setValueAtTime(0.0001, t)
  wg.gain.linearRampToValueAtTime(rVol(0.07), t + 0.02)
  wg.gain.exponentialRampToValueAtTime(0.001, t + 0.26)
  wo.connect(wlp); wlp.connect(wg); wg.connect(master)
  wo.start(t); wo.stop(t + 0.28)
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

// ── Danger music — descending warning melody synced to beat when low HP ──

let dangerStep = 0
let dangerLastBeat = -1
let dangerHpFraction = 1

// Descending minor pattern — plays on the beat
const DANGER_PATTERN = [0, -1, -3, -5]

/** Call each frame with player HP fraction (0-1) */
export function updateDangerMusic(hpFraction: number): void {
  dangerHpFraction = hpFraction
}

/** Called from beat system — plays danger note on beat when HP is low */
export function tickDangerBeat(beatPosition: number): void {
  if (!ctx || !master) return
  const threshold = 0.35
  if (dangerHpFraction >= threshold || dangerHpFraction <= 0) {
    dangerStep = 0
    dangerLastBeat = -1
    return
  }

  const intensity = 1 - (dangerHpFraction / threshold)

  // Double time normally, quadruple time when critical
  const mult = intensity > 0.6 ? 4 : 2
  const beatRes = Math.floor(beatPosition * mult)
  if (beatRes === dangerLastBeat) return
  dangerLastBeat = beatRes

  playDangerNote(intensity, dangerStep)
  dangerStep = (dangerStep + 1) % DANGER_PATTERN.length
}

function playDangerNote(intensity: number, step: number): void {
  const c = ctx!
  const t = c.currentTime + 0.37  // sync with BeatLoop's schedule offset

  const semitone = Math.pow(2, 1 / 12)
  const baseFreq = currentMusic ? currentMusic.droneRoot * 2 : 220  // one octave above drone root
  const degree = DANGER_PATTERN[step]!
  const freq = baseFreq * Math.pow(semitone, degree)

  const vol = 0.2 + intensity * 0.2

  // Melody note — sine
  const osc1 = c.createOscillator()
  const g1 = c.createGain()
  osc1.type = 'sine'
  osc1.frequency.setValueAtTime(freq, t)
  g1.gain.setValueAtTime(vol, t)
  g1.gain.exponentialRampToValueAtTime(0.001, t + 0.45)
  osc1.connect(g1)
  g1.connect(master)
  osc1.start(t)
  osc1.stop(t + 0.45)

  // Dark minor third — triangle
  const osc2 = c.createOscillator()
  const g2 = c.createGain()
  osc2.type = 'triangle'
  osc2.frequency.setValueAtTime(freq * 1.189, t)  // minor 3rd
  g2.gain.setValueAtTime(vol * 0.5, t)
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.35)
  osc2.connect(g2)
  g2.connect(master)
  osc2.start(t)
  osc2.stop(t + 0.35)

  // Low octave — weight
  const osc3 = c.createOscillator()
  const g3 = c.createGain()
  osc3.type = 'sine'
  osc3.frequency.setValueAtTime(freq * 0.5, t)
  g3.gain.setValueAtTime(vol * 0.35, t)
  g3.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
  osc3.connect(g3)
  g3.connect(master)
  osc3.start(t)
  osc3.stop(t + 0.5)
}

/** Death roll — dramatic drum roll + sad trombone, you're dead bro */
export function playDeathRoll(): void {
  if (!ctx || !master) return
  const c = ctx
  const t = c.currentTime

  // ── Part 1: Accelerating drum roll — builds tension ──
  const rollCount = 22
  for (let i = 0; i < rollCount; i++) {
    // Accelerating: starts slow, gets frantic
    const spacing = 0.08 - (i / rollCount) * 0.05  // 80ms → 30ms
    let noteTime = t
    for (let j = 0; j <= i; j++) noteTime = t + j * (0.08 - (j / rollCount) * 0.05)
    // Recompute properly
    noteTime = t
    for (let j = 0; j < i; j++) noteTime += 0.08 - (j / rollCount) * 0.05

    const vol = 0.2 + (i / rollCount) * 0.35  // gets louder

    // Snare-like hit — noise burst + tone
    const noise = c.createOscillator()
    const nGain = c.createGain()
    noise.type = 'square'
    noise.frequency.setValueAtTime(200 + Math.random() * 800, noteTime)
    noise.frequency.setValueAtTime(100 + Math.random() * 400, noteTime + 0.02)
    nGain.gain.setValueAtTime(vol * 0.6, noteTime)
    nGain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.04)
    noise.connect(nGain)
    nGain.connect(master)
    noise.start(noteTime)
    noise.stop(noteTime + 0.04)

    // Tonal hit underneath
    const tom = c.createOscillator()
    const tGain = c.createGain()
    tom.type = 'sine'
    tom.frequency.setValueAtTime(180 - (i / rollCount) * 60, noteTime)
    tom.frequency.exponentialRampToValueAtTime(60, noteTime + 0.08)
    tGain.gain.setValueAtTime(vol * 0.5, noteTime)
    tGain.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.08)
    tom.connect(tGain)
    tGain.connect(master)
    tom.start(noteTime)
    tom.stop(noteTime + 0.08)
  }

  // Time when roll ends
  let rollEnd = t
  for (let j = 0; j < rollCount; j++) rollEnd += 0.08 - (j / rollCount) * 0.05

  // ── Part 2: Crash cymbal at the peak ──
  for (let i = 0; i < 6; i++) {
    const crash = c.createOscillator()
    const cGain = c.createGain()
    crash.type = 'square'
    crash.frequency.value = 3000 + Math.random() * 5000
    cGain.gain.setValueAtTime(0.18, rollEnd)
    cGain.gain.exponentialRampToValueAtTime(0.001, rollEnd + 0.3)
    crash.connect(cGain)
    cGain.connect(master)
    crash.start(rollEnd)
    crash.stop(rollEnd + 0.3)
  }
  // Big double kick at crash
  for (let k = 0; k < 2; k++) {
    const kick = c.createOscillator()
    const kGain = c.createGain()
    kick.type = 'sine'
    kick.frequency.setValueAtTime(180, rollEnd + k * 0.08)
    kick.frequency.exponentialRampToValueAtTime(25, rollEnd + k * 0.08 + 0.25)
    kGain.gain.setValueAtTime(0.65, rollEnd + k * 0.08)
    kGain.gain.exponentialRampToValueAtTime(0.001, rollEnd + k * 0.08 + 0.3)
    kick.connect(kGain)
    kGain.connect(master)
    kick.start(rollEnd + k * 0.08)
    kick.stop(rollEnd + k * 0.08 + 0.3)
  }

  // ── Part 3: Sad trombone — bwah bwah bwah bwaaahhh ──
  const tStart = rollEnd + 0.2
  const root = currentMusic ? currentMusic.droneRoot : 110

  // Classic descending 4-note sad melody — in key with the music
  // Root → major 7th → 5th → drops to minor 3rd below (the sad resolution)
  const sadNotes = [root * 2, root * 2 * 0.944, root * 1.5, root * 0.6]
  const durations = [0.35, 0.35, 0.35, 1.4]

  let noteStart = tStart
  for (let i = 0; i < sadNotes.length; i++) {
    const freq = sadNotes[i]!
    const dur = durations[i]!
    const isLast = i === sadNotes.length - 1

    // Main voice — warm triangle trombone
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, noteStart)
    if (isLast) {
      // Last note bends down slowly — the "bwaaahhh"
      osc.frequency.exponentialRampToValueAtTime(freq * 0.75, noteStart + dur)
    }
    const nVol = isLast ? 0.45 : 0.38
    g.gain.setValueAtTime(nVol, noteStart)
    g.gain.setValueAtTime(nVol * 0.85, noteStart + 0.04)
    g.gain.exponentialRampToValueAtTime(0.001, noteStart + dur)
    osc.connect(g)
    g.connect(master)
    osc.start(noteStart)
    osc.stop(noteStart + dur)

    // Trombone vibrato
    const vib = c.createOscillator()
    const vibG = c.createGain()
    vib.type = 'sine'
    vib.frequency.value = isLast ? 4 : 5.5
    vibG.gain.value = freq * (isLast ? 0.025 : 0.012)
    vib.connect(vibG)
    vibG.connect(osc.frequency)
    vib.start(noteStart)
    vib.stop(noteStart + dur)

    // Fifth below — gives it that brass section thickness
    const fifth = c.createOscillator()
    const fG = c.createGain()
    fifth.type = 'triangle'
    fifth.frequency.setValueAtTime(freq * 0.667, noteStart)  // perfect 4th below
    if (isLast) fifth.frequency.exponentialRampToValueAtTime(freq * 0.667 * 0.75, noteStart + dur)
    fG.gain.setValueAtTime(nVol * 0.35, noteStart)
    fG.gain.exponentialRampToValueAtTime(0.001, noteStart + dur)
    fifth.connect(fG)
    fG.connect(master)
    fifth.start(noteStart)
    fifth.stop(noteStart + dur)

    // Octave below — weight
    const sub = c.createOscillator()
    const sG = c.createGain()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(freq * 0.5, noteStart)
    if (isLast) sub.frequency.exponentialRampToValueAtTime(freq * 0.5 * 0.75, noteStart + dur)
    sG.gain.setValueAtTime(nVol * 0.2, noteStart)
    sG.gain.exponentialRampToValueAtTime(0.001, noteStart + dur)
    sub.connect(sG)
    sG.connect(master)
    sub.start(noteStart)
    sub.stop(noteStart + dur)

    noteStart += dur + 0.04
  }
}

/** Victory fanfare — ascending drum roll + triumphant major melody */
export function playVictoryFanfare(): void {
  if (!ctx || !master) return
  const c = ctx
  const t = c.currentTime
  const root = currentMusic ? currentMusic.droneRoot : 110

  // ── Part 1: Ascending drum roll — excitement builds ──
  const rollCount = 18
  for (let i = 0; i < rollCount; i++) {
    let noteTime = t
    for (let j = 0; j < i; j++) noteTime += 0.07 - (j / rollCount) * 0.04

    const vol = 0.2 + (i / rollCount) * 0.3

    // Bright snare hit — higher pitched than death roll
    const hit = c.createOscillator()
    const hG = c.createGain()
    hit.type = 'triangle'
    hit.frequency.setValueAtTime(400 + (i / rollCount) * 300, noteTime)
    hit.frequency.exponentialRampToValueAtTime(200, noteTime + 0.03)
    hG.gain.setValueAtTime(vol * 0.5, noteTime)
    hG.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.04)
    hit.connect(hG)
    hG.connect(master)
    hit.start(noteTime)
    hit.stop(noteTime + 0.04)

    // Rising tom underneath
    const tom = c.createOscillator()
    const tG = c.createGain()
    tom.type = 'sine'
    tom.frequency.setValueAtTime(100 + (i / rollCount) * 120, noteTime)
    tom.frequency.exponentialRampToValueAtTime(80, noteTime + 0.06)
    tG.gain.setValueAtTime(vol * 0.4, noteTime)
    tG.gain.exponentialRampToValueAtTime(0.001, noteTime + 0.06)
    tom.connect(tG)
    tG.connect(master)
    tom.start(noteTime)
    tom.stop(noteTime + 0.06)
  }

  // Roll end time
  let rollEnd = t
  for (let j = 0; j < rollCount; j++) rollEnd += 0.07 - (j / rollCount) * 0.04

  // ── Part 2: Crash + big kick ──
  for (let i = 0; i < 5; i++) {
    const crash = c.createOscillator()
    const cG = c.createGain()
    crash.type = 'square'
    crash.frequency.value = 4000 + Math.random() * 4000
    cG.gain.setValueAtTime(0.14, rollEnd)
    cG.gain.exponentialRampToValueAtTime(0.001, rollEnd + 0.4)
    crash.connect(cG)
    cG.connect(master)
    crash.start(rollEnd)
    crash.stop(rollEnd + 0.4)
  }
  const kick = c.createOscillator()
  const kG = c.createGain()
  kick.type = 'sine'
  kick.frequency.setValueAtTime(180, rollEnd)
  kick.frequency.exponentialRampToValueAtTime(30, rollEnd + 0.2)
  kG.gain.setValueAtTime(0.55, rollEnd)
  kG.gain.exponentialRampToValueAtTime(0.001, rollEnd + 0.25)
  kick.connect(kG)
  kG.connect(master)
  kick.start(rollEnd)
  kick.stop(rollEnd + 0.25)

  // ── Part 3: Triumphant ascending melody — major arpeggio ──
  const melStart = rollEnd + 0.15

  // Ascending: root → major 3rd → 5th → octave → high major 3rd (the victory!)
  const melNotes = [root * 2, root * 2.5, root * 3, root * 4, root * 5]
  const melDurs = [0.2, 0.2, 0.2, 0.25, 1.0]

  let mStart = melStart
  for (let i = 0; i < melNotes.length; i++) {
    const freq = melNotes[i]!
    const dur = melDurs[i]!
    const isLast = i === melNotes.length - 1

    // Bright brass — triangle
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(freq, mStart)
    if (isLast) {
      // Last note shimmers slightly up — triumphant lift
      osc.frequency.linearRampToValueAtTime(freq * 1.02, mStart + dur)
    }
    const nVol = isLast ? 0.45 : 0.35
    g.gain.setValueAtTime(nVol, mStart)
    g.gain.setValueAtTime(nVol * 0.9, mStart + 0.03)
    g.gain.exponentialRampToValueAtTime(0.001, mStart + dur)
    osc.connect(g)
    g.connect(master)
    osc.start(mStart)
    osc.stop(mStart + dur)

    // Vibrato on last note
    if (isLast) {
      const vib = c.createOscillator()
      const vibG = c.createGain()
      vib.type = 'sine'
      vib.frequency.value = 5.5
      vibG.gain.value = freq * 0.012
      vib.connect(vibG)
      vibG.connect(osc.frequency)
      vib.start(mStart)
      vib.stop(mStart + dur)
    }

    // Perfect fifth above — bright harmony
    const harm = c.createOscillator()
    const hG2 = c.createGain()
    harm.type = 'sine'
    harm.frequency.setValueAtTime(freq * 1.5, mStart)
    if (isLast) harm.frequency.linearRampToValueAtTime(freq * 1.5 * 1.02, mStart + dur)
    hG2.gain.setValueAtTime(nVol * 0.3, mStart)
    hG2.gain.exponentialRampToValueAtTime(0.001, mStart + dur)
    harm.connect(hG2)
    hG2.connect(master)
    harm.start(mStart)
    harm.stop(mStart + dur)

    // Octave below — fullness
    const sub = c.createOscillator()
    const sG = c.createGain()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(freq * 0.5, mStart)
    sG.gain.setValueAtTime(nVol * 0.2, mStart)
    sG.gain.exponentialRampToValueAtTime(0.001, mStart + dur)
    sub.connect(sG)
    sG.connect(master)
    sub.start(mStart)
    sub.stop(mStart + dur)

    mStart += dur + 0.02
  }

  // ── Part 4: Final sustained major chord — the glow ──
  const chordTime = mStart + 0.05
  const chordDur = 2.0
  const chordNotes = [root * 2, root * 2.5, root * 3, root * 4]  // root, 3rd, 5th, octave
  for (const freq of chordNotes) {
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    g.gain.setValueAtTime(0.12, chordTime)
    g.gain.exponentialRampToValueAtTime(0.001, chordTime + chordDur)
    osc.connect(g)
    g.connect(master)
    osc.start(chordTime)
    osc.stop(chordTime + chordDur)
  }

  // Sparkle — high sine chimes scattered over the chord
  for (let i = 0; i < 8; i++) {
    const sparkTime = chordTime + i * 0.15 + Math.random() * 0.08
    const sparkFreq = root * (8 + Math.random() * 8)  // high octaves
    const sp = c.createOscillator()
    const spG = c.createGain()
    sp.type = 'sine'
    sp.frequency.value = sparkFreq
    spG.gain.setValueAtTime(0.08, sparkTime)
    spG.gain.exponentialRampToValueAtTime(0.001, sparkTime + 0.2)
    sp.connect(spG)
    spG.connect(master)
    sp.start(sparkTime)
    sp.stop(sparkTime + 0.2)
  }
}

// ── Enemy beat dispatch ──

// Base frequencies + wave types for harmony generation (avoids duplicating sound functions)
const HARMONY_BASE: Record<string, { freq: number; type: OscillatorType; dur: number }> = {
  pop:     { freq: 500,  type: 'triangle', dur: 0.1 },
  click:   { freq: 800,  type: 'square',   dur: 0.05 },
  snap:    { freq: 300,  type: 'sawtooth', dur: 0.07 },
  bell:    { freq: 880,  type: 'sine',     dur: 0.25 },
  buzz:    { freq: 220,  type: 'sawtooth', dur: 0.08 },
  thump:   { freq: 120,  type: 'sine',     dur: 0.12 },
  chirp:   { freq: 900,  type: 'sine',     dur: 0.08 },
  zap:     { freq: 600,  type: 'sawtooth', dur: 0.08 },
  bloop:   { freq: 400,  type: 'sine',     dur: 0.12 },
  clap:    { freq: 1500, type: 'square',   dur: 0.06 },
  rim:     { freq: 700,  type: 'triangle', dur: 0.04 },
  tom:     { freq: 175,  type: 'sine',     dur: 0.15 },
  whistle: { freq: 1000, type: 'sine',     dur: 0.2 },
  purr:    { freq: 55,   type: 'sine',     dur: 0.2 },
  ping:    { freq: 1200, type: 'sine',     dur: 0.15 },
  growl:   { freq: 80,   type: 'sawtooth', dur: 0.15 },
  chime:   { freq: 1100, type: 'sine',     dur: 0.25 },
  knock:   { freq: 400,  type: 'triangle', dur: 0.05 },
  sweep:   { freq: 300,  type: 'sine',     dur: 0.2 },
  drop:    { freq: 600,  type: 'sine',     dur: 0.15 },
  pulse:   { freq: 200,  type: 'square',   dur: 0.1 },
}

function addHarmonyNote(sound: string, freqMult: number, volMult: number, delay: number): void {
  const c = ctx!
  const t = c.currentTime + delay
  const base = HARMONY_BASE[sound]
  if (!base) return
  const dur = base.dur * 1.5  // harmony notes ring longer
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'  // always sine for clean harmony
  osc.frequency.setValueAtTime(base.freq * freqMult, t)
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, base.freq * freqMult * 0.7), t + dur)
  gain.gain.setValueAtTime(eVol('sine') * volMult, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur)
  osc.connect(gain)
  gain.connect(reverbInput)
  osc.start(t)
  osc.stop(t + dur)
}

export function playEnemyBeatTick(enemyType: string, sound?: string, harmony = 1): void {
  ensureContext()
  const c = ctx!
  // Enemy chorus is the densest emitter — yield first when the voice budget is tight so player-
  // relevant sounds (hits, explosions, dash) keep their headroom.
  if (!admitVoice('low')) return
  // Musical path — route through the scale-quantized SFX layer so attacks land in-key.
  // The `sound` string still picks the timbre + register; pitch comes from the scale. NO
  // per-type throttle here: a salvo's members must all sound (they walk into an arpeggio);
  // density is managed by MusicalSFX's voice cap + per-pitch dedupe instead.
  if (isScaleLock()) {
    playAttackNoteForEnemy(enemyType, sound ?? 'pop', harmony)
    return
  }

  // Legacy fixed-pitch path (scaleLock off — used for A/B in the Sound Lab). The per-type
  // throttle guards against click-storms here, where there's no voice manager.
  const lastTime = lastTickByType.get(enemyType) ?? 0
  if (c.currentTime - lastTime < TICK_MIN_INTERVAL) return
  lastTickByType.set(enemyType, c.currentTime)
  const soundFn = SOUND_MAP[sound ?? 'pop']
  if (soundFn) soundFn()
  if (harmony >= 2) addHarmonyNote(sound ?? 'pop', 1.25, 1.0, 0.01)   // major third, slight delay
  if (harmony >= 3) addHarmonyNote(sound ?? 'pop', 1.5, 0.8, 0.02)    // perfect fifth, more delay
}

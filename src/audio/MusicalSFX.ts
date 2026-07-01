// ── Musical SFX layer ──────────────────────────────────────────────────────
// The single home for COMBAT sound policy. Callers declare INTENT ("a bullet
// detonated, mid register, degree 3") and this layer turns it into an in-key,
// snappy note: pitch from the current scale (never a raw Hz literal), register
// from rhythmic role, timbre from attack type. It owns voice management (cap +
// dedupe) so a swarm stays a groove instead of mud.
//
// Dependency direction is one-way and clean: AudioEngine inits this with the
// audio bus (like initSynth/initDrone) and pushes the current WaveMusic; this
// module only reaches DOWN into MusicScale for pitch. It never touches the
// AudioContext lifecycle or the music backing track.

import { degreeToFreq, type WaveMusic } from './MusicScale.ts'
import { BEAT_SEC } from '../utils/constants.ts'

export type Register = 'bass' | 'mid' | 'high'

// Octave offset (relative to the scale's home octave 4) for each rhythmic register.
// Faster/lighter threats sit higher, heavier/slower ones lower — so pitch height
// reads as rhythmic role.
const REGISTER_OCT: Record<Register, number> = { bass: -1, mid: 0, high: 1 }

interface Timbre { osc: OscillatorType; register: Register; snap: boolean }

// Attack-type → timbre. `osc` carries the texture, `register` the default pitch
// band (overridable per call), `snap` adds a short filtered-noise transient for
// a percussive pluck. Reuses the existing `sound` vocabulary so designs map over.
const TIMBRES: Record<string, Timbre> = {
  // bass band — heavy / slow
  thump: { osc: 'sine', register: 'bass', snap: false },
  purr: { osc: 'sine', register: 'bass', snap: false },
  growl: { osc: 'sawtooth', register: 'bass', snap: false },
  tom: { osc: 'sine', register: 'bass', snap: true },
  pulse: { osc: 'square', register: 'bass', snap: false },
  buzz: { osc: 'sawtooth', register: 'bass', snap: false },
  drop: { osc: 'sine', register: 'bass', snap: true },
  bass: { osc: 'triangle', register: 'bass', snap: false },
  // mid band — bullets / half-beat
  pop: { osc: 'triangle', register: 'mid', snap: true },
  bloop: { osc: 'sine', register: 'mid', snap: false },
  knock: { osc: 'triangle', register: 'mid', snap: true },
  snap: { osc: 'sawtooth', register: 'mid', snap: true },
  rim: { osc: 'triangle', register: 'mid', snap: true },
  sweep: { osc: 'sine', register: 'mid', snap: false },
  zap: { osc: 'sawtooth', register: 'mid', snap: true },
  pluck: { osc: 'triangle', register: 'mid', snap: true },
  // high band — quick / quarter / staccato
  click: { osc: 'square', register: 'high', snap: true },
  bell: { osc: 'sine', register: 'high', snap: false },
  chirp: { osc: 'sine', register: 'high', snap: true },
  clap: { osc: 'square', register: 'high', snap: true },
  whistle: { osc: 'sine', register: 'high', snap: false },
  ping: { osc: 'sine', register: 'high', snap: true },
  chime: { osc: 'sine', register: 'high', snap: false },
}
const DEFAULT_TIMBRE: Timbre = { osc: 'triangle', register: 'mid', snap: true }

// Perceived-loudness balance — so no timbre/register overpowers the others.
// Rich waveforms (saw/square) pack far more harmonic energy than a sine at the same
// gain, so they're scaled DOWN. Mids read loudest to the ear, so bass is nudged up
// and highs nudged down (gentle equal-loudness compensation).
const OSC_GAIN: Record<string, number> = { sine: 1.0, triangle: 0.82, square: 0.5, sawtooth: 0.48 }
const REG_GAIN: Record<Register, number> = { bass: 1.15, mid: 1.0, high: 0.78 }

// ── module state (injected / pushed by AudioEngine) ──
let ctx: AudioContext | null = null
let dest: AudioNode | null = null
let noiseBuffer: AudioBuffer | null = null
let music: WaveMusic | null = null

// ── policy flags (toggled live by the Sound Lab) ──
let scaleLock = true       // master switch: route combat sound through this musical layer
let quantize = false       // snap onsets to the sub-beat grid (experimental)

// ── voice management ──
const MAX_VOICES = 12             // hard cap on concurrent attack voices (anti-mud / anti-CPU)
let activeVoices = 0
const DEDUPE_WINDOW = 0.04        // s — identical pitch within this window collapses to one note
const lastByPitch = new Map<number, number>()

// Attack-activity meter — rises on each attack note, decays exponentially. Lets the music duck its
// melody when combat is busy (so the attacks lead). Read via getAttackActivity() (0..1).
let attackEnergy = 0
let energyClock = 0
const ENERGY_TAU = 0.7           // decay time constant (s)
function bumpAttackEnergy(): void {
  if (!ctx) return
  const now = ctx.currentTime
  if (energyClock > 0) attackEnergy *= Math.exp(-(now - energyClock) / ENERGY_TAU)
  energyClock = now
  attackEnergy = Math.min(1.5, attackEnergy + 0.25)
}
/** 0..1 combat-melody activity — high while attacks are firing, decays when they stop. */
export function getAttackActivity(): number {
  if (!ctx || energyClock <= 0) return 0
  const e = attackEnergy * Math.exp(-(ctx.currentTime - energyClock) / ENERGY_TAU)
  return Math.min(1, e)
}

export function initMusicalSFX(audioCtx: AudioContext, busDest: AudioNode): void {
  ctx = audioCtx
  dest = busDest
  // Pre-render a short white-noise buffer for the snap transients (cheap, reused).
  const len = Math.floor(audioCtx.sampleRate * 0.05)
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  noiseBuffer = buf
}

/** AudioEngine pushes the current wave's scale here on init + every wave change. */
export function setMusicalSFXMusic(m: WaveMusic): void { music = m }

export function isScaleLock(): boolean { return scaleLock }
export function setScaleLock(on: boolean): void { scaleLock = on }
export function isQuantize(): boolean { return quantize }
export function setQuantize(on: boolean): void { quantize = on }

function timbreFor(name: string): Timbre { return TIMBRES[name] ?? DEFAULT_TIMBRE }

/** Stable scale degree for an enemy type — same type always sings the same note,
 *  so a mixed field stacks into an in-key chord and each type has a pitch identity. */
function degreeForType(typeName: string): number {
  let h = 0
  for (let i = 0; i < typeName.length; i++) h = (h * 31 + typeName.charCodeAt(i)) | 0
  return Math.abs(h) % 5
}

function quantizeTime(t: number): number {
  if (!quantize) return t
  const slot = BEAT_SEC / 4            // 16th-note grid
  return Math.round(t / slot) * slot
}

interface NoteOpts { timbre?: string; register?: Register; degree: number; velocity?: number; when?: number }

/** The one entry point for every combat sound. Resolves pitch from the current
 *  scale and plays a snappy, voice-managed note. No-op until inited / music set. */
export function playAttackNote(opts: NoteOpts): void {
  if (!ctx || !dest || !music) return
  const t = timbreFor(opts.timbre ?? 'pop')
  const register = opts.register ?? t.register
  const freq = degreeToFreq(music, opts.degree, REGISTER_OCT[register])
  const vel = opts.velocity ?? 1
  const when = quantizeTime(Math.max(ctx.currentTime, opts.when ?? ctx.currentTime))

  // Per-pitch dedupe — many simultaneous same-pitch hits collapse to one note.
  const key = Math.round(freq)
  const last = lastByPitch.get(key) ?? -1
  if (when - last < DEDUPE_WINDOW) return
  lastByPitch.set(key, when)

  // Voice cap — drop notes past the cap rather than letting a swarm turn to mud.
  if (activeVoices >= MAX_VOICES) return

  bumpAttackEnergy()   // feed the activity meter so the music melody ducks while combat is busy
  playVoice(freq, t, register, vel, when)
}

function playVoice(freq: number, t: Timbre, register: Register, vel: number, when: number): void {
  const c = ctx!
  // Snappier + shorter up high, fuller + longer down low.
  const dur = register === 'bass' ? 0.26 : register === 'mid' ? 0.17 : 0.13
  // Gentle headroom + per-timbre/register loudness balance + a little extra duck when busy.
  const balance = (OSC_GAIN[t.osc] ?? 0.8) * REG_GAIN[register]
  const v = vel * 0.5 * balance * (1 - (activeVoices / MAX_VOICES) * 0.4)

  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = t.osc
  osc.frequency.setValueAtTime(freq, when)
  // Tiny downward settle = pluck character (not a flat tone).
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, freq * 0.985), when + dur)
  g.gain.setValueAtTime(0.0001, when)
  g.gain.linearRampToValueAtTime(v, when + 0.002)        // 2ms attack — percussive but not a click
  g.gain.exponentialRampToValueAtTime(0.0007, when + dur)
  osc.connect(g)
  g.connect(dest!)
  osc.start(when)
  osc.stop(when + dur + 0.02)
  activeVoices++
  osc.onended = () => { activeVoices = Math.max(0, activeVoices - 1) }

  // Snap transient — short, LOW-PASSED noise so the attack reads as a pluck, not a harsh click.
  if (t.snap && noiseBuffer) {
    const src = c.createBufferSource()
    src.buffer = noiseBuffer
    const lp = c.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = register === 'high' ? 4200 : register === 'mid' ? 2600 : 1500
    const ng = c.createGain()
    const ndur = 0.03
    ng.gain.setValueAtTime(v * 0.5, when)
    ng.gain.exponentialRampToValueAtTime(0.0005, when + ndur)
    src.connect(lp); lp.connect(ng); ng.connect(dest!)
    src.start(when)
    src.stop(when + ndur + 0.01)
  }
}

// Each enemy type walks a rising run through the scale on successive fires, so a
// repeated attack becomes a MELODY and a salvo landing together (many fires in one
// frame) spreads into an ascending ARPEGGIO — instead of one note hammered over and
// over. Wraps after WALK_LEN degrees (≈1.5 octaves of pentatonic) into a fresh run.
const walkStep = new Map<string, number>()
const WALK_LEN = 8

/** Convenience used by the enemy-attack choke point: walk the type's melody one step,
 *  play the note, and add scale-quantized chord tones when several of the same type fire. */
export function playAttackNoteForEnemy(enemyType: string, sound: string, harmony = 1): void {
  if (!music) return
  const t = timbreFor(sound)
  const base = degreeForType(enemyType)
  const step = walkStep.get(enemyType) ?? 0
  walkStep.set(enemyType, step + 1)
  const degree = base + (step % WALK_LEN)
  playAttackNote({ timbre: sound, register: t.register, degree })
  if (harmony >= 2) playAttackNote({ timbre: sound, register: t.register, degree: degree + 2, velocity: 0.8 })
  if (harmony >= 3) playAttackNote({ timbre: sound, register: t.register, degree: degree + 4, velocity: 0.65 })
}

// Inharmonic partial ratios → struck-metal / bell timbre (NOT a clean sine). The non-integer overtones
// are what make it read as metallic. Break adds the top partial for extra clang.
const NODE_PARTIALS_HIT = [1, 2.76, 5.18]
const NODE_PARTIALS_BREAK = [1, 2.76, 5.18, 8.93]

/** Weak-node hit → a METALLIC strike (for the metal-piece nodes): inharmonic partials that ring, a
 *  band-passed noise "ting" transient, and reverb tail (dest = reverbInput). `degree` is the node
 *  index, so breaking a formation walks an ascending run / spreads into an arpeggio when a sweep hits
 *  several at once. Break rings longer/brighter + an octave sparkle. Scale-locked, voice-capped,
 *  per-pitch deduped (a swarm stays a chord, not mud). */
export function playNodeNote(degree: number, broke: boolean, whenArg?: number): void {
  if (!ctx || !dest || !music) return
  const c = ctx
  const when = whenArg ?? c.currentTime   // schedule ahead (used by the boss-death scale run)
  const f0 = degreeToFreq(music, degree, REGISTER_OCT.high)

  // Per-pitch dedupe — many simultaneous same-degree hits collapse to one strike.
  const key = Math.round(f0)
  if (when - (lastByPitch.get(key) ?? -1) < DEDUPE_WINDOW) return
  lastByPitch.set(key, when)
  // Voice cap — drop chips past the cap (breaks always ring so destruction is never silent).
  if (activeVoices >= MAX_VOICES && !broke) return

  bumpAttackEnergy()
  activeVoices++
  let freed = false
  const free = (): void => { if (!freed) { freed = true; activeVoices = Math.max(0, activeVoices - 1) } }

  const dur = broke ? 0.55 : 0.3
  const baseV = (broke ? 0.42 : 0.3) * (1 - (activeVoices / MAX_VOICES) * 0.3)
  const partials = broke ? NODE_PARTIALS_BREAK : NODE_PARTIALS_HIT
  partials.forEach((ratio, idx) => {
    const osc = c.createOscillator(); const g = c.createGain()
    osc.type = 'sine'
    osc.frequency.value = f0 * ratio * (0.998 + Math.random() * 0.004)   // tiny per-partial detune = shimmer
    const pdur = idx === 0 ? dur : dur * 0.5                              // overtones ring shorter than the fundamental
    const pv = idx === 0 ? baseV : baseV * (0.45 / idx)                  // and quieter
    g.gain.setValueAtTime(0.0001, when)
    g.gain.linearRampToValueAtTime(pv, when + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0006, when + pdur)
    osc.connect(g); g.connect(dest!)
    osc.start(when); osc.stop(when + pdur + 0.02)
    if (idx === 0) osc.onended = free
  })

  // Strike transient — short band-passed noise "ting" for the metal impact.
  if (noiseBuffer) {
    const src = c.createBufferSource(); src.buffer = noiseBuffer
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'
    bp.frequency.value = Math.min(9000, f0 * 5); bp.Q.value = 1.4
    const ng = c.createGain()
    const ndur = 0.035
    ng.gain.setValueAtTime(baseV * 0.6, when)
    ng.gain.exponentialRampToValueAtTime(0.0004, when + ndur)
    src.connect(bp); bp.connect(ng); ng.connect(dest!)
    src.start(when); src.stop(when + ndur + 0.01)
  }

  // Octave-up sparkle on break — destruction resolves brighter.
  if (broke) {
    const s = c.createOscillator(); const sg = c.createGain()
    s.type = 'sine'
    s.frequency.value = f0 * 2 * (1 + Math.random() * 0.003)
    sg.gain.setValueAtTime(0.0001, when + 0.012)
    sg.gain.linearRampToValueAtTime(baseV * 0.5, when + 0.024)
    sg.gain.exponentialRampToValueAtTime(0.0005, when + 0.5)
    s.connect(sg); sg.connect(dest!)
    s.start(when + 0.012); s.stop(when + 0.54)
  }
}

/** Boss death — a quick, satisfying RUN DOWN the scale (metallic bells), the composed death flourish
 *  played once on the killing blow (vs each node blipping its own note). ~0.4s falling collapse that
 *  resolves bright on the low root. */
export function playBossDeathRun(): void {
  if (!ctx || !music) return
  const t0 = ctx.currentTime
  const n = 9   // ~1.7 octaves of the pentatonic, DESCENDING (high → low)
  for (let i = 0; i < n; i++) {
    playNodeNote(n - 1 - i, i === n - 1, t0 + i * 0.045)   // final note = low root, rings brighter (resolve)
  }
}

/** All timbre names (for the Sound Lab UI). */
export function timbreNames(): string[] { return Object.keys(TIMBRES) }

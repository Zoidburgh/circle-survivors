// Palettes = the "KIT" axis of the music, orthogonal to the rhythm (BeatPresets) and the scale.
// A Palette bundles the VOICE timbres (kick/snare/hihat/melody), a continuous SUSTAIN layer (pad +
// bass engine), and a groove SWING. BeatLoop owns the scheduler + patterns and just calls into the
// active palette, so swapping kits is a live A/B with no change to the rhythm or key.
//
// This is the seam a future BEAT ASSEMBLER targets: it edits rhythm (BeatPreset) and picks a kit
// (Palette) — both already first-class, independent axes.

// Per-frame continuous layer for one palette (pad + bass). BeatLoop creates one on start and swaps it
// when the kit changes; per-hit bass notes come through bassHit, kick sidechain through duck.
export interface Sustain {
  stop(): void
  retune(root: number): void
  bassHit(time: number, freq: number, beatDuration: number): void
  duck(time: number): void
}

export interface Palette {
  name: string
  swing: number   // 0 = straight; ~0.14 delays the off-16ths for a human lilt
  kick(ctx: AudioContext, dest: AudioNode, time: number): void
  snare(ctx: AudioContext, dest: AudioNode, time: number): void
  hihat(ctx: AudioContext, dest: AudioNode, time: number): void
  melody(ctx: AudioContext, dest: AudioNode, time: number, freq: number, gain: number): void
  startSustain(ctx: AudioContext, dest: AudioNode, root: number): Sustain
}

// Shared white-noise buffer (shakers, claps, breath). Rebuilt if the sample rate changes.
let noiseBuf: AudioBuffer | null = null
function getNoise(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  noiseBuf = b
  return b
}

// Struck BRONZE — the gamelan metallophone timbre: INHARMONIC partials (a bronze bar's stretched
// overtones) with a detuned twin on the fundamental for the "ombak" shimmer/beating that defines
// gamelan. Fast mallet attack, ringing decay. Reused by the gangsa melody, the kempyang tick, and the
// low jegogan gong.
function strikeBronze(
  ctx: AudioContext, dest: AudioNode, time: number, freq: number,
  peak: number, decay: number, partials: number[] = [1, 2.76, 5.4], shimmer = 0.006,
): void {
  partials.forEach((p, idx) => {
    const pdecay = idx === 0 ? decay : decay * 0.45
    const pv = idx === 0 ? peak : peak * (0.4 / idx)
    const detunes = idx === 0 ? [1, 1 + shimmer] : [1]   // shimmer only on the fundamental (cheap + clean)
    for (const d of detunes) {
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = freq * p * d
      const vv = pv / detunes.length
      g.gain.setValueAtTime(0.0001, time)
      g.gain.linearRampToValueAtTime(vv, time + 0.003)
      g.gain.exponentialRampToValueAtTime(0.0004, time + pdecay)
      o.connect(g); g.connect(dest)
      o.start(time); o.stop(time + pdecay + 0.02)
    }
  })
}

// Pulse wave at a given DUTY cycle (0..1) — Web Audio's `square` is only 50%; real chip pulses use
// 12.5% / 25% / 50% for thin-nasal → full → hollow. Built from the Fourier series of a pulse train
// (imag coeff of harmonic k ∝ sin(k·π·duty)/k). Cached per duty (rebuilt if the AudioContext changes).
let pulseCtx: AudioContext | null = null
const pulseCache = new Map<number, PeriodicWave>()
function pulseWave(ctx: AudioContext, duty: number): PeriodicWave {
  if (pulseCtx !== ctx) { pulseCache.clear(); pulseCtx = ctx }
  const key = Math.round(duty * 1000)
  const cached = pulseCache.get(key)
  if (cached) return cached
  const n = 24
  const real = new Float32Array(n + 1)
  const imag = new Float32Array(n + 1)
  for (let k = 1; k <= n; k++) imag[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty)
  const wave = ctx.createPeriodicWave(real, imag)
  pulseCache.set(key, wave)
  return wave
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ELECTRONIC — the original BeatLoop voices, extracted verbatim so existing tracks are unchanged.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const ELECTRONIC: Palette = {
  name: 'Electronic',
  swing: 0,
  kick(ctx, dest, time) {
    const osc = ctx.createOscillator(); const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(160, time)
    osc.frequency.exponentialRampToValueAtTime(35, time + 0.12)
    gain.gain.setValueAtTime(0.8, time)
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25)
    osc.connect(gain); gain.connect(dest); osc.start(time); osc.stop(time + 0.25)
    const punch = ctx.createOscillator(); const pGain = ctx.createGain()
    punch.type = 'triangle'
    punch.frequency.setValueAtTime(100, time)
    punch.frequency.exponentialRampToValueAtTime(30, time + 0.08)
    pGain.gain.setValueAtTime(0.5, time)
    pGain.gain.exponentialRampToValueAtTime(0.001, time + 0.1)
    punch.connect(pGain); pGain.connect(dest); punch.start(time); punch.stop(time + 0.1)
    const click = ctx.createOscillator(); const cGain = ctx.createGain()
    click.type = 'square'; click.frequency.value = 350
    cGain.gain.setValueAtTime(0.3, time)
    cGain.gain.exponentialRampToValueAtTime(0.001, time + 0.01)
    click.connect(cGain); cGain.connect(dest); click.start(time); click.stop(time + 0.01)
  },
  snare(ctx, dest, time) {
    const osc = ctx.createOscillator(); const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(200, time)
    osc.frequency.exponentialRampToValueAtTime(80, time + 0.05)
    gain.gain.setValueAtTime(0.45, time)
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.12)
    osc.connect(gain); gain.connect(dest); osc.start(time); osc.stop(time + 0.12)
    for (let i = 0; i < 3; i++) {
      const n = ctx.createOscillator(); const nGain = ctx.createGain()
      n.type = 'square'; n.frequency.value = 2500 + Math.random() * 5000
      nGain.gain.setValueAtTime(0.1, time)
      nGain.gain.exponentialRampToValueAtTime(0.001, time + 0.08)
      n.connect(nGain); nGain.connect(dest); n.start(time); n.stop(time + 0.08)
    }
  },
  hihat(ctx, dest, time) {
    const osc = ctx.createOscillator(); const osc2 = ctx.createOscillator(); const gain = ctx.createGain()
    osc.type = 'square'; osc2.type = 'square'
    osc.frequency.value = 5000 + Math.random() * 3000
    osc2.frequency.value = 7000 + Math.random() * 3000
    gain.gain.setValueAtTime(0.08, time)
    gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
    osc.connect(gain); osc2.connect(gain); gain.connect(dest)
    osc.start(time); osc2.start(time); osc.stop(time + 0.05); osc2.stop(time + 0.05)
  },
  melody(ctx, dest, time, freq, gain) {
    const osc = ctx.createOscillator(); const g = ctx.createGain(); const filter = ctx.createBiquadFilter()
    osc.type = 'triangle'; osc.frequency.value = freq
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(1200, time)
    filter.frequency.exponentialRampToValueAtTime(450, time + 0.3)
    filter.Q.value = 1
    g.gain.setValueAtTime(gain, time)
    g.gain.setValueAtTime(gain, time + 0.08)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.2)
    osc.connect(filter); filter.connect(g); g.connect(dest)
    osc.start(time); osc.stop(time + 0.2)
  },
  startSustain(ctx, dest, root) {
    // Pad — two detuned saws through a lowpass wobbled by an LFO
    const padGain = ctx.createGain(); padGain.gain.value = 0.08
    const padFilter = ctx.createBiquadFilter(); padFilter.type = 'lowpass'; padFilter.frequency.value = 600; padFilter.Q.value = 1
    const p1 = ctx.createOscillator(); const p2 = ctx.createOscillator()
    p1.type = 'sawtooth'; p2.type = 'sawtooth'
    p1.frequency.value = root; p2.frequency.value = root * 1.003
    const lfo = ctx.createOscillator(); const lfoG = ctx.createGain()
    lfo.type = 'sine'; lfo.frequency.value = 0.15; lfoG.gain.value = 300
    lfo.connect(lfoG); lfoG.connect(padFilter.frequency); lfo.start()
    p1.connect(padFilter); p2.connect(padFilter); padFilter.connect(padGain); padGain.connect(dest)
    p1.start(); p2.start()
    // Bass — continuous saw with portamento, lowpass accent
    const bassGain = ctx.createGain(); bassGain.gain.value = 0
    const bassFilter = ctx.createBiquadFilter(); bassFilter.type = 'lowpass'; bassFilter.frequency.value = 400; bassFilter.Q.value = 3
    const bassOsc = ctx.createOscillator(); bassOsc.type = 'sawtooth'; bassOsc.frequency.value = root * 0.5
    bassOsc.connect(bassFilter); bassFilter.connect(bassGain); bassGain.connect(dest); bassOsc.start()
    return {
      stop() { try { p1.stop(); p2.stop(); lfo.stop(); bassOsc.stop() } catch { /* already stopped */ } padGain.disconnect(); bassGain.disconnect() },
      retune(r) { p1.frequency.setValueAtTime(r, ctx.currentTime); p2.frequency.setValueAtTime(r * 1.003, ctx.currentTime) },
      bassHit(time, freq, beatDuration) {
        bassOsc.frequency.setValueAtTime(bassOsc.frequency.value, time)
        bassOsc.frequency.exponentialRampToValueAtTime(freq, time + 0.06)
        bassGain.gain.setValueAtTime(0.22, time)
        bassGain.gain.linearRampToValueAtTime(0.1, time + beatDuration / 4)
        bassFilter.frequency.setValueAtTime(800, time)
        bassFilter.frequency.exponentialRampToValueAtTime(300, time + 0.15)
      },
      duck(time) {
        padGain.gain.setValueAtTime(0.08, time)
        padGain.gain.linearRampToValueAtTime(0.005, time + 0.01)
        padGain.gain.linearRampToValueAtTime(0.08, time + 0.35)
      },
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ORGANIC — ritual / hand-percussion kit. Frame drum, clap+rim, shaker, kalimba, breathy drone +
// plucked bass, with a swung lilt. Same scale/tempo as Electronic — the identity is all timbre+groove.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const ORGANIC: Palette = {
  name: 'Organic',
  swing: 0.14,
  kick(ctx, dest, time) {
    // Warm low membrane
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(140, time)
    o.frequency.exponentialRampToValueAtTime(50, time + 0.18)
    g.gain.setValueAtTime(0.8, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.3)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.32)
    // Woody "skin" resonance
    const o2 = ctx.createOscillator(); const g2 = ctx.createGain(); const bp = ctx.createBiquadFilter()
    o2.type = 'triangle'
    o2.frequency.setValueAtTime(200, time)
    o2.frequency.exponentialRampToValueAtTime(80, time + 0.14)
    bp.type = 'bandpass'; bp.frequency.value = 180; bp.Q.value = 3
    g2.gain.setValueAtTime(0.28, time)
    g2.gain.exponentialRampToValueAtTime(0.001, time + 0.18)
    o2.connect(bp); bp.connect(g2); g2.connect(dest); o2.start(time); o2.stop(time + 0.2)
    // Soft transient (not a bright click)
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.14, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.04)
    n.connect(lp); lp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.05)
  },
  snare(ctx, dest, time) {
    // Clap — three quick noise bursts through a bandpass
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 1.2
    bp.connect(dest)
    for (let i = 0; i < 3; i++) {
      const at = time + i * 0.011
      const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, at)
      g.gain.linearRampToValueAtTime(0.2, at + 0.002)
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.05)
      n.connect(g); g.connect(bp); n.start(at); n.stop(at + 0.06)
    }
    // Wood rim knock
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(440, time)
    o.frequency.exponentialRampToValueAtTime(300, time + 0.02)
    g.gain.setValueAtTime(0.16, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.03)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.04)
  },
  hihat(ctx, dest, time) {
    // Shaker — soft high-passed noise
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5000
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.055, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.045)
    n.connect(hp); hp.connect(g); g.connect(dest); n.start(time); n.stop(time + 0.05)
  },
  melody(ctx, dest, time, freq, gain) {
    const v = gain * 1.6   // a pluck peaks lower than a sustained tone — nudge up to sit at the same level
    // Fundamental — quick pluck
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'; o.frequency.value = freq
    g.gain.setValueAtTime(0.0001, time)
    g.gain.linearRampToValueAtTime(v, time + 0.005)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.4)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.42)
    // Metallic tine partial — the kalimba shimmer
    const o2 = ctx.createOscillator(); const g2 = ctx.createGain()
    o2.type = 'sine'; o2.frequency.value = freq * 3.01
    g2.gain.setValueAtTime(0.0001, time)
    g2.gain.linearRampToValueAtTime(v * 0.28, time + 0.004)
    g2.gain.exponentialRampToValueAtTime(0.001, time + 0.16)
    o2.connect(g2); g2.connect(dest); o2.start(time); o2.stop(time + 0.18)
  },
  startSustain(ctx, dest, root) {
    // Soft sine drone — root + fifth
    const g1 = ctx.createGain(); g1.gain.value = 0.05
    const d1 = ctx.createOscillator(); d1.type = 'sine'; d1.frequency.value = root
    d1.connect(g1); g1.connect(dest); d1.start()
    const g2 = ctx.createGain(); g2.gain.value = 0.03
    const d2 = ctx.createOscillator(); d2.type = 'sine'; d2.frequency.value = root * 1.5
    d2.connect(g2); g2.connect(dest); d2.start()
    // Breath — looped filtered noise with slow LFO movement
    const breath = ctx.createBufferSource(); breath.buffer = getNoise(ctx); breath.loop = true
    const bLp = ctx.createBiquadFilter(); bLp.type = 'lowpass'; bLp.frequency.value = 550; bLp.Q.value = 0.8
    const bG = ctx.createGain(); bG.gain.value = 0.018
    const lfo = ctx.createOscillator(); const lfoG = ctx.createGain()
    lfo.type = 'sine'; lfo.frequency.value = 0.12; lfoG.gain.value = 200
    lfo.connect(lfoG); lfoG.connect(bLp.frequency); lfo.start()
    breath.connect(bLp); bLp.connect(bG); bG.connect(dest); breath.start()
    // Plucked bass — triangle through a warm lowpass, re-enveloped per hit (no continuous drone)
    const bassGain = ctx.createGain(); bassGain.gain.value = 0
    const bassLp = ctx.createBiquadFilter(); bassLp.type = 'lowpass'; bassLp.frequency.value = 500; bassLp.Q.value = 1.5
    const bassOsc = ctx.createOscillator(); bassOsc.type = 'triangle'; bassOsc.frequency.value = root * 0.5
    bassOsc.connect(bassLp); bassLp.connect(bassGain); bassGain.connect(dest); bassOsc.start()
    return {
      stop() { try { d1.stop(); d2.stop(); breath.stop(); lfo.stop(); bassOsc.stop() } catch { /* already stopped */ } g1.disconnect(); g2.disconnect(); bG.disconnect(); bassGain.disconnect() },
      retune(r) { d1.frequency.setValueAtTime(r, ctx.currentTime); d2.frequency.setValueAtTime(r * 1.5, ctx.currentTime) },
      bassHit(time, freq, beatDuration) {
        bassOsc.frequency.setValueAtTime(freq, time)   // pluck — jump to the note, no portamento
        bassGain.gain.cancelScheduledValues(time)
        bassGain.gain.setValueAtTime(0.0001, time)
        bassGain.gain.linearRampToValueAtTime(0.28, time + 0.006)
        bassGain.gain.exponentialRampToValueAtTime(0.001, time + Math.min(0.5, beatDuration))
        bassLp.frequency.setValueAtTime(900, time)
        bassLp.frequency.exponentialRampToValueAtTime(350, time + 0.2)
      },
      duck(time) {
        // Gentle breath duck on the kick (not the hard electronic sidechain)
        bG.gain.setValueAtTime(0.018, time)
        bG.gain.linearRampToValueAtTime(0.008, time + 0.02)
        bG.gain.linearRampToValueAtTime(0.018, time + 0.3)
      },
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// GAMELAN — bronze resonance. Struck-metal metallophones with inharmonic partials + ombak shimmer,
// kendang drums, ceng-ceng cymbals, a low jegogan gong, and a shimmering bronze drone. Built from the
// SAME struck-metal timbre as the node-hit SFX, so the music and the sound effects become one
// resonating instrument. Same scale/tempo — identity is timbre + shimmer.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const GAMELAN: Palette = {
  name: 'Gamelan',
  swing: 0,   // interlocking kotekan is precise, not swung
  kick(ctx, dest, time) {
    // Kendang — warm low hand-drum body
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(150, time)
    o.frequency.exponentialRampToValueAtTime(55, time + 0.16)
    g.gain.setValueAtTime(0.7, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.22)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.24)
    // Metallic "tak" edge — a short resonant bronze tick
    const o2 = ctx.createOscillator(); const g2 = ctx.createGain(); const bp = ctx.createBiquadFilter()
    o2.type = 'triangle'; o2.frequency.value = 300
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 6
    g2.gain.setValueAtTime(0.18, time)
    g2.gain.exponentialRampToValueAtTime(0.001, time + 0.06)
    o2.connect(bp); bp.connect(g2); g2.connect(dest); o2.start(time); o2.stop(time + 0.08)
    // Soft transient
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.1, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.03)
    n.connect(lp); lp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.04)
  },
  snare(ctx, dest, time) {
    // Kendang slap body
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(420, time)
    o.frequency.exponentialRampToValueAtTime(170, time + 0.04)
    g.gain.setValueAtTime(0.3, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.08)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.1)
    // Kempyang — a bright little bronze bell
    strikeBronze(ctx, dest, time, 760, 0.13, 0.12, [1, 2.8])
    // Noise slap
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 1
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.1, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
    n.connect(bp); bp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.06)
  },
  hihat(ctx, dest, time) {
    // Ceng-ceng — small bright crash cymbals
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6500
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.05, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.045)
    n.connect(hp); hp.connect(g); g.connect(dest); n.start(time); n.stop(time + 0.05)
    // Faint metallic ring
    const o = ctx.createOscillator(); const og = ctx.createGain()
    o.type = 'sine'; o.frequency.value = 4300
    og.gain.setValueAtTime(0.02, time)
    og.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
    o.connect(og); og.connect(dest); o.start(time); o.stop(time + 0.06)
  },
  melody(ctx, dest, time, freq, gain) {
    // Gangsa — the shimmering bronze metallophone (the star)
    strikeBronze(ctx, dest, time, freq, gain * 2.0, 0.55)
    // Bright mallet attack transient
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(freq * 4, time)
    o.frequency.exponentialRampToValueAtTime(freq * 2, time + 0.02)
    g.gain.setValueAtTime(gain * 0.5, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.03)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.04)
  },
  startSustain(ctx, dest) {
    // NO continuous drone — gamelan's "sustain" is the RINGING of the struck bronze, not a held note.
    // The sustain layer only provides the per-hit low gong (jegogan).
    return {
      stop() { /* nothing continuous to stop */ },
      retune() { /* nothing continuous to retune */ },
      bassHit(time, freq, beatDuration) {
        // Jegogan / low gong — a deep struck bronze that rings
        strikeBronze(ctx, dest, time, freq, 0.34, Math.min(0.9, beatDuration * 1.6), [1, 2.76], 0.004)
      },
      duck() { /* no drone to duck */ },
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CHIPTUNE — 8-bit. Only pulse / triangle / noise, RAW (no lowpass smoothing) for the bright chip
// tone. Drums are faked from the tone+noise channels (NES had no drum samples): a pitch-swept kick,
// noise snare/hihat. The lead is a thin 12.5% pulse with vibrato + a fast octave/fifth arp shimmer
// (the classic "chord = fast arp"). Bass is a 25% pulse + sine sub. No held drone.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const CHIPTUNE: Palette = {
  name: 'Chiptune',
  swing: 0,
  kick(ctx, dest, time) {
    // Pitch-swept triangle — the classic chip kick
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(180, time)
    o.frequency.exponentialRampToValueAtTime(45, time + 0.05)
    g.gain.setValueAtTime(0.7, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.14)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.16)
    // Tiny noise click
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.15, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.015)
    n.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.02)
  },
  snare(ctx, dest, time) {
    // Noise burst
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.28, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.12)
    n.connect(hp); hp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.13)
    // Short square body
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'square'
    o.frequency.setValueAtTime(220, time)
    o.frequency.exponentialRampToValueAtTime(140, time + 0.05)
    g.gain.setValueAtTime(0.14, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.08)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.1)
  },
  hihat(ctx, dest, time) {
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 8000
    const g = ctx.createGain(); g.gain.setValueAtTime(0.09, time); g.gain.exponentialRampToValueAtTime(0.001, time + 0.025)
    n.connect(hp); hp.connect(g); g.connect(dest); n.start(time); n.stop(time + 0.03)
  },
  melody(ctx, dest, time, freq, gain) {
    // Square lead, GENTLED — a lowpass rolls off the harsh upper harmonics + a soft attack.
    const o = ctx.createOscillator(); o.type = 'square'
    o.frequency.setValueAtTime(freq, time)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1900; lp.Q.value = 0.6
    const g = ctx.createGain()
    const v = gain * 1.6
    g.gain.setValueAtTime(0.0001, time)
    g.gain.linearRampToValueAtTime(v, time + 0.014)   // softer attack (was a hard 0.005)
    g.gain.setValueAtTime(v, time + 0.14)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.24)
    // Subtle vibrato that eases in AFTER the attack
    const lfo = ctx.createOscillator(); const lfoG = ctx.createGain()
    lfo.type = 'sine'; lfo.frequency.value = 5
    lfoG.gain.setValueAtTime(0, time)
    lfoG.gain.linearRampToValueAtTime(freq * 0.005, time + 0.14)
    lfo.connect(lfoG); lfoG.connect(o.frequency); lfo.start(time); lfo.stop(time + 0.26)
    o.connect(lp); lp.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.26)
  },
  startSustain(ctx, dest) {
    // No held drone — energy is bass + arp + drums. Sustain only provides the per-hit pulse bass.
    return {
      stop() { /* nothing continuous */ },
      retune() { /* nothing continuous */ },
      bassHit(time, freq, beatDuration) {
        const dur = Math.min(0.35, beatDuration)
        // 25% pulse body (raw) + a sine sub for weight
        const o = ctx.createOscillator(); o.setPeriodicWave(pulseWave(ctx, 0.25)); o.frequency.setValueAtTime(freq, time)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, time)
        g.gain.linearRampToValueAtTime(0.26, time + 0.005)
        g.gain.exponentialRampToValueAtTime(0.001, time + dur)
        o.connect(g); g.connect(dest); o.start(time); o.stop(time + dur + 0.02)
        const s = ctx.createOscillator(); s.type = 'sine'; s.frequency.setValueAtTime(freq * 0.5, time)
        const sg = ctx.createGain(); sg.gain.setValueAtTime(0.18, time); sg.gain.exponentialRampToValueAtTime(0.001, time + dur)
        s.connect(sg); sg.connect(dest); s.start(time); s.stop(time + dur + 0.02)
      },
      duck() { /* no drone to duck */ },
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// LO-FI — warm, dusty, swung. The OPPOSITE of Chiptune: everything lowpassed (rolled-off highs),
// slight detune for chorus warmth, soft muffled drums, a warm Rhodes electric-piano melody, round
// bass, and a vinyl-crackle bed. Heavy swing for the laid-back head-nod.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const LOFI: Palette = {
  name: 'Lo-Fi',
  swing: 0.2,
  kick(ctx, dest, time) {
    // Soft round thump — dusty (lowpassed), minimal click
    const o = ctx.createOscillator(); const g = ctx.createGain(); const lp = ctx.createBiquadFilter()
    o.type = 'sine'
    o.frequency.setValueAtTime(120, time)
    o.frequency.exponentialRampToValueAtTime(48, time + 0.1)
    lp.type = 'lowpass'; lp.frequency.value = 700
    g.gain.setValueAtTime(0.7, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.22)
    o.connect(lp); lp.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.24)
  },
  snare(ctx, dest, time) {
    // Muffled noise (rolled off — not bright)
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.2, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.13)
    n.connect(lp); lp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.14)
    // Soft tonal body
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(180, time)
    o.frequency.exponentialRampToValueAtTime(120, time + 0.05)
    g.gain.setValueAtTime(0.13, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.09)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.1)
  },
  hihat(ctx, dest, time) {
    // Soft muffled tick
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 5500; bp.Q.value = 1.1
    const g = ctx.createGain(); g.gain.setValueAtTime(0.045, time); g.gain.exponentialRampToValueAtTime(0.001, time + 0.03)
    n.connect(bp); bp.connect(g); g.connect(dest); n.start(time); n.stop(time + 0.04)
  },
  melody(ctx, dest, time, freq, gain) {
    // Rhodes electric piano — detuned sines (chorus) through a lowpass + a bell "tine" attack + a
    // gentle amplitude tremolo. Warm, mellow, long-ish decay.
    const v = gain * 1.9
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800; lp.Q.value = 0.7
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, time)
    env.gain.linearRampToValueAtTime(v, time + 0.01)
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.6)
    const trem = ctx.createGain(); trem.gain.value = 1
    const tlfo = ctx.createOscillator(); const tlfoG = ctx.createGain()
    tlfo.type = 'sine'; tlfo.frequency.value = 4.5; tlfoG.gain.value = 0.08
    tlfo.connect(tlfoG); tlfoG.connect(trem.gain); tlfo.start(time); tlfo.stop(time + 0.62)
    lp.connect(env); env.connect(trem); trem.connect(dest)
    for (const det of [1, 1.004]) {   // chorus twin
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq * det
      o.connect(lp); o.start(time); o.stop(time + 0.62)
    }
    // Bell "tine" attack
    const t2 = ctx.createOscillator(); const tg = ctx.createGain()
    t2.type = 'sine'; t2.frequency.value = freq * 4
    tg.gain.setValueAtTime(v * 0.35, time); tg.gain.exponentialRampToValueAtTime(0.001, time + 0.12)
    t2.connect(tg); tg.connect(dest); t2.start(time); t2.stop(time + 0.14)
  },
  startSustain(ctx, dest) {
    // No bed — the sustain only provides the per-hit warm bass.
    return {
      stop() { /* nothing continuous */ },
      retune() { /* nothing continuous */ },
      bassHit(time, freq, beatDuration) {
        const dur = Math.min(0.5, beatDuration * 1.2)
        // Warm round triangle bass (lowpassed) + a sine sub for weight
        const o = ctx.createOscillator(); const lp = ctx.createBiquadFilter(); const g = ctx.createGain()
        o.type = 'triangle'; o.frequency.setValueAtTime(freq, time)
        lp.type = 'lowpass'; lp.frequency.value = 500
        g.gain.setValueAtTime(0.0001, time)
        g.gain.linearRampToValueAtTime(0.32, time + 0.02)
        g.gain.exponentialRampToValueAtTime(0.001, time + dur)
        o.connect(lp); lp.connect(g); g.connect(dest); o.start(time); o.stop(time + dur + 0.02)
        const s = ctx.createOscillator(); const sg = ctx.createGain()
        s.type = 'sine'; s.frequency.setValueAtTime(freq * 0.5, time)
        sg.gain.setValueAtTime(0.2, time); sg.gain.exponentialRampToValueAtTime(0.001, time + dur)
        s.connect(sg); sg.connect(dest); s.start(time); s.stop(time + dur + 0.02)
      },
      duck() { /* crackle bed doesn't duck */ },
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// CARTOON — goofy caper. All soft plucky/warm voices (no harshness): pizzicato lead, comedic tuba
// bass with an upward scoop, a round bass-drum, hollow woodblock snare, brush hats. Bouncy swing.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const CARTOON: Palette = {
  name: 'Cartoon',
  swing: 0.12,
  kick(ctx, dest, time) {
    // Soft round bass drum
    const o = ctx.createOscillator(); const g = ctx.createGain(); const lp = ctx.createBiquadFilter()
    o.type = 'sine'
    o.frequency.setValueAtTime(140, time)
    o.frequency.exponentialRampToValueAtTime(48, time + 0.09)
    lp.type = 'lowpass'; lp.frequency.value = 900
    g.gain.setValueAtTime(0.7, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.2)
    o.connect(lp); lp.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.22)
  },
  snare(ctx, dest, time) {
    // Woodblock — hollow pitched knock
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'triangle'
    o.frequency.setValueAtTime(800, time)
    o.frequency.exponentialRampToValueAtTime(560, time + 0.02)
    g.gain.setValueAtTime(0.3, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.06)
    // Higher hollow partial
    const o2 = ctx.createOscillator(); const g2 = ctx.createGain()
    o2.type = 'sine'; o2.frequency.value = 1250
    g2.gain.setValueAtTime(0.12, time)
    g2.gain.exponentialRampToValueAtTime(0.001, time + 0.035)
    o2.connect(g2); g2.connect(dest); o2.start(time); o2.stop(time + 0.045)
    // Tiny "tok" click
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 3
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.1, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.02)
    n.connect(bp); bp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.025)
  },
  hihat(ctx, dest, time) {
    // Soft brush tick
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 5000; bp.Q.value = 1
    const g = ctx.createGain(); g.gain.setValueAtTime(0.04, time); g.gain.exponentialRampToValueAtTime(0.001, time + 0.025)
    n.connect(bp); bp.connect(g); g.connect(dest); n.start(time); n.stop(time + 0.03)
  },
  melody(ctx, dest, time, freq, gain) {
    // Muted-trumpet WAH — the cartoon voice: a saw through a resonant lowpass that opens ("wa") then
    // closes ("ah"), with a pitch SCOOP up into each note. Warm (capped ~1900Hz), not harsh.
    const v = gain * 1.7
    const o = ctx.createOscillator(); o.type = 'sawtooth'
    o.frequency.setValueAtTime(freq * 0.8, time)                    // scoop up into the note
    o.frequency.exponentialRampToValueAtTime(freq, time + 0.05)
    const wah = ctx.createBiquadFilter(); wah.type = 'lowpass'; wah.Q.value = 3
    wah.frequency.setValueAtTime(480, time)
    wah.frequency.exponentialRampToValueAtTime(1900, time + 0.08)   // open — "wa"
    wah.frequency.exponentialRampToValueAtTime(620, time + 0.3)     // close — "ah"
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, time)
    g.gain.linearRampToValueAtTime(v, time + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.34)
    o.connect(wah); wah.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.36)
  },
  startSustain(ctx, dest) {
    // No drone — the sustain only provides the per-hit comedic tuba bass.
    return {
      stop() { /* nothing continuous */ },
      retune() { /* nothing continuous */ },
      bassHit(time, freq, beatDuration) {
        const dur = Math.min(0.4, beatDuration)
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'
        lp.frequency.setValueAtTime(300, time)
        lp.frequency.exponentialRampToValueAtTime(560, time + 0.05)   // "woomp" — filter opens on attack
        lp.frequency.exponentialRampToValueAtTime(360, time + dur)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, time)
        g.gain.linearRampToValueAtTime(0.34, time + 0.03)    // soft round attack
        g.gain.exponentialRampToValueAtTime(0.001, time + dur)
        lp.connect(g); g.connect(dest)
        for (const type of ['sine', 'triangle'] as OscillatorType[]) {
          const o = ctx.createOscillator(); o.type = type
          o.frequency.setValueAtTime(freq * 0.9, time)       // bigger comedic scoop into the "oom"
          o.frequency.exponentialRampToValueAtTime(freq, time + 0.05)
          o.connect(lp); o.start(time); o.stop(time + dur + 0.02)
        }
      },
      duck() { /* no drone to duck */ },
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// JAZZ — smoky trio. Warm vibraphone (with the motor tremolo), an upright walking bass with a woody
// finger pluck + slide, brushed drums, a ride ping. Heavy swing. All mellow — class, never harsh.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const JAZZ: Palette = {
  name: 'Jazz',
  swing: 0.24,
  kick(ctx, dest, time) {
    // Soft upright thump — felt, not punchy
    const o = ctx.createOscillator(); const g = ctx.createGain(); const lp = ctx.createBiquadFilter()
    o.type = 'sine'
    o.frequency.setValueAtTime(110, time)
    o.frequency.exponentialRampToValueAtTime(45, time + 0.09)
    lp.type = 'lowpass'; lp.frequency.value = 500
    g.gain.setValueAtTime(0.55, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.18)
    o.connect(lp); lp.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.2)
  },
  snare(ctx, dest, time) {
    // Brush swish — soft filtered noise with a swish sweep (not a crack)
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.8
    bp.frequency.setValueAtTime(2000, time)
    bp.frequency.exponentialRampToValueAtTime(3200, time + 0.1)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, time)
    g.gain.linearRampToValueAtTime(0.13, time + 0.012)   // soft attack = "shh", not "tsk"
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.14)
    n.connect(bp); bp.connect(g); g.connect(dest); n.start(time); n.stop(time + 0.15)
    // Soft body
    const o = ctx.createOscillator(); const og = ctx.createGain()
    o.type = 'triangle'; o.frequency.setValueAtTime(200, time); o.frequency.exponentialRampToValueAtTime(130, time + 0.05)
    og.gain.setValueAtTime(0.07, time); og.gain.exponentialRampToValueAtTime(0.001, time + 0.07)
    o.connect(og); og.connect(dest); o.start(time); o.stop(time + 0.08)
  },
  hihat(ctx, dest, time) {
    // Ride ping — warm metallic shimmer with a little sustain
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000
    const g = ctx.createGain(); g.gain.setValueAtTime(0.04, time); g.gain.exponentialRampToValueAtTime(0.001, time + 0.1)
    n.connect(hp); hp.connect(g); g.connect(dest); n.start(time); n.stop(time + 0.11)
    const o = ctx.createOscillator(); const og = ctx.createGain()
    o.type = 'sine'; o.frequency.value = 5200
    og.gain.setValueAtTime(0.02, time); og.gain.exponentialRampToValueAtTime(0.001, time + 0.08)
    o.connect(og); og.connect(dest); o.start(time); o.stop(time + 0.09)
  },
  melody(ctx, dest, time, freq, gain) {
    // Vibraphone — warm mallet + a metallic shimmer partial + the motor tremolo
    const v = gain * 2.0
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.Q.value = 0.7
    const env = ctx.createGain()
    env.gain.setValueAtTime(0.0001, time)
    env.gain.linearRampToValueAtTime(v, time + 0.006)
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.5)
    const trem = ctx.createGain(); trem.gain.value = 1
    const tlfo = ctx.createOscillator(); const tlfoG = ctx.createGain()
    tlfo.type = 'sine'; tlfo.frequency.value = 5; tlfoG.gain.value = 0.12   // the vibes motor (amplitude)
    tlfo.connect(tlfoG); tlfoG.connect(trem.gain); tlfo.start(time); tlfo.stop(time + 0.52)
    lp.connect(env); env.connect(trem); trem.connect(dest)
    const o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = freq
    o1.connect(lp); o1.start(time); o1.stop(time + 0.52)
    // Metallic shimmer partial (the bar) — separate, shorter env
    const o2 = ctx.createOscillator(); const o2g = ctx.createGain()
    o2.type = 'sine'; o2.frequency.value = freq * 4
    o2g.gain.setValueAtTime(v * 0.3, time); o2g.gain.exponentialRampToValueAtTime(0.001, time + 0.18)
    o2.connect(o2g); o2g.connect(dest); o2.start(time); o2.stop(time + 0.2)
  },
  startSustain(ctx, dest) {
    // No drone — the sustain provides the per-hit upright walking bass.
    return {
      stop() { /* nothing continuous */ },
      retune() { /* nothing continuous */ },
      bassHit(time, freq, beatDuration) {
        const dur = Math.min(0.5, beatDuration)
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, time)
        g.gain.linearRampToValueAtTime(0.34, time + 0.012)   // plucky
        g.gain.exponentialRampToValueAtTime(0.001, time + dur)
        lp.connect(g); g.connect(dest)
        for (const type of ['sine', 'triangle'] as OscillatorType[]) {
          const o = ctx.createOscillator(); o.type = type
          o.frequency.setValueAtTime(freq * 0.98, time)      // slight slide-in (upright slur)
          o.frequency.exponentialRampToValueAtTime(freq, time + 0.03)
          o.connect(lp); o.start(time); o.stop(time + dur + 0.02)
        }
        // Woody "finger" transient
        const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
        const nlp = ctx.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = 1500
        const ng = ctx.createGain(); ng.gain.setValueAtTime(0.08, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.02)
        n.connect(nlp); nlp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.025)
      },
      duck() { /* no drone to duck */ },
    }
  },
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// KITCHEN — a one-man cookware band. Every voice is a struck/resonant kitchen object: a stockpot
// kick, a frying-pan snare, fork-on-glass hats, a singing wine-glass lead, and a dull Tupperware
// bass, over a faint fridge hum (a kitchen is never truly silent). Built from the SAME strikeBronze
// inharmonic-resonator engine as Gamelan — just different partial ratios + decays per object.
// ══════════════════════════════════════════════════════════════════════════════════════════════
export const KITCHEN: Palette = {
  name: 'Kitchen',
  swing: 0.08,   // a loose, human clatter
  kick(ctx, dest, time) {
    // Stockpot bonk — deep sine body that drops, plus a short inharmonic aluminium-pot ring
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(150, time)
    o.frequency.exponentialRampToValueAtTime(58, time + 0.09)
    g.gain.setValueAtTime(0.8, time)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.22)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.24)
    // Metallic pot "bonng" — inharmonic partials, short decay
    strikeBronze(ctx, dest, time, 190, 0.16, 0.18, [1, 2.4, 4.1], 0.004)
    // Soft hand/mallet transient (not a bright click)
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.12, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.03)
    n.connect(lp); lp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.04)
  },
  snare(ctx, dest, time) {
    // Frying-pan slap — a bright ringing metallic clang + the noisy smack on the pan
    strikeBronze(ctx, dest, time, 520, 0.2, 0.2, [1, 3.2, 5.8, 8.1], 0.005)
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3000; bp.Q.value = 0.8
    const ng = ctx.createGain()
    ng.gain.setValueAtTime(0.0001, time)
    ng.gain.linearRampToValueAtTime(0.22, time + 0.002)
    ng.gain.exponentialRampToValueAtTime(0.001, time + 0.09)
    n.connect(bp); bp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.1)
  },
  hihat(ctx, dest, time) {
    // Fork ting on a glass — a very short, bright metallic tick (two high partials + a metal click)
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'; o.frequency.value = 7200
    g.gain.setValueAtTime(0.05, time); g.gain.exponentialRampToValueAtTime(0.001, time + 0.03)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.035)
    const o2 = ctx.createOscillator(); const g2 = ctx.createGain()
    o2.type = 'sine'; o2.frequency.value = 9600
    g2.gain.setValueAtTime(0.03, time); g2.gain.exponentialRampToValueAtTime(0.001, time + 0.02)
    o2.connect(g2); g2.connect(dest); o2.start(time); o2.stop(time + 0.025)
    const n = ctx.createBufferSource(); n.buffer = getNoise(ctx)
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7000
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.04, time); ng.gain.exponentialRampToValueAtTime(0.001, time + 0.012)
    n.connect(hp); hp.connect(ng); ng.connect(dest); n.start(time); n.stop(time + 0.015)
  },
  melody(ctx, dest, time, freq, gain) {
    // Singing wine-glass rim — a nearly pure tone that swells in, a high shimmer partial, and a
    // faintly detuned twin for the slow beating you hear from a rubbed glass. Long ring.
    const v = gain * 1.7
    const o = ctx.createOscillator(); const g = ctx.createGain()
    o.type = 'sine'; o.frequency.value = freq
    g.gain.setValueAtTime(0.0001, time)
    g.gain.linearRampToValueAtTime(v, time + 0.02)
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.7)
    o.connect(g); g.connect(dest); o.start(time); o.stop(time + 0.72)
    const o2 = ctx.createOscillator(); const g2 = ctx.createGain()
    o2.type = 'sine'; o2.frequency.value = freq * 4.2
    g2.gain.setValueAtTime(0.0001, time)
    g2.gain.linearRampToValueAtTime(v * 0.22, time + 0.01)
    g2.gain.exponentialRampToValueAtTime(0.001, time + 0.4)
    o2.connect(g2); g2.connect(dest); o2.start(time); o2.stop(time + 0.42)
    const o3 = ctx.createOscillator(); const g3 = ctx.createGain()
    o3.type = 'sine'; o3.frequency.value = freq * 1.006
    g3.gain.setValueAtTime(0.0001, time)
    g3.gain.linearRampToValueAtTime(v * 0.5, time + 0.02)
    g3.gain.exponentialRampToValueAtTime(0.001, time + 0.6)
    o3.connect(g3); g3.connect(dest); o3.start(time); o3.stop(time + 0.62)
  },
  startSustain(ctx, dest, root) {
    // Faint fridge hum bed (low sine + a sub rumble) + the per-hit Tupperware bass.
    const humG = ctx.createGain(); humG.gain.value = 0.022
    const humLp = ctx.createBiquadFilter(); humLp.type = 'lowpass'; humLp.frequency.value = 200
    const hum = ctx.createOscillator(); hum.type = 'sine'; hum.frequency.value = root * 0.5
    const rumble = ctx.createOscillator(); rumble.type = 'triangle'; rumble.frequency.value = root * 0.25
    hum.connect(humLp); rumble.connect(humLp); humLp.connect(humG); humG.connect(dest); hum.start(); rumble.start()
    // Tupperware bass — dull, damped, plasticky low resonance (short, lowpassed, no ring)
    const bassGain = ctx.createGain(); bassGain.gain.value = 0
    const bassLp = ctx.createBiquadFilter(); bassLp.type = 'lowpass'; bassLp.frequency.value = 380; bassLp.Q.value = 2
    const bassOsc = ctx.createOscillator(); bassOsc.type = 'triangle'; bassOsc.frequency.value = root * 0.5
    bassOsc.connect(bassLp); bassLp.connect(bassGain); bassGain.connect(dest); bassOsc.start()
    return {
      stop() { try { hum.stop(); rumble.stop(); bassOsc.stop() } catch { /* already stopped */ } humG.disconnect(); bassGain.disconnect() },
      retune(r) { hum.frequency.setValueAtTime(r * 0.5, ctx.currentTime); rumble.frequency.setValueAtTime(r * 0.25, ctx.currentTime) },
      bassHit(time, freq, beatDuration) {
        bassOsc.frequency.setValueAtTime(freq, time)   // plastic "bomp" — jump to the note, no portamento
        bassGain.gain.cancelScheduledValues(time)
        bassGain.gain.setValueAtTime(0.0001, time)
        bassGain.gain.linearRampToValueAtTime(0.3, time + 0.008)
        bassGain.gain.exponentialRampToValueAtTime(0.001, time + Math.min(0.28, beatDuration))
        bassLp.frequency.setValueAtTime(600, time)
        bassLp.frequency.exponentialRampToValueAtTime(300, time + 0.12)
      },
      duck(time) {
        // dip the fridge hum on the kick so the pot bonk cuts through
        humG.gain.setValueAtTime(0.022, time)
        humG.gain.linearRampToValueAtTime(0.006, time + 0.02)
        humG.gain.linearRampToValueAtTime(0.022, time + 0.3)
      },
    }
  },
}

export const PALETTES: Palette[] = [ELECTRONIC, ORGANIC, GAMELAN, CHIPTUNE, LOFI, CARTOON, JAZZ, KITCHEN]

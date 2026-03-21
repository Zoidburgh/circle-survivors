// Musical synth voices for each enemy role
// All sounds go through the provided destination node (reverb input)

let ctx: AudioContext
let dest: AudioNode

export function initSynth(audioCtx: AudioContext, destination: AudioNode): void {
  ctx = audioCtx
  dest = destination
}

// ── ADSR helper ──
function applyADSR(
  gain: GainNode,
  volume: number,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
  duration: number
): void {
  const t = ctx.currentTime
  gain.gain.setValueAtTime(0.001, t)
  gain.gain.linearRampToValueAtTime(volume, t + attack)
  gain.gain.linearRampToValueAtTime(volume * sustain, t + attack + decay)
  gain.gain.setValueAtTime(volume * sustain, t + duration)
  gain.gain.linearRampToValueAtTime(0.001, t + duration + release)
}

// ── Player kick drum ──
export function playKick(): void {
  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(150, t)
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.12)
  gain.gain.setValueAtTime(0.7, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
  osc.connect(gain)
  gain.connect(dest)
  osc.start(t)
  osc.stop(t + 0.2)

  // Click transient
  const click = ctx.createOscillator()
  const clickGain = ctx.createGain()
  click.type = 'square'
  click.frequency.value = 300
  clickGain.gain.setValueAtTime(0.3, t)
  clickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.015)
  click.connect(clickGain)
  clickGain.connect(dest)
  click.start(t)
  click.stop(t + 0.015)
}

// ── Whole note: Bass ──
export function playBass(freq: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.value = freq
  applyADSR(gain, 0.9, 0.01, 0.15, 0.7, 0.3, 0.4)
  osc.connect(gain)
  gain.connect(dest)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.9)
}

// ── Half note: Chord stab ──
export function playChord(freqs: [number, number]): void {
  const gain = ctx.createGain()
  applyADSR(gain, 0.25, 0.005, 0.1, 0.3, 0.2, 0.25)
  gain.connect(dest)

  for (const freq of freqs) {
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    osc1.type = 'sawtooth'
    osc2.type = 'sawtooth'
    osc1.frequency.value = freq
    osc2.frequency.value = freq * 1.005 // slight detune for thickness
    osc1.connect(gain)
    osc2.connect(gain)
    osc1.start(ctx.currentTime)
    osc2.start(ctx.currentTime)
    osc1.stop(ctx.currentTime + 0.45)
    osc2.stop(ctx.currentTime + 0.45)
  }
}

// ── Quarter note: Melody ──
export function playMelody(freq: number): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'square'
  osc.frequency.value = freq

  // Gentle low-pass via gain shaping
  applyADSR(gain, 0.3, 0.005, 0.08, 0.4, 0.15, 0.2)
  osc.connect(gain)
  gain.connect(dest)
  osc.start(ctx.currentTime)
  osc.stop(ctx.currentTime + 0.35)
}

// ── Eighth note: Plucky high note from scale ──
export function playPluck(freq: number): void {
  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'triangle'
  osc.frequency.value = freq * 2 // one octave up from melody range
  applyADSR(gain, 0.45, 0.003, 0.04, 0.15, 0.1, 0.08)
  osc.connect(gain)
  gain.connect(dest)
  osc.start(t)
  osc.stop(t + 0.15)
}

// ── Sixteenth note: Soft tap — very short quiet note ──
export function playTap(freq: number): void {
  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq * 4 // two octaves up, very high and soft
  gain.gain.setValueAtTime(0.3, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06)
  osc.connect(gain)
  gain.connect(dest)
  osc.start(t)
  osc.stop(t + 0.04)
}

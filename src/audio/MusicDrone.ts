// Background drone — quiet sustained root + fifth
// Gives harmonic context so enemy notes don't feel random

let ctx: AudioContext
let dest: AudioNode
let rootOsc: OscillatorNode | null = null
let fifthOsc: OscillatorNode | null = null
let droneGain: GainNode | null = null
let lfo: OscillatorNode | null = null

export function initDrone(audioCtx: AudioContext, destination: AudioNode): void {
  ctx = audioCtx
  dest = destination
}

export function startDrone(rootFreq: number, fifthFreq: number): void {
  stopDrone()

  droneGain = ctx.createGain()
  droneGain.gain.value = 0.0
  droneGain.connect(dest)

  // Root
  rootOsc = ctx.createOscillator()
  rootOsc.type = 'sine'
  rootOsc.frequency.value = rootFreq
  rootOsc.connect(droneGain)
  rootOsc.start()

  // Fifth
  fifthOsc = ctx.createOscillator()
  fifthOsc.type = 'sine'
  fifthOsc.frequency.value = fifthFreq
  fifthOsc.connect(droneGain)
  fifthOsc.start()

  // Breathing LFO on volume
  lfo = ctx.createOscillator()
  lfo.type = 'sine'
  lfo.frequency.value = 0.15 // slow breathing
  const lfoGain = ctx.createGain()
  lfoGain.gain.value = 0.02 // subtle volume wobble
  lfo.connect(lfoGain)
  lfoGain.connect(droneGain.gain)
  lfo.start()

  // Fade in
  droneGain.gain.setValueAtTime(0.0, ctx.currentTime)
  droneGain.gain.linearRampToValueAtTime(0.07, ctx.currentTime + 1.5)
}

export function stopDrone(): void {
  if (rootOsc) { rootOsc.stop(); rootOsc = null }
  if (fifthOsc) { fifthOsc.stop(); fifthOsc = null }
  if (lfo) { lfo.stop(); lfo = null }
  if (droneGain) { droneGain.disconnect(); droneGain = null }
}

/** Smoothly transition drone to a new key */
export function transitionDrone(rootFreq: number, fifthFreq: number): void {
  if (!rootOsc || !fifthOsc) {
    startDrone(rootFreq, fifthFreq)
    return
  }
  const t = ctx.currentTime
  rootOsc.frequency.setValueAtTime(rootOsc.frequency.value, t)
  rootOsc.frequency.linearRampToValueAtTime(rootFreq, t + 0.8)
  fifthOsc.frequency.setValueAtTime(fifthOsc.frequency.value, t)
  fifthOsc.frequency.linearRampToValueAtTime(fifthFreq, t + 0.8)
}

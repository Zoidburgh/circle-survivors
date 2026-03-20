let ctx: AudioContext | null = null
let master: GainNode
let compressor: DynamicsCompressorNode

// Limit simultaneous enemy sounds
let lastEnemyTickTime = 0
const ENEMY_TICK_MIN_INTERVAL = 0.05 // max ~20 enemy ticks per second

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
  }
  if (ctx.state === 'suspended') {
    ctx.resume()
  }
  return ctx
}

// Resume on first user gesture
export function init(): void {
  const resume = () => {
    ensureContext()
    window.removeEventListener('click', resume)
    window.removeEventListener('keydown', resume)
  }
  window.addEventListener('click', resume)
  window.addEventListener('keydown', resume)
}

/** Player ring misses — hollow thud */
export function playMiss(): void {
  const c = ensureContext()
  const osc = c.createOscillator()
  const noise = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'triangle'
  osc.frequency.setValueAtTime(200, c.currentTime)
  osc.frequency.exponentialRampToValueAtTime(50, c.currentTime + 0.2)
  noise.type = 'sawtooth'
  noise.frequency.value = 80
  gain.gain.setValueAtTime(0.7, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.2)
  osc.connect(gain)
  noise.connect(gain)
  gain.connect(master)
  osc.start(c.currentTime)
  noise.start(c.currentTime)
  osc.stop(c.currentTime + 0.2)
  noise.stop(c.currentTime + 0.2)
}

/** Player ring hits enemy — crunchy impact */
export function playHit(): void {
  const c = ensureContext()
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const osc3 = c.createOscillator()
  const gain = c.createGain()
  // Sharp attack
  osc1.type = 'square'
  osc1.frequency.setValueAtTime(600, c.currentTime)
  osc1.frequency.exponentialRampToValueAtTime(200, c.currentTime + 0.05)
  // Body
  osc2.type = 'sine'
  osc2.frequency.value = 440
  // Sub punch
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

/** Enemy killed — rising pitch burst */
export function playKill(): void {
  const c = ensureContext()
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(440, c.currentTime)
  osc.frequency.exponentialRampToValueAtTime(880, c.currentTime + 0.25)
  gain.gain.setValueAtTime(0.8, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.3)
  osc.connect(gain)
  gain.connect(master)
  osc.start(c.currentTime)
  osc.stop(c.currentTime + 0.3)
}

/** Player takes damage — loud low thud */
export function playPlayerHit(): void {
  const c = ensureContext()
  // Layer two oscillators for a heavier impact
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

/** Player ring beat pulse — always audible snap */
export function playBeatTick(): void {
  const c = ensureContext()
  const osc1 = c.createOscillator()
  const osc2 = c.createOscillator()
  const gain = c.createGain()
  osc1.type = 'square'
  osc1.frequency.value = 180
  osc2.type = 'sine'
  osc2.frequency.setValueAtTime(400, c.currentTime)
  osc2.frequency.exponentialRampToValueAtTime(120, c.currentTime + 0.12)
  gain.gain.setValueAtTime(0.9, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.18)
  osc1.connect(gain)
  osc2.connect(gain)
  gain.connect(master)
  osc1.start(c.currentTime)
  osc2.start(c.currentTime)
  osc1.stop(c.currentTime + 0.18)
  osc2.stop(c.currentTime + 0.18)
}

/** Dash — quick airy whoosh */
export function playDash(): void {
  const c = ensureContext()
  // White noise burst via detuned oscillators
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

/** Enemy ring beat pulse — distinct tone per enemy, throttled */
export function playEnemyBeatTick(frequency = 110): void {
  const c = ensureContext()
  // Skip if another enemy tick just played
  if (c.currentTime - lastEnemyTickTime < ENEMY_TICK_MIN_INTERVAL) return
  lastEnemyTickTime = c.currentTime
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'square'
  osc.frequency.value = frequency
  gain.gain.setValueAtTime(0.55, c.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.15)
  osc.connect(gain)
  gain.connect(master)
  osc.start(c.currentTime)
  osc.stop(c.currentTime + 0.15)
}

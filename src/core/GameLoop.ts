import { FIXED_DT } from '../utils/constants.ts'
import { recordTickJs } from '../render/Renderer.ts'

export type UpdateFn = (dt: number) => void
export type RenderFn = (alpha: number) => void
export type PreFrameFn = (dtMs: number) => void

let lastTime = 0
let accumulator = 0
let updateFn: UpdateFn
let renderFn: RenderFn
let preFrameFn: PreFrameFn | undefined
let running = false

function tick(timestamp: number): void {
  if (!running) return

  const tickT0 = performance.now()   // measure TOTAL JS for this whole frame (all of update+render)

  const elapsed = Math.min(timestamp - lastTime, 100) // cap to avoid spiral of death
  lastTime = timestamp
  accumulator += elapsed

  // Advance the node clock + capture the beat ONCE here, before the sim, so hit-detection (in the
  // updates below) and the render sample time-derived node positions at the exact same instant.
  preFrameFn?.(elapsed)

  const fixedDt = FIXED_DT / 1000 // convert to seconds
  while (accumulator >= FIXED_DT) {
    updateFn(fixedDt)
    accumulator -= FIXED_DT
  }

  renderFn(accumulator / FIXED_DT)
  // Total JS time for the frame. Everything not in here (FRAME_REAL - TICK_JS) is GPU paint +
  // compositing + vsync — not on the JS thread, so unmeasurable here by design.
  recordTickJs(performance.now() - tickT0)
  requestAnimationFrame(tick)
}

export function start(update: UpdateFn, render: RenderFn, preFrame?: PreFrameFn): void {
  updateFn = update
  renderFn = render
  preFrameFn = preFrame
  running = true
  requestAnimationFrame(t => {
    lastTime = t
    tick(t)
  })
}

export function stop(): void {
  running = false
}

import { FIXED_DT } from '../utils/constants.ts'

export type UpdateFn = (dt: number) => void
export type RenderFn = (alpha: number) => void

let lastTime = 0
let accumulator = 0
let updateFn: UpdateFn
let renderFn: RenderFn
let running = false

function tick(timestamp: number): void {
  if (!running) return

  const elapsed = Math.min(timestamp - lastTime, 100) // cap to avoid spiral of death
  lastTime = timestamp
  accumulator += elapsed

  const fixedDt = FIXED_DT / 1000 // convert to seconds
  while (accumulator >= FIXED_DT) {
    updateFn(fixedDt)
    accumulator -= FIXED_DT
  }

  renderFn(accumulator / FIXED_DT)
  requestAnimationFrame(tick)
}

export function start(update: UpdateFn, render: RenderFn): void {
  updateFn = update
  renderFn = render
  running = true
  requestAnimationFrame(t => {
    lastTime = t
    tick(t)
  })
}

export function stop(): void {
  running = false
}

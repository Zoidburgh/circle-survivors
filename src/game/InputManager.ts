import type { Vec2 } from '../utils/math.ts'
import { vec2 } from '../utils/math.ts'

const keysDown = new Set<string>()
let mousePos: Vec2 = vec2(0, 0)
let leftClick = false
let rightClick = false
let leftClickConsumed = false
let rightClickConsumed = false
let spacePressed = false
let spaceConsumed = false

export function init(canvas: HTMLCanvasElement): void {
  window.addEventListener('keydown', e => {
    // Don't block browser shortcuts (F12, Ctrl+Shift+I, etc)
    if (e.key === 'F12' || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    keysDown.add(e.key.toLowerCase())
    if (e.key === ' ') { spacePressed = true; spaceConsumed = false }
  })
  window.addEventListener('keyup', e => {
    keysDown.delete(e.key.toLowerCase())
    if (e.key === ' ') spacePressed = false
  })
  canvas.addEventListener('mousemove', e => {
    mousePos = vec2(e.clientX, e.clientY)
  })
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) { leftClick = true; leftClickConsumed = false }
    if (e.button === 2) { rightClick = true; rightClickConsumed = false }
  })
  canvas.addEventListener('mouseup', e => {
    if (e.button === 0) leftClick = false
    if (e.button === 2) rightClick = false
  })
  canvas.addEventListener('contextmenu', e => e.preventDefault())
  window.addEventListener('blur', () => {
    keysDown.clear()
    leftClick = false
    rightClick = false
    spacePressed = false
  })
}

export function isKeyDown(key: string): boolean {
  return keysDown.has(key.toLowerCase())
}

export function getMousePos(): Vec2 {
  return mousePos
}

export function consumeLeftClick(): boolean {
  if (leftClick && !leftClickConsumed) {
    leftClickConsumed = true
    return true
  }
  return false
}

export function consumeSpace(): boolean {
  if (spacePressed && !spaceConsumed) {
    spaceConsumed = true
    return true
  }
  return false
}

export function consumeRightClick(): boolean {
  if (rightClick && !rightClickConsumed) {
    rightClickConsumed = true
    return true
  }
  return false
}

export function getMovementDir(): Vec2 {
  let x = 0
  let y = 0
  if (isKeyDown('w') || isKeyDown('arrowup')) y -= 1
  if (isKeyDown('s') || isKeyDown('arrowdown')) y += 1
  if (isKeyDown('a') || isKeyDown('arrowleft')) x -= 1
  if (isKeyDown('d') || isKeyDown('arrowright')) x += 1
  // Normalize diagonal movement
  if (x !== 0 && y !== 0) {
    const inv = 1 / Math.SQRT2
    x *= inv
    y *= inv
  }
  return vec2(x, y)
}

export function flush(): void {
  // Called at start of each fixed tick — nothing to reset currently
}

/** Clear all pressed keys — call when UI panels open/close */
export function clearKeys(): void {
  keysDown.clear()
  spacePressed = false
}

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

// Input mode — auto-detected from first interaction type
let inputMode: 'keyboard' | 'touch' = 'keyboard'

// Touch joystick state
let joystickActive = false
let joystickOriginX = 0
let joystickOriginY = 0
let joystickCurrentX = 0
let joystickCurrentY = 0
let joystickPointerId = -1
const JOYSTICK_DEAD_ZONE = 15
const JOYSTICK_MAX_RADIUS = 65
export function getInputMode(): 'keyboard' | 'touch' { return inputMode }
export function isTouchMode(): boolean { return inputMode === 'touch' }
export function notifyTouchInput(): void { inputMode = 'touch' }

export function init(canvas: HTMLCanvasElement): void {
  window.addEventListener('keydown', e => {
    // Don't block browser shortcuts (F12, Ctrl+Shift+I, etc)
    if (e.key === 'F12' || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    inputMode = 'keyboard'
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

export function touchJoystickStart(id: number, x: number, y: number): void {
  joystickActive = true
  joystickPointerId = id
  joystickOriginX = x
  joystickOriginY = y
  joystickCurrentX = x
  joystickCurrentY = y
}

export function touchJoystickMove(x: number, y: number): void {
  joystickCurrentX = x
  joystickCurrentY = y
}

export function touchJoystickEnd(): void {
  joystickActive = false
  joystickPointerId = -1
}

export function getJoystickPointerId(): number { return joystickPointerId }

export function getJoystickState(): { active: boolean; originX: number; originY: number; currentX: number; currentY: number; maxRadius: number } {
  return { active: joystickActive, originX: joystickOriginX, originY: joystickOriginY, currentX: joystickCurrentX, currentY: joystickCurrentY, maxRadius: JOYSTICK_MAX_RADIUS }
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
  // Touch joystick — only if keyboard isn't active
  if (x === 0 && y === 0 && joystickActive) {
    const dx = joystickCurrentX - joystickOriginX
    const dy = joystickCurrentY - joystickOriginY
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > JOYSTICK_DEAD_ZONE) {
      const magnitude = Math.min(dist, JOYSTICK_MAX_RADIUS) / JOYSTICK_MAX_RADIUS
      x = (dx / dist) * magnitude
      y = (dy / dist) * magnitude
    }
  }
  return vec2(x, y)
}

let touchDashFrames = 0

export function triggerTouchDash(): void {
  spacePressed = true
  spaceConsumed = false
  touchDashFrames = 3  // keep active for a few ticks to ensure consumption
}

export function flush(): void {
  if (touchDashFrames > 0) {
    touchDashFrames--
    if (touchDashFrames <= 0) {
      spacePressed = false
    }
  }
}

/** Clear all pressed keys — call when UI panels open/close */
export function clearKeys(): void {
  keysDown.clear()
  spacePressed = false
  joystickActive = false
  joystickPointerId = -1
}

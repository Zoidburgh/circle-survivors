export interface Vec2 {
  x: number
  y: number
}

export function vec2(x: number, y: number): Vec2 {
  return { x, y }
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.sqrt(dx * dx + dy * dy)
}

export function hexToRgba(hex: string, alpha = 1.0): [number, number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return [r, g, b, alpha]
}

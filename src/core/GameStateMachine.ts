export type GameStateType = 'playing' | 'dead' | 'paused'

let current: GameStateType = 'playing'

export function getState(): GameStateType {
  return current
}

export function setState(next: GameStateType): void {
  current = next
}

export function isPlaying(): boolean {
  return current === 'playing'
}

export function isDead(): boolean {
  return current === 'dead'
}

export function isPaused(): boolean {
  return current === 'paused'
}

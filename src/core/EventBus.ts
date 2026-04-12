import type { Player } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'

// ── Event map: every event name → its payload tuple ──
export interface GameEventMap {
  'player:beat': [player: Player]
  'enemy:beat': [enemy: Enemy, ringIndex: number]
  'enemy:killed': [enemy: Enemy]
  'totem:spawn': [totemEnemy: Enemy]
  'enemy:revenge': [enemy: Enemy]
  'player:shieldBreak': [player: Player]
  'player:shieldRestore': [player: Player]
  'summon:phase': [enemy: Enemy]
}

type EventName = keyof GameEventMap

type Listener<K extends EventName> = (...args: GameEventMap[K]) => void

const listeners = new Map<EventName, Set<Listener<never>>>()

export function on<K extends EventName>(event: K, fn: Listener<K>): void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(fn as Listener<never>)
}

export function off<K extends EventName>(event: K, fn: Listener<K>): void {
  listeners.get(event)?.delete(fn as Listener<never>)
}

export function emit<K extends EventName>(event: K, ...args: GameEventMap[K]): void {
  const set = listeners.get(event) as Set<Listener<K>> | undefined
  set?.forEach(fn => fn(...args))
}

// Challenge builder — place enemies on arena, save/load challenges

import { ENEMY_TYPES } from '../entities/EnemyTypes.ts'
import type { EnemyType } from '../entities/EnemyTypes.ts'
import { getCamera } from '../core/GameState.ts'
import type { Camera } from '../game/Arena.ts'
import defaultData from '../../data/enemies.json'

export interface ChallengeEnemy {
  typeName: string
  x: number
  y: number
}

export interface Challenge {
  name: string
  arenaShape: 'rect' | 'circle' | 'hex' | 'pill' | 'cross'
  enemies: ChallengeEnemy[]
  order?: number  // lower = earlier in list, default 999
}

const SAVE_KEY = 'beatback_challenges'

let challenges: Challenge[] = []
let activeChallenge: Challenge | null = null

// Place mode state
let placeMode = false
let placeTypeName = ''
let placingEnemies: ChallengeEnemy[] = []
let selectedPlacementIdx = -1
let challengeName = 'Challenge 1'
let challengeArena: Challenge['arenaShape'] = 'circle'

export function isPlaceMode(): boolean { return placeMode }
export function getPlacingEnemies(): ChallengeEnemy[] { return placingEnemies }
export function getSelectedPlacement(): number { return selectedPlacementIdx }
export function getPlaceTypeName(): string { return placeTypeName }
export function getChallengeName(): string { return challengeName }
export function getChallengeArena(): Challenge['arenaShape'] { return challengeArena }
export function getChallenges(): Challenge[] {
  return [...challenges].sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
}
export function getActiveChallenge(): Challenge | null { return activeChallenge }

export function setPlaceMode(typeName: string): void {
  placeMode = true
  placeTypeName = typeName
  selectedPlacementIdx = -1
}

export function exitPlaceMode(): void {
  placeMode = false
  placeTypeName = ''
}

export function setChallengeName(name: string): void { challengeName = name }
export function setChallengeArena(shape: Challenge['arenaShape']): void { challengeArena = shape }

export function placeEnemy(screenX: number, screenY: number): void {
  const cam = getCamera()
  const worldX = screenX + cam.x - window.innerWidth / 2
  const worldY = screenY + cam.y - window.innerHeight / 2
  placingEnemies.push({ typeName: placeTypeName, x: worldX, y: worldY })
}

export function removeEnemy(idx: number): void {
  if (idx >= 0 && idx < placingEnemies.length) {
    placingEnemies.splice(idx, 1)
    if (selectedPlacementIdx === idx) selectedPlacementIdx = -1
    else if (selectedPlacementIdx > idx) selectedPlacementIdx--
  }
}

export function selectPlacement(screenX: number, screenY: number): boolean {
  const cam = getCamera()
  const worldX = screenX + cam.x - window.innerWidth / 2
  const worldY = screenY + cam.y - window.innerHeight / 2
  for (let i = placingEnemies.length - 1; i >= 0; i--) {
    const e = placingEnemies[i]!
    const type = ENEMY_TYPES.find(t => t.name === e.typeName)
    const r = type?.radius ?? 40
    const dx = worldX - e.x
    const dy = worldY - e.y
    if (dx * dx + dy * dy < r * r) {
      selectedPlacementIdx = i
      return true
    }
  }
  selectedPlacementIdx = -1
  return false
}

export function moveSelectedPlacement(screenX: number, screenY: number): void {
  if (selectedPlacementIdx < 0) return
  const cam = getCamera()
  const e = placingEnemies[selectedPlacementIdx]!
  e.x = screenX + cam.x - window.innerWidth / 2
  e.y = screenY + cam.y - window.innerHeight / 2
}

export function saveChallenge(): void {
  const challenge: Challenge = {
    name: challengeName,
    arenaShape: challengeArena,
    enemies: [...placingEnemies],
  }
  const existing = challenges.findIndex(c => c.name === challenge.name)
  if (existing >= 0) challenges[existing] = challenge
  else challenges.push(challenge)
  saveToStorage()
}

export function loadChallenge(name: string): void {
  const c = challenges.find(ch => ch.name === name)
  if (!c) return
  activeChallenge = c
  challengeName = c.name
  challengeArena = c.arenaShape
  placingEnemies = c.enemies.map(e => ({ ...e }))
}

export function deleteChallenge(name: string): void {
  challenges = challenges.filter(c => c.name !== name)
  saveToStorage()
}

export function clearPlacements(): void {
  placingEnemies = []
  selectedPlacementIdx = -1
}

export function setActiveChallenge(c: Challenge | null): void {
  activeChallenge = c
}

function saveToStorage(): void {
  localStorage.setItem(SAVE_KEY, JSON.stringify(challenges))
}

export function loadFromStorage(): void {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (raw) {
      challenges = JSON.parse(raw)
    } else {
      // First time — use bundled default challenges
      const bundled = (defaultData as any).challenges
      if (Array.isArray(bundled) && bundled.length > 0) {
        challenges = bundled
        saveToStorage()
      }
    }
  } catch { /* ignore */ }
}

export function exportChallenges(): string {
  return JSON.stringify(challenges, null, 2)
}

export function importChallenges(json: string): void {
  try {
    const data = JSON.parse(json) as Challenge[]
    if (Array.isArray(data)) {
      challenges = data
      saveToStorage()
    }
  } catch { /* ignore */ }
}

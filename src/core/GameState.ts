import { createPlayer } from '../entities/Player.ts'
import type { Player } from '../entities/Player.ts'
import type { Enemy } from '../entities/Enemy.ts'
import { SpatialGrid } from './SpatialGrid.ts'
import { createCamera, ARENA_W, ARENA_H } from '../game/Arena.ts'
import type { Camera } from '../game/Arena.ts'

const player: Player = createPlayer(ARENA_W / 2, ARENA_H / 2)
const enemies: Enemy[] = []
const grid = new SpatialGrid(150)
const camera: Camera = createCamera()

export function getPlayer(): Player { return player }
export function getEnemies(): Enemy[] { return enemies }
export function getGrid(): SpatialGrid { return grid }
export function getCamera(): Camera { return camera }

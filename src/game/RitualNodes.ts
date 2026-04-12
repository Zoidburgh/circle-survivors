import { RITUAL_NODE_RADIUS, RITUAL_LOCK_FLASH, RITUAL_COMPLETION_TIME } from '../utils/constants.ts'
import { getLoopPosition, getLoopLength } from '../audio/PatternClock.ts'

export interface RitualNode {
  x: number
  y: number
  radius: number
  state: 'idle' | 'locked'
  lockFlash: number
}

export interface RitualNodeGroup {
  id: number
  type: 'spawn' | 'shop'
  nodes: RitualNode[]
  progress: number
  startOffset: number
  completed: boolean
  completionTimer: number
  spawns?: { enemyName: string; count: number }[]
}

const groups: RitualNodeGroup[] = []
let nextId = 0
let ritualBeatCount = 0
let lastBeat = -1

export function getRitualGroups(): RitualNodeGroup[] {
  return groups
}

export function getActiveIndex(group: RitualNodeGroup): number {
  return ritualBeatCount % group.nodes.length
}

export function createNodeGroup(
  type: 'spawn' | 'shop',
  positions: { x: number; y: number }[],
  spawns?: { enemyName: string; count: number }[]
): RitualNodeGroup {
  const group: RitualNodeGroup = {
    id: nextId++,
    type,
    nodes: positions.map(p => ({
      x: p.x,
      y: p.y,
      radius: RITUAL_NODE_RADIUS,
      state: 'idle' as const,
      lockFlash: 0,
    })),
    progress: 0,
    startOffset: 0,
    completed: false,
    completionTimer: 0,
    spawns: spawns ?? [],
  }
  groups.push(group)
  return group
}

export function hitRitualNode(group: RitualNodeGroup, activeIdx: number): void {
  if (group.completed) return

  if (group.progress === 0) {
    // Starting fresh — can begin at any active node
    group.nodes[activeIdx]!.state = 'locked'
    group.nodes[activeIdx]!.lockFlash = RITUAL_LOCK_FLASH
    group.startOffset = activeIdx
    group.progress = 1
  } else {
    // Must follow sequence
    const expectedIdx = (group.startOffset + group.progress) % group.nodes.length
    if (activeIdx === expectedIdx) {
      group.nodes[activeIdx]!.state = 'locked'
      group.nodes[activeIdx]!.lockFlash = RITUAL_LOCK_FLASH
      group.progress++
    } else {
      resetGroup(group)
      return
    }
  }

  // Check completion
  if (group.progress >= group.nodes.length) {
    group.completed = true
    group.completionTimer = RITUAL_COMPLETION_TIME
  }
}

export function missRitualNode(group: RitualNodeGroup): void {
  if (group.progress > 0) resetGroup(group)
}

function resetGroup(group: RitualNodeGroup): void {
  group.progress = 0
  group.startOffset = 0
  for (const node of group.nodes) {
    node.state = 'idle'
  }
}

export function removeGroup(id: number): void {
  const idx = groups.findIndex(g => g.id === id)
  if (idx >= 0) {
    groups[idx] = groups[groups.length - 1]!
    groups.pop()
  }
}

/** Called each update tick */
export function updateRitualNodes(dt: number): void {
  // Track beats — increment on each new whole beat
  const currentBeat = Math.floor(getLoopPosition())
  if (currentBeat !== lastBeat) {
    if (lastBeat >= 0) ritualBeatCount++
    lastBeat = currentBeat
  }

  for (const group of groups) {
    // Tick lock flash timers
    for (const node of group.nodes) {
      if (node.lockFlash > 0) node.lockFlash -= dt
    }

    // Tick completion timer
    if (group.completed && group.completionTimer > 0) {
      group.completionTimer -= dt
    }
  }
}

export function resetRitualNodes(): void {
  groups.length = 0
  nextId = 0
  ritualBeatCount = 0
  lastBeat = -1
}

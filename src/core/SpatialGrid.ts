export interface GridEntity {
  x: number
  y: number
  radius: number
}

export class SpatialGrid {
  private cells = new Map<string, Set<GridEntity>>()
  private cellSize: number

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  clear(): void {
    this.cells.clear()
  }

  insert(e: GridEntity): void {
    for (const key of this.keys(e)) {
      let set = this.cells.get(key)
      if (!set) {
        set = new Set()
        this.cells.set(key, set)
      }
      set.add(e)
    }
  }

  query(e: GridEntity): Set<GridEntity> {
    const result = new Set<GridEntity>()
    for (const key of this.keys(e)) {
      const set = this.cells.get(key)
      if (set) {
        set.forEach(x => { if (x !== e) result.add(x) })
      }
    }
    return result
  }

  private keys(e: GridEntity): string[] {
    const r = e.radius
    const x0 = Math.floor((e.x - r) / this.cellSize)
    const x1 = Math.floor((e.x + r) / this.cellSize)
    const y0 = Math.floor((e.y - r) / this.cellSize)
    const y1 = Math.floor((e.y + r) / this.cellSize)
    const out: string[] = []
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        out.push(`${cx},${cy}`)
      }
    }
    return out
  }
}

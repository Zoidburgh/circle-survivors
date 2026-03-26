export interface GridEntity {
  x: number
  y: number
  radius: number
}

export class SpatialGrid {
  private cells = new Map<number, GridEntity[]>()
  private activeCells: number[] = []
  private cellSize: number
  private keysBuffer: number[] = []
  private queryBuffer: GridEntity[] = []

  constructor(cellSize: number) {
    this.cellSize = cellSize
  }

  clear(): void {
    for (const key of this.activeCells) {
      const cell = this.cells.get(key)
      if (cell) cell.length = 0
    }
    this.activeCells.length = 0
  }

  insert(e: GridEntity): void {
    this.computeKeys(e)
    for (let i = 0; i < this.keysBuffer.length; i++) {
      const key = this.keysBuffer[i]!
      let cell = this.cells.get(key)
      if (!cell) {
        cell = []
        this.cells.set(key, cell)
      }
      if (cell.length === 0) this.activeCells.push(key)
      cell.push(e)
    }
  }

  query(e: GridEntity): GridEntity[] {
    this.queryBuffer.length = 0
    this.computeKeys(e)
    for (let i = 0; i < this.keysBuffer.length; i++) {
      const cell = this.cells.get(this.keysBuffer[i]!)
      if (cell) {
        for (let j = 0; j < cell.length; j++) {
          const x = cell[j]!
          if (x !== e && !this.queryBuffer.includes(x)) {
            this.queryBuffer.push(x)
          }
        }
      }
    }
    return this.queryBuffer
  }

  private computeKeys(e: GridEntity): void {
    this.keysBuffer.length = 0
    const r = e.radius
    const x0 = Math.floor((e.x - r) / this.cellSize)
    const x1 = Math.floor((e.x + r) / this.cellSize)
    const y0 = Math.floor((e.y - r) / this.cellSize)
    const y1 = Math.floor((e.y + r) / this.cellSize)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        this.keysBuffer.push((cx + 5000) * 10000 + (cy + 5000))
      }
    }
  }
}

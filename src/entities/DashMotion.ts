// Shared sine-curve dash motion. Used by Player.dash and Enemy.dodge so both feel identical.

export interface DashMotionEntity {
  x: number
  y: number
  dashTimer: number
  dashDirX: number
  dashDirY: number
  dashDuration: number
  dashDistance: number
  dashPath: { x: number; y: number }[]
}

export interface DashMotionOpts {
  steerInput?: { x: number; y: number }   // player passes WASD; enemy omits
  distanceMult?: number                   // player passes modifiers.dashDistanceMult
  speedMult?: number                      // player passes modifiers.speedMult
}

export function applyDashMotion(entity: DashMotionEntity, dt: number, opts: DashMotionOpts = {}): void {
  if (entity.dashTimer < 0) return
  entity.dashTimer -= dt
  const distanceMult = opts.distanceMult ?? 1
  const speedMult = opts.speedMult ?? 1
  const progress = 1 - (Math.max(0, entity.dashTimer) / entity.dashDuration)
  const speed = Math.sin(progress * Math.PI) * (entity.dashDistance * distanceMult * speedMult / entity.dashDuration) * 1.6
  if (opts.steerInput) {
    const dir = opts.steerInput
    const steerStrength = 1.0
    if (dir.x !== 0 || dir.y !== 0) {
      entity.dashDirX += (dir.x - entity.dashDirX) * steerStrength * dt * 11
      entity.dashDirY += (dir.y - entity.dashDirY) * steerStrength * dt * 11
      const len = Math.sqrt(entity.dashDirX * entity.dashDirX + entity.dashDirY * entity.dashDirY)
      if (len > 0.1) {
        entity.dashDirX /= len
        entity.dashDirY /= len
      }
    }
  }
  entity.x += entity.dashDirX * speed * dt
  entity.y += entity.dashDirY * speed * dt
  const lastPt = entity.dashPath[entity.dashPath.length - 1]
  if (!lastPt || Math.sqrt((entity.x - lastPt.x) ** 2 + (entity.y - lastPt.y) ** 2) > 6) {
    entity.dashPath.push({ x: entity.x, y: entity.y })
  }
}

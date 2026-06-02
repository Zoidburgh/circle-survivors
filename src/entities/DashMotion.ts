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
  steerStrengthMult?: number              // Pivot upgrade — bumps mid-dash steering responsiveness (default 1.0)
  useAngleSteer?: boolean                 // Pivot upgrade — steer in angle space so axis-aligned 180° flips work (default off keeps original component lerp feel)
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
    if (dir.x !== 0 || dir.y !== 0) {
      const steerStrength = 1.0 * (opts.steerStrengthMult ?? 1)
      if (opts.useAngleSteer) {
        // Angle-space steering for Pivot — atan2 + shortest angular delta. Sidesteps the
        // component-lerp + renormalize symmetry trap on axis-aligned 180° reversals (where
        // X shrinks toward 0 while Y stays exactly 0 and normalization snaps X back). Uniform
        // turn rate at any angle including direct opposites.
        const targetAngle = Math.atan2(dir.y, dir.x)
        const currentAngle = Math.atan2(entity.dashDirY, entity.dashDirX)
        let delta = targetAngle - currentAngle
        if (delta > Math.PI) delta -= 2 * Math.PI
        else if (delta < -Math.PI) delta += 2 * Math.PI
        const factor = Math.min(1, steerStrength * dt * 11)
        const newAngle = currentAngle + delta * factor
        entity.dashDirX = Math.cos(newAngle)
        entity.dashDirY = Math.sin(newAngle)
      } else {
        // Default: original component lerp + renormalize. Preserved exactly so non-Pivot dash
        // keeps its feel.
        entity.dashDirX += (dir.x - entity.dashDirX) * steerStrength * dt * 11
        entity.dashDirY += (dir.y - entity.dashDirY) * steerStrength * dt * 11
        const len = Math.sqrt(entity.dashDirX * entity.dashDirX + entity.dashDirY * entity.dashDirY)
        if (len > 0.1) {
          entity.dashDirX /= len
          entity.dashDirY /= len
        }
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

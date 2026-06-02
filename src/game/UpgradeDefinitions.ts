// All possible upgrades — add one at a time, test each

import { getUpgradeCount } from './UpgradeManager.ts'
import type { UpgradeBonus } from './UpgradeManager.ts'

export interface UpgradeDef {
  id: string
  name: string
  description: string
  bonus: UpgradeBonus
  color: string
  tier?: 'stat' | 'game'  // stat = percentage, game = structural change
  maxStacks?: number       // undefined = unlimited
}

export const UPGRADE_POOL: UpgradeDef[] = [
  { id: 'ring_range_1', name: 'Wide Ring', description: '+10% ring range', bonus: { ringRadiusMult: 0.10 }, color: '#FFD740' },
  { id: 'speed_1', name: 'Swift', description: '+10% move speed', bonus: { speedMult: 0.10 }, color: '#4FC3F7' },
  { id: 'dash_dist_1', name: 'Long Dash', description: '+15% dash distance', bonus: { dashDistanceMult: 0.15 }, color: '#AB47BC' },
  { id: 'dash_cd_1', name: 'Quick Reload', description: '-10% dash cooldown', bonus: { dashChargeMult: -0.10 }, color: '#CE93D8' },
  // ── Game changers ──
  { id: 'extra_dash', name: 'Triple Dash', description: '+1 dash charge', bonus: { extraDashCharges: 1 }, color: '#FFD740', tier: 'game', maxStacks: 1 },
  { id: 'double_beat', name: 'Double Beat', description: '+1 off-beat ring attack', bonus: { doubleBeat: 1 }, color: '#FF5252', tier: 'game', maxStacks: 4 },
  { id: 'multi_kill', name: 'Overkill', description: '2+ kills in one beat = 2x XP each', bonus: { multiKillBonus: true }, color: '#64FFDA', tier: 'game', maxStacks: 1 },
  { id: 'multi_collect', name: 'Chain Harvest', description: '2+ orbs in one beat = 2x XP each', bonus: { multiCollectBonus: true }, color: '#80DEEA', tier: 'game', maxStacks: 1 },
  { id: 'ghost_dash', name: 'Ghost Dash', description: 'Invincible during dash', bonus: { ghostDash: true }, color: '#E0E0E0', tier: 'game', maxStacks: 1 },
  { id: 'extra_hp', name: 'Vitality', description: '+1 max HP', bonus: { extraHp: 1 }, color: '#FF5252', maxStacks: 30 },
  { id: 'small', name: 'Compact', description: '-10% player size', bonus: { sizeMult: -0.10 }, color: '#80CBC4', maxStacks: 5 },
  { id: 'beat_blast', name: 'Beat Blast', description: '+10% beat dash radius', bonus: { beatBlastMult: 0.10 }, color: '#FF5252', maxStacks: 5 },
  { id: 'chill_hit', name: 'Frostbite', description: 'Ring hits slow enemies (10%/stack, 5 max)', bonus: { chillHit: true }, color: '#80D8FF', tier: 'game', maxStacks: 2 },
  { id: 'aftershock', name: 'Aftershock', description: 'Beat dash detonates on the next beat (telegraphed)', bonus: { aftershock: true }, color: '#FF7043', tier: 'game', maxStacks: 1 },
  { id: 'slipstream', name: 'Slipstream', description: 'Dashing while still mid-dash gives +100% distance on that dash', bonus: { chainDash: true }, color: '#26C6DA', tier: 'game', maxStacks: 1 },
  { id: 'echo_step', name: 'Echo Step', description: 'Beat dash drops an anchor; next beat dash recalls you to it (invulnerable warp)', bonus: { anchorRecall: true }, color: '#7C4DFF', tier: 'game', maxStacks: 1 },
  { id: 'chill_zone', name: 'Chill Zone', description: 'Beat dash leaves a 2× radius slow field; next beat dash freezes anyone still inside the old field for a beat', bonus: { chillZone: true }, color: '#80D8FF', tier: 'game', maxStacks: 1 },
  { id: 'quiet_storm', name: 'Quiet Storm', description: 'Stand still 3s → charge up. Next BEAT DASH gets +100% distance and +100% AOE radius', bonus: { quietStorm: true }, color: '#FFD740', tier: 'game', maxStacks: 1 },
  { id: 'trailblaze', name: 'Trailblaze', description: 'Chain-dash (dash while already dashing) draws a thin wall along your previous dash path. Stays until your next chain-dash.', bonus: { drawWall: true }, color: '#26C6DA', tier: 'game', maxStacks: 1 },
  { id: 'reverb', name: 'Reverb', description: 'Beat-dash no longer deals damage — instead it emits a big push wave that throws enemies outward. Stronger the closer they are. Scales with beat-dash radius.', bonus: { shockPush: true }, color: '#4FC3F7', tier: 'game', maxStacks: 1 },
  { id: 'dash_shot', name: 'Bolt', description: 'Beat-dash no longer detonates at your position — instead it fires a glowing projectile in your dash direction that explodes 1 beat later (passes through walls). Aftershock adds another beat (2× travel distance). Same blast math.', bonus: { dashShot: true }, color: '#FFD740', tier: 'game', maxStacks: 1 },
  { id: 'pivot', name: 'Pivot', description: 'Your dash is no longer a committed straight lunge — hold movement input to carve aggressive curves mid-dash. Steering is ~3.5× more responsive than the default.', bonus: { pivot: true }, color: '#26C6DA', tier: 'game', maxStacks: 1 },
]

/** Pick N random upgrades from the pool, excluding already-maxed */
export function pickRandomUpgrades(count: number): UpgradeDef[] {
  const available = UPGRADE_POOL.filter(def => {
    if (def.maxStacks == null) return true
    return getUpgradeCount(def.id) < def.maxStacks
  })
  const shuffled = available.sort(() => Math.random() - 0.5)
  return shuffled.slice(0, Math.min(count, shuffled.length))
}

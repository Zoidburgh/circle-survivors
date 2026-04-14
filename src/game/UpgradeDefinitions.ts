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

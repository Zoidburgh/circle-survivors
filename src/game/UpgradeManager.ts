// Upgrade manager — tracks active upgrades, computes additive modifiers
// Each upgrade contributes bonuses that stack additively
// Final modifier = 1.0 + sum(all bonuses)

import type { PlayerModifiers } from '../entities/Player.ts'
import { getPattern, setPattern } from '../audio/PatternClock.ts'
import { SHIELD_MAX_CHARGES, SHIELD_RECHARGE_TIME, PLAYER_MAX_HP } from '../utils/constants.ts'

export interface UpgradeBonus {
  speedMult?: number        // e.g. 0.1 = +10% speed
  damageMult?: number
  hpMult?: number
  ringRadiusMult?: number
  dashDistanceMult?: number
  dashChargeMult?: number   // negative = faster recharge
  xpMult?: number
  // Structural bonuses — applied directly, not as multipliers
  extraDashCharges?: number
  doubleBeat?: number  // each stack adds more off-beat ring attacks (max 4)
  multiKillBonus?: boolean // 2+ kills in one beat = double XP from each
  multiCollectBonus?: boolean // 2+ orbs collected in one beat = double XP from each
  ghostDash?: boolean // invincible during dash
  chillHit?: boolean  // ring hits slow enemies
  extraHp?: number             // +1 max HP per stack
  sizeMult?: number            // negative = smaller (e.g. -0.10 = 10% smaller)
  beatBlastMult?: number       // +10% beat dash blast radius per stack
  shieldRechargeMult?: number  // negative = faster recharge
  shieldMaxCharges?: number    // +1 shield charge per stack
  noShield?: boolean           // tradeoff: removes shield entirely
  aftershock?: boolean         // beat dash detonates on next beat (telegraphed)
  chainDash?: boolean          // dashing while still mid-dash gives the new dash +100% distance
  anchorRecall?: boolean       // Echo Step — beat dash leapfrogs to previous anchor + drops a new one
  chillZone?: boolean          // Chill Zone — beat dash places a 2× radius 50% slow field; next beat-dash freezes-in-place anyone still in the old zone
}

export interface ActiveUpgrade {
  id: string
  name: string
  description: string
  bonus: UpgradeBonus
}

const activeUpgrades: ActiveUpgrade[] = []
const bonusFlags = new Set<keyof UpgradeBonus>()
const bonusCounts = new Map<keyof UpgradeBonus, number>()
const upgradeIdCounts = new Map<string, number>()

function rebuildBonusCache(): void {
  bonusFlags.clear()
  bonusCounts.clear()
  upgradeIdCounts.clear()
  for (const u of activeUpgrades) {
    // Track ID counts for maxStacks
    upgradeIdCounts.set(u.id, (upgradeIdCounts.get(u.id) ?? 0) + 1)
    for (const key of Object.keys(u.bonus) as (keyof UpgradeBonus)[]) {
      if (u.bonus[key]) {
        bonusFlags.add(key)
        bonusCounts.set(key, (bonusCounts.get(key) ?? 0) + 1)
      }
    }
  }
}

export function getActiveUpgrades(): ActiveUpgrade[] {
  return activeUpgrades
}

export function addUpgrade(upgrade: ActiveUpgrade): void {
  activeUpgrades.push(upgrade)
  rebuildBonusCache()
}

export function removeUpgrade(id: string): void {
  const idx = activeUpgrades.findIndex(u => u.id === id)
  if (idx >= 0) {
    activeUpgrades.splice(idx, 1)
    rebuildBonusCache()
  }
}

/** Clear all upgrades — call on run restart */
export function resetUpgrades(): void {
  activeUpgrades.length = 0
  rebuildBonusCache()
}

export function hasUpgrade(id: string): boolean {
  return (upgradeIdCounts.get(id) ?? 0) > 0
}

export function getUpgradeCount(id: string): number {
  return upgradeIdCounts.get(id) ?? 0
}

export function hasBonus(key: keyof UpgradeBonus): boolean {
  return bonusFlags.has(key)
}

export function getBonusCount(key: keyof UpgradeBonus): number {
  return bonusCounts.get(key) ?? 0
}

/** How many ranks of Frostbite (chillHit) the player has picked */
export function getChillRank(): number {
  return bonusCounts.get('chillHit') ?? 0
}

/** Recompute final modifiers from all active upgrades (additive stacking) */
export function computeModifiers(): PlayerModifiers {
  let speed = 0
  let damage = 0
  let hp = 0
  let ringRadius = 0
  let dashDistance = 0
  let dashCharge = 0
  let xp = 0
  let shieldRecharge = 0
  let size = 0
  let beatBlast = 0

  for (const u of activeUpgrades) {
    speed += u.bonus.speedMult ?? 0
    damage += u.bonus.damageMult ?? 0
    hp += u.bonus.hpMult ?? 0
    ringRadius += u.bonus.ringRadiusMult ?? 0
    dashDistance += u.bonus.dashDistanceMult ?? 0
    dashCharge += u.bonus.dashChargeMult ?? 0
    xp += u.bonus.xpMult ?? 0
    shieldRecharge += u.bonus.shieldRechargeMult ?? 0
    size += u.bonus.sizeMult ?? 0
    beatBlast += u.bonus.beatBlastMult ?? 0
  }

  return {
    speedMult: 1 + speed,
    damageMult: 1 + damage,
    hpMult: 1 + hp,
    ringRadiusMult: 1 + ringRadius,
    dashDistanceMult: 1 + dashDistance,
    dashChargeMult: 1 + dashCharge,
    xpMult: 1 + xp,
    shieldRechargeMult: 1 + shieldRecharge,
    sizeMult: 1 + size,
    beatBlastMult: 1 + beatBlast,
  }
}

// Extra ring beat patterns — each stack fills in between existing beats
// Stack 1: between beat 3→4 and 7→0 (3.5, 7.5)
// Stack 2: + between 0→1 and 4→5 (0.5, 4.5)
// Stack 3: + between 1→2 and 5→6 (1.5, 5.5)
// Stack 4: + between 2→3 and 6→7 (2.5, 6.5)
const EXTRA_RING_BEATS: number[][] = [
  [3.5, 7.5],
  [0.5, 4.5],
  [1.5, 5.5],
  [2.5, 6.5],
]

/** Apply computed modifiers to player — call after any upgrade change */
export function applyModifiers(player: { modifiers: PlayerModifiers; dashMaxCharges: number; dashSlots: number[]; extraRingCount: number; shieldMaxCharges: number; shieldCharges: number; shieldRechargeTimer: number; shieldRechargeTime: number; hp: number; maxHp: number }): void {
  const mods = computeModifiers()
  player.modifiers.speedMult = mods.speedMult
  player.modifiers.damageMult = mods.damageMult
  player.modifiers.hpMult = mods.hpMult
  player.modifiers.ringRadiusMult = mods.ringRadiusMult
  player.modifiers.dashDistanceMult = mods.dashDistanceMult
  player.modifiers.dashChargeMult = mods.dashChargeMult
  player.modifiers.xpMult = mods.xpMult
  player.modifiers.shieldRechargeMult = mods.shieldRechargeMult
  player.modifiers.sizeMult = mods.sizeMult
  player.modifiers.beatBlastMult = mods.beatBlastMult

  // Structural: extra HP
  let extraHp = 0
  for (const u of activeUpgrades) {
    extraHp += u.bonus.extraHp ?? 0
  }
  const oldMax = player.maxHp
  player.maxHp = PLAYER_MAX_HP + extraHp
  if (player.maxHp > oldMax) {
    player.hp += player.maxHp - oldMax  // heal the gained HP
  }

  // Structural: extra dash charges
  let extraDash = 0
  for (const u of activeUpgrades) {
    extraDash += u.bonus.extraDashCharges ?? 0
  }
  const baseDashCharges = 2
  const targetCharges = baseDashCharges + extraDash
  while (player.dashSlots.length < targetCharges) {
    player.dashSlots.push(0) // add ready slot
  }
  while (player.dashSlots.length > targetCharges) {
    player.dashSlots.pop()
  }
  player.dashMaxCharges = targetCharges

  // Structural: double beat (extra ring attacks)
  let doubleBeatStacks = 0
  for (const u of activeUpgrades) {
    doubleBeatStacks += u.bonus.doubleBeat ?? 0
  }
  doubleBeatStacks = Math.min(doubleBeatStacks, 4)
  player.extraRingCount = doubleBeatStacks

  // Register extra ring patterns in PatternClock
  const pat = getPattern()
  if (pat) {
    const patterns = { ...pat.patterns }
    // Remove old extra patterns
    for (let i = 0; i < 4; i++) {
      delete patterns[`PlayerExtra${i}`]
    }
    // Add active ones
    for (let i = 0; i < doubleBeatStacks; i++) {
      patterns[`PlayerExtra${i}`] = EXTRA_RING_BEATS[i]!
    }
    setPattern({ ...pat, patterns })
  }

  // Structural: shield charges
  let extraShield = 0
  let removeShield = false
  for (const u of activeUpgrades) {
    extraShield += u.bonus.shieldMaxCharges ?? 0
    if (u.bonus.noShield) removeShield = true
  }
  if (removeShield) {
    player.shieldMaxCharges = 0
    player.shieldCharges = 0
    player.shieldRechargeTimer = -1
  } else {
    const targetShield = SHIELD_MAX_CHARGES + extraShield
    player.shieldMaxCharges = targetShield
    if (player.shieldCharges < targetShield && player.shieldRechargeTimer < 0) {
      player.shieldCharges = targetShield
    }
  }
  player.shieldRechargeTime = SHIELD_RECHARGE_TIME * player.modifiers.shieldRechargeMult
}

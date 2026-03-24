// Upgrade manager — tracks active upgrades, computes additive modifiers
// Each upgrade contributes bonuses that stack additively
// Final modifier = 1.0 + sum(all bonuses)

import type { PlayerModifiers } from '../entities/Player.ts'
import { getPattern, setPattern } from '../audio/PatternClock.ts'

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
}

export interface ActiveUpgrade {
  id: string
  name: string
  description: string
  bonus: UpgradeBonus
}

const activeUpgrades: ActiveUpgrade[] = []

export function getActiveUpgrades(): ActiveUpgrade[] {
  return activeUpgrades
}

export function addUpgrade(upgrade: ActiveUpgrade): void {
  activeUpgrades.push(upgrade)
}

export function removeUpgrade(id: string): void {
  const idx = activeUpgrades.findIndex(u => u.id === id)
  if (idx >= 0) activeUpgrades.splice(idx, 1)
}

export function hasUpgrade(id: string): boolean {
  return activeUpgrades.some(u => u.id === id)
}

export function hasBonus(key: keyof UpgradeBonus): boolean {
  return activeUpgrades.some(u => u.bonus[key])
}

/** How many ranks of Frostbite (chillHit) the player has picked */
export function getChillRank(): number {
  return activeUpgrades.filter(u => u.bonus.chillHit).length
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

  for (const u of activeUpgrades) {
    speed += u.bonus.speedMult ?? 0
    damage += u.bonus.damageMult ?? 0
    hp += u.bonus.hpMult ?? 0
    ringRadius += u.bonus.ringRadiusMult ?? 0
    dashDistance += u.bonus.dashDistanceMult ?? 0
    dashCharge += u.bonus.dashChargeMult ?? 0
    xp += u.bonus.xpMult ?? 0
  }

  return {
    speedMult: 1 + speed,
    damageMult: 1 + damage,
    hpMult: 1 + hp,
    ringRadiusMult: 1 + ringRadius,
    dashDistanceMult: 1 + dashDistance,
    dashChargeMult: 1 + dashCharge,
    xpMult: 1 + xp,
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
export function applyModifiers(player: { modifiers: PlayerModifiers; dashMaxCharges: number; dashSlots: number[]; extraRingCount: number }): void {
  const mods = computeModifiers()
  player.modifiers.speedMult = mods.speedMult
  player.modifiers.damageMult = mods.damageMult
  player.modifiers.hpMult = mods.hpMult
  player.modifiers.ringRadiusMult = mods.ringRadiusMult
  player.modifiers.dashDistanceMult = mods.dashDistanceMult
  player.modifiers.dashChargeMult = mods.dashChargeMult
  player.modifiers.xpMult = mods.xpMult

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
}

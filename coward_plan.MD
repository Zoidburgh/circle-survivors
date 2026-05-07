# Coward / Dodge Trait — Build & Test Plan

A composable trait (like `revenge`, `magnet`, `blink`, `volatile`) that gives any enemy
intelligent ring-dodging.

---

## STATUS — pick up here on reload

### Done (in code, NOT YET COMMITTED to git)
- **Step 1:** data fields on `EnemyType`, `Enemy` interface, `createEnemy` init.
- **Step 2 (brain):** `updateDodge` + `shouldDodge` + radial `pickDodgeDirection`. Triggers when ring is at 75–90% expansion AND enemy is in danger band (`±(enemy.radius + 12)` of peakR). Picks toward player if inside reach, away if outside, falls back to other side if walled.
- **Step 7 (UI, partial):** "Dodge" checkbox in Workshop trait row + 4 sliders (Charges, CD, Distance, Speed). Persists with the saved enemy.
- **Shared helper extracted:** `src/entities/DashMotion.ts → applyDashMotion(entity, dt, opts?)`. Player and Enemy both call it. Player visuals/feel unchanged.

### In progress
- Step 2 brain is working with **simple radial dodge only**. Step 3 (8-direction smart picker) not started.

### Remaining
- **Step 3:** smart 8-candidate direction picker (replaces simple radial).
- **Step 4:** orbit dots rendered above the dodger (extract player's orbit-dot loop).
- **Step 5:** orb-explosion-on-consume + afterimage trail (extract player's burst + dashPath rendering).
- **Step 6:** ~~exhausted state~~ **REMOVED — user rejected.** Skip this step entirely.

### Key decisions / scope cuts
- **NO exhausted/stun mechanic.** Originally planned but user rejected. Each charge recharges independently like the player's dash; when all charges are spent, the enemy just can't dodge until a slot refills. No slowdown, no special state, no separate timer.
- **Removed type fields** that I added without explicit ask: `dodgeBurstSpeed` (now exposed as `dodgeSpeed` slider), `dodgeExhaustedDuration`, `dodgeExhaustedSpeedMult`. Removed runtime field `exhaustedTimer`. See memory `feedback_no_extra_params.md`.
- **UI sliders are exactly:** Charges, CD, Distance, Speed. Nothing else.

### Data shape (final)

`EnemyType` fields (designable):
```ts
dodge?: boolean
dodgeCharges?: number       // default 2
dodgeChargeTime?: number    // default 1.5 (s per slot recharge)
dodgeDistance?: number      // default 100 (units traveled per dodge)
dodgeSpeed?: number         // default 1.0 (burst speed multiplier)
```

`Enemy` runtime fields (mirror Player.dash* so shared helper works):
```ts
dodge: boolean
dodgeSlots: number[]        // per-slot recharge timer
dashTimer: number           // -1 = idle, >0 = mid-burst
dashDirX, dashDirY: number
dashDuration: number        // hardcoded 0.2s
dashDistance: number        // = type.dodgeDistance
dashSpeedMult: number       // = type.dodgeSpeed
dashPath: { x, y }[]        // for afterimage (Step 5)
```

---

## Architectural commitment: REUSE, don't rebuild

The player already has:
- **Dash motion** — extracted to `DashMotion.ts:applyDashMotion`. Player + Enemy both call it.
- **Orbit dot rendering + recharge animation** — at `Renderer.ts:3174-3320`. Will be extracted in Step 4.
- **Particle burst on slot consumed** — `Renderer.ts:3186-3208`. Will be extracted in Step 5.
- **Converge particles + flash on slot ready** — `Renderer.ts:3210-3270`. **Won't be used** (no exhausted state to refill from).
- **Afterimage trail using `dashPath`** — `Renderer.ts:~2476`. Will be extracted in Step 5.
- **Collision/separation physics** — `GameManager.ts:1660` + `:1736`. Already free; no changes needed.

---

## Step 3 — Smart 8-direction picker (with toward + wall avoidance)

**Goal:** the enemy picks the *best* dodge direction from 8 candidates (matching the player's
dash directions). Hard-skip any direction that would clip a wall.

**Files changed**

`src/entities/Enemy.ts pickDodgeDirection` — replace simple radial with scored 8-candidate:
```ts
const baseAngle = Math.atan2(enemy.y - player.y, enemy.x - player.x)
const candidates: { dx, dy, score }[] = []
for (let i = 0; i < 8; i++) {
  const angle = baseAngle + (i * Math.PI / 4)
  const dx = Math.cos(angle), dy = Math.sin(angle)
  const newX = enemy.x + dx * enemy.dashDistance
  const newY = enemy.y + dy * enemy.dashDistance
  const c = clampToArena(newX, newY, enemy.radius)
  if (Math.hypot(newX - c.x, newY - c.y) > 10) continue   // wall — skip
  const score = Math.abs(Math.hypot(newX - player.x, newY - player.y) - danger.peakR)
  candidates.push({ dx, dy, score })
}
if (candidates.length === 0) return null   // all walled — no dodge, no charge
candidates.sort((a, b) => b.score - a.score)
return { x: candidates[0].dx, y: candidates[0].dy }
```

**How to test**
1. Spawn dodger close to player → dodges *toward* (inside the safe interior).
2. Spawn far from player → dodges *away* (outside the ring's reach).
3. Pin against a wall → picks an open angle, never goes through.
4. Cornered with no escape → doesn't dodge at all (no charge consumed).

---

## Step 4 — Charge orbit dots (visible state)

**Goal:** the player can SEE the enemy's dodge state at a glance.

**Files changed**

Extract these from `Renderer.ts:3174-3320`:
- `getDashOrbitPosition(centerX, centerY, slotIndex, slotCount, baseRadius)` → `{x, y, angle}`
- `drawDashOrbitDot(ctx, x, y, dotR, fillT, color)` — filled (ready) or recharging arc

In the per-enemy draw loop, if `enemy.dodge`:
```ts
const orbitR = enemy.radius + 6
const dotR = 2 + enemy.radius * 0.05   // scales with enemy size
for (let i = 0; i < enemy.dodgeSlots.length; i++) {
  const pos = getDashOrbitPosition(enemy.x, enemy.y, i, enemy.dodgeSlots.length, orbitR)
  const fillT = enemy.dodgeSlots[i] > 0 ? 1 - enemy.dodgeSlots[i] / dodgeChargeTime : 1
  drawDashOrbitDot(ctx, pos.x, pos.y, dotR, fillT, enemy.color)
}
```

**How to test**
1. Spawn dodger → see N small dots orbiting (N = `dodgeCharges`).
2. Bait dodge → one dot becomes a recharging arc.
3. Spawn small (radius 20) and big (radius 80) dodgers → dots scale visibly.

---

## Step 5 — Consume burst + afterimage (reuse extracted helpers)

**Goal:** when a dodge fires, the orb explodes the same way the player's does, and the enemy
leaves the same afterimage trail.

**Files changed**

Extract from `Renderer.ts:3186-3208`:
- `spawnDashConsumeBurst(worldX, worldY, dashAngle, color, scale)` — particle burst, scale multiplies particle count

Extract afterimage rendering from `Renderer.ts:~2476`:
- `drawDashAfterimage(entity, ctx, opts)` — fading silhouettes along `entity.dashPath`

In `Renderer.ts` per-enemy draw loop:
- Track `prevEnemyDodgeSlots` (mirror `prevDashSlots`). On slot transition `0 → > 0`, call `spawnDashConsumeBurst` at orb position with `enemy.color, scale = enemy.radius * 0.05`.
- If `enemy.dashTimer >= 0 && enemy.dashPath.length > 1` → call `drawDashAfterimage`.

**No body squash, no body flash.** Silhouette stays clean.

**How to test**
1. Bait a dodge → orb pops with colored particles, enemy slides with afterimage trail.
2. Small + big dodgers → particle counts and trail thickness scale visibly.
3. Pin against wall → no dodge fires (Step 3), so no animation, no charge consumed.

---

## ~~Step 6 — Exhausted state~~ — REMOVED

User rejected the exhausted/slow mechanic. Each dodge slot just recharges independently;
no separate stunned state. Skip this step.

---

## Working agreement

After each step:
1. Mark task in_progress when starting, completed when done.
2. Stop and tell the user exactly what to test.
3. User runs **How to test** in the browser.
4. Only when "good" → next step.
5. If a **Failure flag** fires → fix before proceeding.

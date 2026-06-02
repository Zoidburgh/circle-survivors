# Dev Journal — 2026-05-24

Long session focused on polishing the wall spring system, adding a Pusher enemy trait, and adding Pendulum motion. Detailed notes below for future sessions.

---

## 1. Wall spring "feel" overhaul

The wall spring (bounce) system existed but had a list of "off" feelings. Series of fixes, all in **`GameManager.ts`** unless noted.

### Anti-cancel logic in `applyLaunch` (GameManager.ts ~929)
Before: `launchVx += nx * strength` was purely additive — two opposing springs cancelled to zero, so a player bouncing between walls felt "stuck."

After: project existing launch onto new normal; if opposing (`proj < 0`), remove 70% of the opposing component BEFORE adding the new impulse. Same-direction launches still stack fully (cumulative is preserved). Opposite-direction launches: spring now wins.

### Dash interrupt on spring contact (GameManager.ts ~975)
When a spring fires and the player is in range AND mid-dash, the dash is cancelled (`player.dashTimer = -1`). Otherwise the dash's position curve overrides launch velocity every frame and grinds through the spring. With the cancel, the spring takes full effect.

### Snappier launch decay (Player.ts, Enemy.ts, XPOrb.ts)
- `launchTimer`: 0.4 → **0.28s**
- Decay base: 0.18 → **0.03** per second (faster falloff, peak still ~500 px/s)
- `LAUNCH_FADE_TAIL`: **0.10s** smooth fade in final 0.10s so the launch eases to zero instead of snapping abruptly

Profile (peak = 500 px/s):
| time | raw velocity | applied (× fade) |
|------|--------------|------------------|
| 0.00 | 500 (100%)   | 500 |
| 0.10 | ~376 (75%)   | 376 |
| 0.20 | ~211 (42%)   | 211 |
| 0.28 | ~120 (24%)   | 0 (fade tail end) |

### DI (Directional Influence) — Player.ts launch integration
Input vector ACCELERATES launch velocity (`STEER_ACCEL = 8500 px/s²`). So holding opposite direction can cancel a 500 px/s launch in ~0.06s. Holding perpendicular bends the arc. Holding into the launch boosts it.

### Asymmetric opposition lockout (Player.ts)
Input is split into parallel-to-launch and perpendicular components:
- **Perpendicular** always has full authority (curves the arc freely).
- **Parallel WITH** the launch always has full authority (boost).
- **Parallel AGAINST** the launch is gated:
  - First 0.08s: 100% lockout (can't fight at all)
  - 0.08 → 0.20s: ramps from 0 → 100% authority
  - 0.20s+: full authority (cancel/brake)

Net: you can steer mid-bounce, but you can't slam the brakes during the first ~5 frames. The bounce commits.

### `SPRING_GRACE_BEATS` = 0.22 (GameManager.ts)
After a spring fires, it stays "active" for 0.22 beats (~13 frames at 60 BPM). Any entity entering trigger range during the window gets pushed, once per fire. Tracked per-wall via `springPushedThisFire: WeakMap<Wall, Set<unknown>>`.

### Re-push on out-of-range (GameManager.ts tryPushSpring & tryPushPusher)
The pushed Set was sticky — once an entity got launched they couldn't be pushed again that fire. Bug: if a launched enemy was bounced INTO the player, player didn't get pushed because they were "already" pushed.

Fix: when an entity is checked and found OUT OF RANGE, remove them from the set. Lets them be re-pushed if they re-enter range during grace (catching up, bouncing back, etc.). One push per overlap, not one per fire.

### `SPRING_TRIGGER_BUFFER` = 11 (GameManager.ts ~955)
Final value after several iterations (12 → 6 → 16 → 13 → 11). Adds margin so springs catch entities pressed against the wall (wall collision pushes them to EXACTLY `wallR + entR` distance, so strict overlap misses them). Lower buffer = more contact-required.

### Heavy enemy resist
Immovable enemies (`movePattern === 'immovable'`) take 50% spring strength via `HEAVY_RESIST = 0.5` constant. They still get bumped (springs bypass every immovability gate at the entity-side integration), just less far per fire.

### Audio pre-scheduling
Spring fires schedule their audio 0.5 beats in advance using `playWallSpringFire(t)` with explicit Web Audio time. This is sample-accurate (no output latency). Same pattern reused for pusher enemies. The `BEAT_AUDIO_OFFSET = 0.37` constant aligns fires to the music's kick offset (not the visual ring peak at 0.45 — that was an early bug).

---

## 2. Wall visual overhaul

### Outside particles → inner shockwave (Renderer.ts ~1559)
Old `spawnSpringFireBurst()` sprayed particles perpendicular to the wall on fire. User wanted INSIDE pulse, not outside spray. Function still exists but is no longer called.

### `drawInnerShockwave(d, progress)` (Renderer.ts ~1720)
New nested helper inside `drawWalls`. Handles all three wall shapes:
- **Pillar**: concentric ring expanding from center, clipped to circle interior.
- **Capsule**: two parallel bars sliding from spine outward to rim, clipped to roundRect.
- **Arc (bent)**: two arcs (inner + outer) expanding from spine arc, clipped to annulus segment.

Three layers per shockwave, widths scale with wall thickness `r`:
- **Glow** = `max(10, r × 0.60)` — `rgba(255, 200, 90, 0.55 × alpha)`
- **Core** = `max(3.5, r × 0.24)` — `rgba(255, 245, 200, alpha)`
- **Hot** = `max(1.2, r × 0.08)` — `rgba(255, 255, 245, 0.9 × alpha)`

Alpha = `(1 - progress²)` — bright at fire, quadratic fade. `shockDur = min(0.22, cycle × 0.32)`.

Each layer is clipped via `ctx.clip()` to the wall body interior. Capsule clip uses `ctx.roundRect()` with corner radius = r, in transformed coords (translated to midpoint + rotated to wall angle).

### Pulse expansion math (Renderer.ts ~1661)
Wall body itself pulses on fire using `visScale = 1 + ease × pulseAmpl` where:
- `pulseDur = min(0.20, cycle × 0.30)` — matches grace window
- `pulseAmpl = min(0.13, cycle × 0.13)` — 13% max expansion
- `ease = (1 - t)²` — instant peak at fire, quadratic decay (hammer profile, not sine arch)

The `(1-t)²` shape was a deliberate change from `sin(t × π)` because the sine arch peaked at `t=0.5` of pulseDur — meaning the wall grew biggest 75ms AFTER firing. Confusing because the spring is dormant by then. Hammer profile peaks AT fire moment.

### Passive bloom on rim (Renderer.ts ~1807)
Halo pass padding bumped 18 → 14 with alpha lift `+0.08`. Tighter glow that hugs the rim instead of extending far past it.

### Max wall thickness doubled (ChallengeBuilder.ts:116, EnemyDesigner.ts:481)
`setWallThickness` clamp: 120 → 240. Slider max attribute matched.

---

## 3. Wall group motion (Arena.ts + Renderer.ts + ChallengeBuilder.ts)

Problem: only ONE wall in a connected group rotates when motion is set on one wall; others stay put → group visually rips apart.

### `groupMotion` field on Wall (Arena.ts:328)
New runtime field, propagated during `recomputeWallGroupCenters` (Arena.ts:490+):
1. For each connected group, find the first wall with `motion` → store as `groupMotionByG[g]`
2. Propagate to every wall in the group as `groupMotion`

### `updateWalls` uses groupMotion not motion (Arena.ts:536)
Whole connected group rotates as a rigid body around shared `groupCenterX/Y`. Single motion config animates the entire shape.

### Renderer reads groupMotion (Renderer.ts:1860)
Gold motion-flash check updated to `d.w.groupMotion?.type` so every wall in a moving group flashes, not just the leader.

### Designer propagation (ChallengeBuilder.ts:311+)
- `setSelectedWallMotion` now applies the motion to every wall in the connected group via existing `findConnectedWalls` flood-fill.
- `getSelectedWallMotion` falls back to peer motion so clicking any wall in a group shows the same config.

---

## 4. Pendulum motion type — Arena.ts + Renderer.ts + EnemyDesigner.ts

Extended `WallMotion.type` from `'rotate'` to `'rotate' | 'pendulum'`. Sweep back and forth instead of continuous rotation.

### Type extension (Arena.ts:333)
```ts
export interface WallMotion {
  type: 'rotate' | 'pendulum'
  beatsPerCycle?: number      // rotate: per revolution. pendulum: per A→B→A. (default 4)
  direction?: 1 | -1          // rotate: CW/CCW. pendulum: which way first swing goes. (default 1)
  phaseBeats?: number
  sweepDegrees?: number       // pendulum only — ±sweepDegrees/2 around rest (default 90)
}
```

### Runtime (Arena.ts:531+)
Both motion types compute an angle then share the same cos/sin transform on `restAx/Ay/Bx/By`. Pendulum:
```ts
angle = (sweepDegrees/2 in radians) × direction × sin(2π × (beatPos + phase) / beatsPerCycle)
```
Smooth sine sweep, slowest at turnarounds. Naturally beat-locked.

### Renderer (Renderer.ts:1860)
Gold motion-flash triggers for both `rotate` and `pendulum` (pendulum needs it especially at turnaround pauses where angular velocity is zero).

### Designer UI (EnemyDesigner.ts ~490)
- Motion type dropdown: None / Rotate / Pendulum
- "Beats/rev" relabeled to "Beats/cycle" (semantic for both)
- Sweep field (10–360, default 90, step 5) appears only when Pendulum selected
- Helper text updates live: "Spins continuously..." / "Swings ±N°..." / "Pick Rotate or Pendulum..."
- `pushMotionChange()` handles both types via the existing `setSelectedWallMotion` (which already propagates to group peers)

Prefabs: zero changes needed — existing `...w.motion` spread carries `sweepDegrees` automatically.

---

## 5. Pusher enemy trait — full implementation

New enemy trait that pulses on-beat and shoves nearby entities. Pure kinematic — no damage, no shield break, no revenge trigger.

### Data model

**`EnemyType`** (EnemyTypes.ts ~37) — saved to JSON/localStorage:
- `pusher?: boolean`
- `pusherBeats?: number` (default 2)
- `pusherPhase?: number` (default 0)
- `pusherStrength?: number` (default 600, same units as wall spring)

**`Enemy`** runtime (Enemy.ts ~108):
- `pusher`, `pusherBeats`, `pusherPhase`, `pusherStrength` (mirror EnemyType)
- `pusherLastFireBeat: number | null` — absolute beat of most recent fire
- `pusherJustFired: boolean` — transient one-shot flag (currently unused but exposed)
- `pusherScheduledAudioBeat: number | null` — most recent beat we pre-scheduled audio for

### Firing logic — `processPusherEnemies()` (GameManager.ts ~1167)

Mirrors `processSpringFires` exactly:
1. **Pass 1 — detect fires**: iterate enemies with `pusher`, compute next fire beat using `PUSHER_BEAT_AUDIO_OFFSET = 0.37` (matches music kick AND wall spring offset). On fire: set `pusherLastFireBeat`, reset push tracker, run `tryPushPusher`.
2. **Pass 2 — grace window**: re-check overlaps for any pusher within `SPRING_GRACE_BEATS = 0.22` of fire. Same WeakMap-pushed-set pattern as walls.
3. **Pass 3 — audio pre-schedule**: 0.5 beat lookahead via `playWallSpringFire(t)`. Pusher reuses wall spring sound for now; could add `playPusherFire` later.

**`tryPushPusher`** (GameManager.ts ~1106) pushes player + OTHER enemies (self-exclusion) + orbs. Heavy enemies get 50% strength via `HEAVY_RESIST`. Same dash-interrupt logic on player.

Called from both real-game update loop AND designer update loop.

### Visual (Renderer.ts inside drawEnemy)

**Body pulse** (~line 5740): `r = enemy.radius × pusherVisScale` where pusherVisScale follows the same `(1-t)²` hammer profile as walls. Affects RENDERED radius only — `enemy.radius` (collision) is unchanged.

**Inner shockwave** (~line 6596): concentric ring expanding from enemy center, clipped to body circle. Same three-layer formula as walls but tinted to enemy identity color:
- **Glow** = `rgba(hr, hg, hb, 0.55 × alpha)` — pure enemy color
- **Core** = lerp 40% from enemy color toward `255,245,200` (gold)
- **Hot** = `rgba(255, 255, 245, 0.9 × alpha)` — pure white

Layer widths scale with enemy radius via same formula as walls.

### Designer UI (EnemyDesigner.ts)
- "Pusher" checkbox in trait grid (color `#FFB74D` orange)
- When on: reveals 3 sliders — Every N beats (0.25–16), Offset (0–16), Strength (50–2500)
- Read by `readForm()` and round-trips via `DesignedEnemy`

**IMPORTANT for future work**: there are TWO functions called `drawEnemy` and `drawShrine` in Renderer.ts both starting with `const sx = enemy.x - camX` etc. When editing, GREP for `^function drawEnemy` specifically — drawShrine is at line ~5325, drawEnemy is at line ~5737. Easy to edit the wrong one.

---

## 6. Battering ram separation — Enemy.ts + GameManager.ts

Launched entities now plow through other entities instead of being blocked by separation.

### Pattern (4-case `pushFrac`)

For any pair (A, B) where A is currently running its separation loop:

| A's state | B's state | A pushes self | B's own pass will do |
|-----------|-----------|---------------|---------------------|
| Normal    | Normal    | 0.5 (current) | 0.5 (sums to 1.0)   |
| **Launched** | Normal | **0** (carry momentum) | 1.0 (shoved aside) |
| Normal    | **Launched** | 1.0 (jumps out of way) | 0 (B keeps momentum) |
| Launched  | Launched  | 0.5 each | 0.5 each (mild nudge, mostly phase) |
| (any)     | **Immovable** | 1.0 (always blocked) | n/a |

### Enemy-vs-Enemy (Enemy.ts:768)
Inline 4-case `pushFrac` calculation. Bouncer enemies still get velocity reflection (line 775+) unchanged.

### Orb collisions (GameManager.ts ~947)
Extracted helper `resolveOrbCollision(orb, other, isEnemy, nx, ny, total)` because the orb pass exists in TWO places (designer update + real-game update) and they were near-duplicates. Helper applies the 5-case logic (4 above + immovable special case). Both call sites now ~5 lines each.

The orb pass pushes BOTH sides in one go (unlike Enemy.ts which pushes only self), so the helper takes `orbPush + otherPush` adding to `total` (or 0 if both stationary against immovable, or fully one-sided for launched cases).

### Safeguards against clipping
- Both-launched case = 0.5/0.5 (not 0/0) so they always push apart
- Immovable always wins — launched enemies never plow through walls or immovable enemies
- Non-launched side's own pass still runs normally → next-frame separation pulls overlapping pairs apart immediately when launch ends

---

## 7. Designer UI default state (EnemyDesigner.ts)

Enemy Designer and Upgrades (Test) sections both start COLLAPSED when the designer opens. Cleaner default for designer mode (Challenge Builder is what you actually want open).

- HTML: `<div id="ed-enemy-body" style="display:none;">` + arrow flipped `▼` → `▶`
- Same for `#ed-upgrade-body`
- `let enemySectionExpanded = false` (was `true`)
- `let upgradeSectionExpanded = false` (was `true`)

---

## 8. Revenge enemy spike glow polish (Renderer.ts ~6596)

Tried adding wide outer halo + radial gradient tip — felt blurry. Reverted those.

Final: just bumped existing glow and core alpha for more saturation without changing silhouette.
- Glow base alpha: 0.10 → 0.18
- Core base alpha: 0.25 → 0.45

Looks lit/saturated instead of smudged. Same change applied to designer preview (~line 7937).

---

## Key constants reference (current values)

| Constant | Location | Value | Purpose |
|----------|----------|-------|---------|
| `SPRING_TRIGGER_BUFFER` | GameManager.ts | 11 | Px buffer around wall/pusher trigger radius |
| `SPRING_GRACE_BEATS` | GameManager.ts | 0.22 | Beats after fire that the push stays active |
| `HEAVY_RESIST` | GameManager.ts | 0.5 | Immovable enemies absorb 50% of push strength |
| `BEAT_AUDIO_OFFSET` (springs) | Arena.ts | 0.37 | Spring fire alignment to music kick |
| `PUSHER_BEAT_AUDIO_OFFSET` | GameManager.ts | 0.37 | Same offset for pusher enemies |
| `AUDIO_LOOKAHEAD_BEATS` | GameManager.ts | 0.5 | How far ahead to pre-schedule audio |
| `STEER_ACCEL` (Player launch DI) | Player.ts | 8500 | Input acceleration during launch (px/s²) |
| `launchTimer` (applyLaunch) | GameManager.ts | 0.28s | Total launch duration |
| `LAUNCH_FADE_TAIL` | Player.ts/Enemy.ts/XPOrb.ts | 0.10s | Smooth fade-out tail at end of launch |
| Launch decay base | Player.ts/Enemy.ts/XPOrb.ts | 0.03 | Exponential decay rate (lower = faster falloff) |
| `pulseDur` (visual) | Renderer.ts | min(0.20, cycle × 0.30) | Wall/pusher body pulse duration |
| `pulseAmpl` (visual) | Renderer.ts | min(0.13, cycle × 0.13) | Wall/pusher body pulse amplitude (13% max) |
| Shockwave `shockDur` | Renderer.ts | min(0.22, cycle × 0.32) | Inner ring shockwave visual duration |
| Glow width | Renderer.ts | max(10, r × 0.60) | Wall/pusher shockwave glow layer |
| Core width | Renderer.ts | max(3.5, r × 0.24) | Wall/pusher shockwave bright core |
| Hot width | Renderer.ts | max(1.2, r × 0.08) | Wall/pusher shockwave razor highlight |

---

## Architecture patterns established

1. **Beat-locked fires**: every rhythm-locked sound uses `BEAT_AUDIO_OFFSET = 0.37s` (matches BeatLoop kick). NOT 0.45 (visual ring peak). Future on-beat triggers should use 0.37.
2. **Audio pre-scheduling**: schedule future audio via Web Audio API for sample-accuracy. Look ahead 0.5 beats. Cache scheduled beat per source to avoid double-scheduling.
3. **Grace window pattern**: WeakMap<source, Set<entities>> + remove-on-exit gives "one push per overlap, not one per fire."
4. **Battering ram pattern**: launched entities skip self-push; non-launched entities take full push. Symmetric for two-sided collision passes.
5. **Group propagation**: motion configs propagate to whole connected wall groups via `findConnectedWalls` flood-fill (designer-side) + `groupMotion` field (runtime-side).
6. **Visual scale ≠ collision scale**: enemy `pusherVisScale` affects rendered `r` only. `enemy.radius` stays canonical for collision/triggers.

---

## Open questions / future ideas

1. **Custom pivot point for rotation** — discussed but not implemented. Plan: `pivotOffsetX/Y` field on `WallMotion`, stored RELATIVE to bbox origin so prefabs survive. Designer UX: click endpoint to snap, or click empty space to set arbitrary, with yellow diamond visual marker. Would unlock: hinged gates, orbiting walls, sweeping arms.
2. **Pendulum easing options** — current is sine (smooth). Could add linear or step variants.
3. **Pusher enemy dedicated sound** — currently reuses `playWallSpringFire`. A higher-pitched variant would differentiate.
4. **Chain reaction push** — if launched A hits B, should B inherit some of A's launch energy? Default chose NO (cleaner physics). User confirmed.
5. **Pusher enemy designer preview animation** — currently the trait shows up in designer but the preview enemy doesn't fire/pulse since there's no beat clock for it. Would require simulating a beat clock for preview.
6. **Pendulum with custom pivot** — combining motion + pivot would give the most-requested visuals (sweeping arm hinged at one end, etc.). Phase 2 plan.

---

## File guide for future sessions

| Area | File(s) |
|------|---------|
| Wall geometry / motion / collision | `src/game/Arena.ts` |
| Spring & pusher fire logic + launch + battering ram orb helper | `src/core/GameManager.ts` |
| Enemy runtime (separation, launch integration, traits) | `src/entities/Enemy.ts` |
| Enemy type definitions (saved schema) | `src/entities/EnemyTypes.ts` |
| Player launch + DI + lockout | `src/entities/Player.ts` |
| Orb launch + integration | `src/entities/XPOrb.ts` |
| All rendering (wall shockwave, enemy pulse, indicators) | `src/render/Renderer.ts` |
| Designer panel UI for enemies + walls | `src/game/EnemyDesigner.ts` |
| Designer state for wall placement + prefabs | `src/game/ChallengeBuilder.ts` |
| Audio synth (spring fire sound) | `src/audio/AudioEngine.ts` |

## Debugging tips

- **TypeScript pre-existing errors**: 3 errors persist in `Arena.ts:513`, `Arena.ts:567`, `ChallengeBuilder.ts:541` — all `bend` field optional-property strictness. Not from this session. Ignore unless asked.
- **drawEnemy vs drawShrine confusion**: both functions start with the same prefix. Use `^function drawEnemy` grep to find the right one.
- **Wall import in Renderer.ts**: added `import type { Camera, Wall } from '../game/Arena.ts'` — was missing, caused TS errors before.
- **groupMotion vs motion**: runtime ALWAYS reads `groupMotion`. Designer reads `motion` but propagates via `setSelectedWallMotion`. Don't mix.

---

# Dev Journal — 2026-05-30

Session focused on Reverb game-changer iteration and a broader collision-system fix for "stuck between heavies." Reverb evolved from an instant damage-replacement to a time-swept push wave with edge-riding physics and bouncer redirect; collision system unified around a single `HEAVY_YIELD` knob.

---

## 1. Reverb diagnostic — why edge enemies didn't budge

Symptom: enemies clearly hit by the Reverb wave edge weren't moving, especially big ones and worse with beat-blast upgrades. Traced three compounding causes:

1. **Launched ring fights itself** (the main culprit, `Enemy.ts` separation). Reverb launches the whole outer ring on the same frame; in separation, two enemies that were BOTH launched used `pushFrac = 0.5`, half-shoving each other every frame. A big enemy overlapping many neighbors had summed inward shoves cancelling its own outward launch. **Fix**: both-launched → `pushFrac = 0` (phase through each other; re-separate normally once launches expire).
2. **Heavy resist halving**. Shared `HEAVY_RESIST = 0.5` made immovable enemies barely move at the edge. **Fix**: introduced local `REVERB_HEAVY_RESIST` (started 0.7, later 0.6) — Reverb is the player's signature knockback so heavies should still clearly fly.
3. **Arena/wall clamp** — physical limit. Radial push throws edge enemies *toward* the nearest wall; a big enemy's large radius means the clamp pins it well before the visible boundary. Couldn't be eliminated, but mitigated by edge-slide (see §3).

---

## 2. Time-swept Reverb wave

User: the push was instant on detonation while the visual ring swept outward over ~0.2s — enemies got pushed before the visual reached them. Restructured as a time-swept wave that lands in lockstep with the cyan ring.

### `ShockWave` system (`GameManager.ts`)
- Interface: `{x, y, pushRadius, pushStrength, edgeFrac, heavyResist, elapsed, pushedEnemies: WeakSet, pushedOrbs: WeakSet}`
- `spawnShockWave()` registers from `detonateBeatDash`
- `updateShockWaves(dt)` advances `elapsed`, computes `frontRadius`, pushes any entity whose body the front has just reached (then `WeakSet`-marks them so they're only pushed once)
- Wired into both designer and main update loops + reset on restart

### Timing mirrors Renderer's leading ring
- `SHOCK_WAVE_DURATION = 0.42` (= Renderer `SHOCK_PUSH_DURATION`)
- `SHOCK_WAVE_TRAVEL = 0.5` (= Renderer `RING_TRAVEL`)
- `SHOCK_WAVE_TRAVEL_TIME = 0.21s` for front to sweep center → edge
- Same ease-out: `frontRadius = pushRadius × (1 − (1 − frontProg)^2.4)`

Detection: an entity is pushed when `dist − entity.radius ≤ frontRadius` (body-contact, not center-based) so big enemies the wave visibly grazes still qualify.

---

## 3. Edge-riding launch slide

Pushed enemies stalled when rammed into walls (clamp ate the launch every frame). Added a velocity-space slide so launched entities ride the edge with whatever tangential momentum the approach angle preserves — like the player dash, but velocity-space instead of position-space.

### `slideLaunchAlongWall(enemy, pushX, pushY)` (`Enemy.ts`, above `updateEnemy`)
The wall's correction vector `(pushX, pushY) = corrected − pre` IS the local outward normal — works for curved (circle arena) and straight/angled edges automatically. If `dot(launchV, normal) < 0` (launch driving into wall), strip that component; keep tangential.

Wired into 3 spots in `updateEnemy`:
- Immovable wall block (early-return path)
- Arena clamp
- Internal wall collision

Covers wall-springs, Reverb, and pusher launches automatically — they all funnel through `launchVx/Vy`. Bouncer `bounceVx` stays a separate channel that still reflects off walls (intentional — bouncers bounce).

---

## 4. Reverb tuning

- `pushRadius`: `radius × 2.0` → `× 2.5` → `× 2.75`
- `REVERB_HEAVY_RESIST`: 0.7 → 0.6
- `PUSH_EDGE_FRAC = 0.35` (rim floor)
- Push strength now scales with upgrades via `pushScale = sqrt(beatBlastMult × aoeMult)` — dampened sqrt curve. Base ×1.00, Quiet Storm alone ×1.41, Quiet Storm + max beat blast ×1.73.
- `pushScale` threaded through `detonateBeatDash` (new optional param) and `PendingDetonation` (new field) so Aftershock detonations use the scale captured at dash time, not whatever upgrades exist at detonate time.

---

## 5. Reverb orb behavior

User design: the AOE damage blast was what collected orbs; Reverb replaces that blast, so it should NOT collect — just push, and the player's ring pulse picks orbs up normally. Any orbs the wave nudges into the ring get collected naturally.

Gated the orb-collect loop in `detonateBeatDash` behind `if (!reverbActive)`. Orbs in the outer push ring (between collect radius and 2.75× push radius) get shoved instead of vacuumed.

---

## 6. Bouncer redirect on any push

Bouncing enemies use a separate `bounceVx/bounceVy` patrol channel. Without intervention a pushed bouncer would snap back to its old patrol direction once the launch decayed.

Added at the end of `applyLaunch`: if entity has `movePattern === 'bounce'`, re-aim `bounceVx/Vy` to the push direction at constant `moveSpeed`. Covers all three push sources in one place:
- Wall spring → bouncer continues traveling the way it was shoved
- Reverb → bouncer's patrol re-aims outward
- Pusher enemy → bouncer's patrol re-aims along the push

Non-bouncers and orbs are skipped by the `movePattern === 'bounce'` guard.

---

## 7. Collision system unification — `HEAVY_YIELD`

Diagnosed why orbs/enemies got stuck between heavies (sandwich case). Audit found **five separation passes** per frame, with inconsistent rules:

| Pass | Location | Heavy-vs-normal (before) |
|------|----------|--------------------------|
| Enemy.ts in-line | `Enemy.ts:784-845` | Normal yields 100%, heavy unmoved |
| Main loop "immovable" pass | `GameManager.ts:2415-2458` | Heavy 5% / normal 95% ✓ |
| Main loop enemy-vs-enemy | `GameManager.ts:2461-...` | Normal yields 100%, heavy unmoved |
| Designer enemy-vs-enemy | `GameManager.ts:1610-1645` | Normal yields 100%, heavy unmoved |
| `resolveOrbCollision` | `GameManager.ts:1084-1111` | Orb yields 100%, heavy unmoved |

Only the main-loop "immovable" pass had a 5/95 split. Everywhere else, two heavies could sandwich a normal/orb and the corrections from each side would oscillate the trapped entity in place forever. Orbs were the worst — NO 5%-drift existed for them anywhere, so an orb wedged between two heavies (or heavy + wall) was permanently stuck.

### Fix
Added `HEAVY_YIELD = 0.05` to `constants.ts` as the single tunable knob. Applied 95% / 5% split at all five spots so heavies absorb a small fraction of separation overlap — sandwich gap widens over a few frames, trapped entity escapes. Heavy still reads as "immovable" gameplay-wise (drift is bounded by the current overlap, self-limiting as gap opens).

Touch points:
- `resolveOrbCollision` immovable case: orb 95% / heavy 5%
- `Enemy.ts` in-line separation: branched immovable out so the heavy also moves 5% (existing pushFrac branches unchanged)
- Main loop enemy-vs-enemy immovable case: 95% / 5%
- Designer enemy-vs-enemy both `oe.immovable` and `enemy.immovable` branches: 95% / 5%
- Existing main-loop "immovable" pass: rewrote literal `0.05 / 0.95` to use `HEAVY_YIELD / (1 - HEAVY_YIELD)` — no behavior change, just unified the knob

Why no double-counting in practice: pass-2 runs first, widens the gap; later passes find no overlap and don't fire. Heavy-vs-heavy left at 50/50 split (no change needed). Player-vs-heavy (`GameManager.ts:1657-1663`) intentionally untouched — uses literal `0.15` (heavy moves 15%, player moves 85%) as a separate feel decision.

---

## Constants added this session

| Const | File | Value | Purpose |
|-------|------|-------|---------|
| `HEAVY_YIELD` | `constants.ts` | 0.05 | Heavy's share of positional separation overlap |
| `REVERB_HEAVY_RESIST` | `GameManager.ts` (local) | 0.6 | Reverb-specific heavy launch multiplier (shared HEAVY_RESIST is 0.5) |
| `SHOCK_WAVE_DURATION` | `GameManager.ts` | 0.42 | Mirrors Renderer SHOCK_PUSH_DURATION |
| `SHOCK_WAVE_TRAVEL` | `GameManager.ts` | 0.5 | Mirrors Renderer RING_TRAVEL |
| `SHOCK_WAVE_TRAVEL_TIME` | `GameManager.ts` | 0.21 | Front sweep time = duration × travel |
| `PUSH_EDGE_FRAC` | `GameManager.ts` (local) | 0.35 | Reverb rim push floor |

---

## Architecture patterns added

7. **Time-swept impulses**: instead of applying knockback instantly on detonation, register a wave with an expanding front and apply each entity's push when the front body-contacts it. `WeakSet` tracks already-pushed entities so each is only nudged once. Visual + physics stay in lockstep without sharing state — just matched timing constants.
8. **Velocity-space wall slide**: project the launch velocity onto the wall tangent using the position correction vector as the normal. Works for any edge shape (curved/straight/angled) automatically — no per-shape branching.
9. **Single-knob collision yield**: `HEAVY_YIELD` applied identically across all separation passes. Self-limiting (drift bounded by current overlap, shrinks as gap opens) so heavies still feel immovable.
10. **Channel separation for bounce vs launch**: `bounceVx/Vy` (patrol/reflect) and `launchVx/Vy` (push/decay) are independent integrations. A launched bouncer slides its launch off walls while its bounce reflects, no conflict. Push sources redirect bounce direction once, at the moment of launch.

---

## Open / followups

1. **Heavy-vs-wall wedges** (wall has zero compliance). Orb sandwiched between heavy and wall still tough — heavy can now drift, but wall doesn't. Could add a depenetration step that escalates push when overlap persists multiple frames.
2. **Player-vs-heavy feel** uses literal `0.15` (heavy moves 15%). Currently not unified with `HEAVY_YIELD` on purpose — it's a feel decision separate from anti-stuck. Worth revisiting if Player-vs-heavy starts feeling inconsistent.
3. **Pre-existing TS errors** have shifted with codebase growth — now at `Arena.ts:703`, `Arena.ts:794`, `ChallengeBuilder.ts:771` (same root cause: `exactOptionalPropertyTypes` on optional `bend` field).
- **Pusher fields on Enemy**: created in Enemy.ts constructor (~line 280). If you add new pusher fields, update both `EnemyType` (saved) AND `Enemy` (runtime) interfaces AND the constructor defaults.

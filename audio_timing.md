# Audio Timing in Resonance

This document is the single reference for how audio events are timed across the game. It covers the musical grid the design assumes, every compensation constant we use, where timing can drift, and the planned **TimingProbe** monitor that will let us catch regressions.

The goal of every system below is the same: **damage events and their sound effects must land exactly on a clean musical subdivision (beat, half-beat, or known stagger) — and the audio you hear must arrive in lock-step with the visual.**

---

## 1. The musical grid

- `MASTER_BPM = 60` → `BEAT_SEC = 1.0s` (constants in `utils/constants.ts`)
- A **whole beat** is 1.0s apart.
- A **half-beat** is 0.5s.
- The PatternClock (`audio/PatternClock.ts`) drives all beat-aligned events. It calls `shouldFire(patternName, leadSec)` once per pattern per beat-slot, returning true exactly once on the frame that's `leadSec` seconds before the scheduled beat.

Every other timing constant in the system is designed so that gameplay events fall on these subdivisions.

---

## 2. The fire-lead system — `RING_FIRE_LEAD_SEC = 0.23s`

**Defined in:** `core/PhaseSystem.ts`

This is the master "fire ahead of the beat" constant. It exists because rings and bullets need *time to expand or travel*, and we want the **damage moment** (peak of the ring, end of bullet travel, etc.) to land **on the beat**, not the spawn moment.

### How it works for in-place enemy rings
- A non-ranged enemy ring fires `RING_FIRE_LEAD_SEC = 0.23s` BEFORE its scheduled beat.
- The ring then expands for `ATTACK_EXPAND_TIME = 0.68s` (and reaches peak damage there).
- So peak lands at `beat - 0.23 + 0.68 = beat + 0.45` — close to (but not exactly on) the half-beat. The visual climax reads as "on rhythm" because 0.45s ≈ 0.5s.

### How it works for ranged enemy rings (bullets)
- Same 0.23s lead — bullets are spawned `0.23s before the scheduled beat`.
- Bullet travels for `bulletLifetime` seconds (designer-tunable, typically 1.0 or 1.5).
- Bullets **land** at `beat - 0.23 + bulletLifetime`.

For `bulletLifetime = 1.0s` (firing on beat N):
```
beat (N − 0.23)  bullet leaves enemy
beat (N + 0.77)  bullet lands (= ring start, = telegraph start)
beat (N + 1.0)   tether strikes (= ring sound "near peak") ← ON A WHOLE BEAT ✓
beat (N + 1.45)  ring peak (damage) ← ~on the next half-beat
```

For `bulletLifetime = 1.5s`:
```
beat (N − 0.23)  bullet leaves
beat (N + 1.27)  bullet lands
beat (N + 1.5)   tether strikes ← ON A HALF-BEAT ✓
beat (N + 1.95)  ring peak ← ~on a whole beat
```

The 0.23s lead is **the load-bearing constant** for the entire timing model. Every other tuning value descends from it.

---

## 3. Ring detonation timing

**Defined in:** `core/GameManager.ts` (bullet detonation), `core/PhaseSystem.ts`, `render/Renderer.ts` (`drawRing`)

When a bullet lands:
1. The detonation entity is created. `attackTimer = 0`.
2. `drawRing` renders an ease-out expansion: radius goes from 0 to `ringRadius` over `expandTime` (default `0.68s`).
3. At `attackTimer >= expandTime`, the **peak fires once** — this is the damage check.
4. The ring lingers visually for ~0.11s past peak (`ATTACK_LINGER_TIME`), then disappears.

**Important:** The visually-loud "kickstart" punch (white-gold flash) fires at **t=0 of the detonation** — i.e. at bullet landing. The eye reads this as "the ring hit." The actual silent damage check at `t=expandTime` is invisible — only the audio (now fired at peak, see §6) puts a "sound event" on that moment.

### Position lead — `LEAD_TIME = 0.015s`

When a bullet detonates, its visual position is nudged forward `b.x + b.vx * LEAD_TIME` (15ms of travel) to compensate for **motion-induced perceived position shift** (the brain extrapolates fast-moving objects ahead of their rendered position). This is a VISUAL adjustment only — does not affect timing of damage or sound.

---

## 4. Tether timing

**Defined in:** `core/GameManager.ts` (`PendingSalvo`, `TetherEntity`, `updateTethers`)

A tether is the damage geometry that snaps between salvo siblings at a clean rhythmic moment.

### The prearm window — `prearmTime = RING_FIRE_LEAD_SEC = 0.23s`

When the last bullet of a salvo lands:
1. A `TetherEntity` spawns with `timer = 0` and `prearmTime = 0.23s`.
2. While `timer < prearmTime`, the tether is **dormant** — invisible, no damage. The visible **red pulsing telegraph** is drawn during this window so the player has a continuous warning.
3. When `timer >= prearmTime`, the tether **materializes**: bright white-gold beams snap into place, damage window opens, and the tether sound fires.

The prearm value (`= RING_FIRE_LEAD_SEC`) is what locks the **tether strike** onto a clean beat. The math:
```
bullet lands at:  beat − 0.23 + bulletLifetime
tether strikes:   (bullet lands) + prearm = (beat − 0.23 + lifetime) + 0.23
              =  beat + bulletLifetime
              =  a clean subdivision for any lifetime that's a multiple of 0.5s
```

### Hit window — `TETHER_HIT_WINDOW = 0.10s`

After materialization, the tether is **damage-active** for 100ms (one-shot — can't tick the same player twice). The damage window matches the bright-flash phase of the visual.

### Visual lifetime — `TETHER_DUR = 0.20s`

The tether visual fully fades after 200ms post-materialization (separate from the hit window, longer than it).

---

## 5. Push mode timing

**Defined in:** `core/GameManager.ts` (`spawnShockWave`, `updateShockWaves`, `schedulePendingSound`)

A push-mode ring REPLACES the expanding damage ring with a Reverb-style shock wave. There's no ring peak to play sound on, but the sound still needs to land on a beat.

### Wave + sound separation

When a push-mode bullet lands:
1. A `ShockWave` spawns and starts pushing entities. Wave duration: `SHOCK_WAVE_TRAVEL_TIME = 0.21s`.
2. A **pending sound** is queued via `schedulePendingSound(delay, sound, patternName)` with `delay ≈ RING_FIRE_LEAD_SEC` (corrected for overshoot + audio latency — see §7).
3. The sound fires when its timer expires, ~0.23s after landing — same beat the tether would strike on.
4. The shock wave retires at 0.21s (well before the sound), so the sound queue is **decoupled** from the wave entity to survive past it.

### Why the offset

Without this, a push-mode ring would either:
- Play sound at landing (silent push wave still expanding — sound feels disconnected from the impact)
- Play sound at wave retirement (~0.21s, slightly off-beat)

By queuing for the canonical 0.23s point, push sounds align with tether sounds and the underlying beat grid.

---

## 6. Where each sound fires

| Event | Fire moment | Why |
|---|---|---|
| **Normal ring** (`detRs.sound`) | Ring peak (`attackTimer >= expandTime`) | The damage moment. Eye/ear sync to the visual climax. |
| **Tether strike** (`tetherSound`) | Tether materialization (`timer >= prearmTime`) | The damage moment. Aligns with the bright white-gold snap. |
| **Push ring** (`detRs.sound` via pending) | `landing + RING_FIRE_LEAD_SEC` (~0.23s, corrected) | The "would-be tether" moment — clean beat alignment. |
| **Player damage** (`playPlayerHit`) | Immediately at hurt | Reaction sound — no delay needed. |
| **Pattern tick** (PatternClock) | At each beat-slot's `shouldFire` | The ring's signature "beat" sound; plays at FIRE time, not damage time. |

Tether and ring sounds can be configured separately per layer in the designer (Tether Sound dropdown alongside Ring Sound).

---

## 7. Drift compensations

Three independent compensations stack to keep the timing tight:

### 7a. Bullet frame overshoot — `b.elapsed - b.lifetime`

The bullet detonates when `b.elapsed >= b.lifetime`. Because we only check once per frame, the actual detonation happens **on the first frame past lifetime** — i.e. up to `dt` (~16ms at 60fps) late.

To compensate:
```ts
const overshoot = b.elapsed - b.lifetime   // 0 to dt
// All scheduled timers subtract this overshoot:
schedulePendingSound(RING_FIRE_LEAD_SEC - overshoot, ...)
```

Now the queued delay targets the ideal beat moment, not the already-late detonation moment.

### 7b. Cluster generation overshoot propagation

Without this, each cluster generation accumulates ~16ms of slop:
- Gen 1: +16ms drift
- Gen 2: +32ms drift
- Gen 3: +48ms drift

Fix: when spawning a child salvo from a parent's detonation, pass the parent's overshoot as the child's **starting elapsed**:
```ts
const parentOvershoot = Math.max(0, b.elapsed - b.lifetime)
spawnSalvo(..., parentOvershoot)
// Inside spawnSalvo:
enemyBullets.push({ elapsed: startElapsed, ... })
```

The child bullet's clock starts "already late by parent's slop," so when it detonates `(lifetime - parentOvershoot)` seconds later, total absolute time matches the ideal. The slop never accumulates.

Net: every cluster generation lands within ±8ms of its ideal beat, regardless of depth.

### 7c. Half-frame snap in `updatePendingSounds`

In the pending-sound queue, we check `if (ps.timer <= dt * 0.5)` BEFORE decrementing — this picks whichever frame is **closer to the ideal trigger moment** (could be slightly early OR slightly late by less than half a frame), instead of always being slightly late.

This roughly halves the average error from `±dt/2` (~8ms) to `±dt/4` (~4ms).

### 7d. Web Audio buffer compensation — `PUSH_SOUND_AUDIO_LATENCY = 0.015s`

Web Audio adds inherent buffer latency from the `playEnemyBeatTick` call to the actual speaker output (typically 10-30ms depending on browser/OS/hardware). For push-mode ring sounds, we **subtract another 15ms** at queue time so the audio arrives in lock-step with the intended beat:

```ts
schedulePendingSound(
  RING_FIRE_LEAD_SEC - overshoot - PUSH_SOUND_AUDIO_LATENCY,
  detSound, detPatternName
)
```

**Note:** this compensation is currently push-only. It hasn't been added to tether and ring-peak sounds because those play through the same `playEnemyBeatTick` path and would have the same latency. We may want to apply a unified compensation across all damage-aligned sounds — the TimingProbe (§9) will tell us.

---

## 8. Known sources of error

| Source | Magnitude | Compensated? |
|---|---|---|
| Frame slop on bullet detonation | up to 1 frame (~16ms) | ✅ via §7a |
| Frame slop accumulation across cluster generations | up to 16ms × depth | ✅ via §7b |
| Frame slop on pending sound countdown | average ~8ms | ✅ via §7c (halved to ~4ms) |
| Web Audio buffer latency | 10-30ms | ⚠️ only push-mode (§7d). Tether and ring-peak sounds may inherit the uncompensated buffer delay. |
| Variable framerate (dt jitter) | small but unpredictable | ❌ Not compensated. Could add absolute-time tracking if it becomes a problem. |
| AudioContext sample alignment | usually ~5ms | ❌ Not compensated. Web Audio rounds to its sample clock. |

The first three are bounded and small. The Web Audio latency is the biggest remaining source of perceived drift and is the main thing the TimingProbe will help us measure.

---

## 9. TimingProbe — the planned monitoring system

### Goal

A dev-only system that records the **expected** and **actual** fire time of every prioritized audio event, computes drift from both the intended moment and from the nearest beat, and surfaces discrepancies in a live overlay + console warnings.

Priority events:
1. **Attacks** (bullet ring peak, push ring sound)
2. **Player damage**
3. **Tether strikes**

### Architecture

**Single file**: `src/core/TimingProbe.ts` (~150 LOC). Self-contained, can be deleted to remove the system entirely.

**API surface (3 functions)**:
```ts
markScheduled(kind, label, expectedAt): number   // returns probe ID
markFired(probeId): void                          // call adjacent to playEnemyBeatTick
drawTimingProbeOverlay(ctx): void                 // once per frame from main render
```

**Data model**:
```ts
interface TimingEvent {
  id: number
  kind: 'attack' | 'playerHit' | 'tether'
  label: string                  // "bullet#42 ring peak"
  expectedAt: number             // game time, ms
  firedAt: number | null         // null until markFired
  expectedDrift: number | null   // firedAt − expectedAt
  beatDrift: number | null       // |firedAt − nearestBeat|
  beatFraction: number | null    // signed position within beat (−0.5 to +0.5)
}
```

Stored in a **rolling buffer of 100** events — no unbounded growth.

### Instrumentation points (4 sites, ~10 LOC added total)

| Subsystem | markScheduled | markFired |
|---|---|---|
| Bullet ring peak | bullet detonation in `updateEnemyBullets`: `expectedAt = now + expandTime` | inside `updateEnemyDetonations` when `peakFired` flips true, before `playEnemyBeatTick` |
| Push ring sound | when `schedulePendingSound` queues: `expectedAt = now + RING_FIRE_LEAD_SEC` | inside `updatePendingSounds` right before `playEnemyBeatTick` |
| Tether strike | when `TetherEntity` spawns: `expectedAt = now + prearmTime` | inside `updateTethers` when `soundFired` flips true |
| Player damage | inside `hurtPlayer` (immediate fire) | same call site (drift = 0; control reference) |

### Thresholds

- **Green**: drift within ±10ms
- **Yellow**: ±25ms
- **Red**: >±25ms → `console.warn("[TIMING] tether#17 strike fired 38ms after expected, 22ms off nearest beat")`

### Dev overlay (top-right, `~` toggles)

```
TIMING PROBE                          [~ to hide]
───────────────────────────────────────────────
Last 10 events                                
                                              
 ATK  bullet#84 ring peak     +4ms   beat −2ms 
 TET  tether#42 strike        +8ms   beat −6ms 
 PSH  bullet#83 push ring     +6ms   beat +1ms 
 HIT  player damage           ~      n/a       
 TET  tether#41 strike        +9ms   beat −7ms 
 ATK  bullet#82 ring peak    +12ms   beat −11ms
 ...                                            
                                              
Last 30s aggregate:                          
  attack:  avg=+8ms  max=+24ms  red=0%      
  tether:  avg=+9ms  max=+18ms  red=0%      
  hit:     avg=±0ms  max=±1ms                 
```

Color codes per drift column. Aggregate stats show the running average + worst-case + red-zone percentage per kind.

### Beat-drift math

```ts
function calcBeatDrift(t: number): { drift: number, fraction: number } {
  const phase = (t / BEAT_SEC) % 1
  // Snap to nearest beat OR half-beat (whichever's closer)
  const nearestSub = Math.round(phase * 2) / 2   // 0, 0.5, 1
  const fraction = phase - nearestSub
  return {
    drift: Math.abs(fraction) * BEAT_SEC * 1000,   // ms
    fraction                                        // signed
  }
}
```

Signed `fraction` lets us spot systematic biases ("always firing 6ms past the half-beat") even if absolute drift is in tolerance.

### Production cost: zero

All exports go through `__DEV__` guards. In production builds, Vite tree-shakes the probe entirely. Mark calls become noops; overlay never renders.

### Build order

1. **Create `TimingProbe.ts`** — API, storage, beat math, overlay renderer (60-90 min).
2. **Add 4 instrumentation pairs** at the audio sites listed above (~15 min).
3. **Wire the toggle key + overlay** into the dev render path (10 min).
4. **Run a test** — Ranged + Push + Tether + cluster enemy. Observe drift patterns.
5. **Iterate compensations** — if a pattern emerges (e.g. "tether sounds consistently +12ms"), bias the relevant constant (§7d, §7a, etc.) by the observed amount.

### What we'll learn

- Are tether sounds actually landing on beat? (Verifies §4 design.)
- Is `PUSH_SOUND_AUDIO_LATENCY = 0.015s` right, or should it be 0.020/0.025?
- Should the same latency compensation be applied to tether/ring-peak sounds?
- Does drift increase with cluster depth? (Should be flat after §7b — verify.)
- Are there occasional outliers? (frame drops, audio buffer hiccups.)

Once the data is green and stable, the overlay can be toggled off and the probe just sits dormant until the next round of timing work surfaces a regression.

### Optional add-ons (post-v1)

- Snapshot button → copies last 30s of events to clipboard
- Filter to "red only" → focus on problems
- CSV export for offline analysis

---

## 10. Quick reference — all timing constants

| Constant | Value | Location | Role |
|---|---|---|---|
| `MASTER_BPM` | 60 | `utils/constants.ts` | Beats per minute |
| `BEAT_SEC` | 1.0 | `utils/constants.ts` | Seconds per beat (derived from BPM) |
| `RING_FIRE_LEAD_SEC` | 0.23 | `core/PhaseSystem.ts` | How early bullets/rings fire to land on-beat |
| `ATTACK_EXPAND_TIME` | 0.68 | `core/PhaseSystem.ts` | Default ring expansion time (start → peak) |
| `ATTACK_LINGER_TIME` | 0.11 | `core/PhaseSystem.ts` | Visual ring linger past peak |
| `TETHER_HIT_WINDOW` | 0.10 | `core/GameManager.ts` | Tether damage window post-materialization |
| `TETHER_DUR` | 0.20 | `core/GameManager.ts` | Tether visual lifetime post-materialization |
| `LEAD_TIME` | 0.015 | `core/GameManager.ts` | Visual-only bullet detonation position lead |
| `PUSH_SOUND_AUDIO_LATENCY` | 0.015 | `core/GameManager.ts` | Web Audio buffer compensation (push sounds) |
| `SHOCK_WAVE_TRAVEL_TIME` | 0.21 | `core/GameManager.ts` | Push wave front sweep duration |

---

## Summary

The timing model is built on one load-bearing decision: **bullets fire 0.23s before their scheduled beat** so that bullet landing + an appropriate amount of expansion/prearm time arrives back on a clean beat or half-beat.

Every other timing constant exists to either:
- **enforce** that ideal moment (`prearmTime = RING_FIRE_LEAD_SEC`, `schedulePendingSound(RING_FIRE_LEAD_SEC - ...)`)
- **compensate** for frame slop or audio latency (`b.elapsed - b.lifetime`, `dt * 0.5` snap, `PUSH_SOUND_AUDIO_LATENCY`, cluster overshoot propagation)
- **shape** the visual that the audio attaches to (`ATTACK_EXPAND_TIME`, `TETHER_HIT_WINDOW`, `LEAD_TIME`)

The TimingProbe will give us first-hand data on whether these compensations are sufficient — and where additional bias may need to be added.

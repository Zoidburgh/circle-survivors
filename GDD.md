# Circle Survivors — Game Design Document v0.4

*Living document. Updated to reflect current prototype state.*

---

## 1. Vision

Circle Survivors is a top-down 2D roguelike where you are a circle fighting waves of enemies with an auto-pulsing attack ring. Combat is rhythm-based — your ring expands on a fixed beat, dealing damage to anything on its edge. Positioning and timing are everything.

**Core Promise:** You feel the rhythm of combat from the first second. Every enemy type adds a new beat to the polyrhythm. Skilled play looks and sounds like music.

### Design Pillars

1. **Rhythm is combat** — Your attack pulses on a beat. Enemies pulse on their own beats. The battlefield is a polyrhythmic composition.
2. **Positioning is skill** — No aim, no attack button. Your ring auto-fires. The skill is being in the right place when it does.
3. **Modular bottom-up** — Every mechanic works standalone before being composed. New systems layer on top of proven ones.
4. **Survivors-style progression** — Waves of enemies, upgrade choices between waves, build synergies, survive as long as possible.

---

## 2. Core Mechanics

### 2.1 The Pulse Ring (Auto-Attack)

The player emits a circular ring that expands outward on a fixed tempo synced to a global BPM. At peak expansion, anything on the ring edge takes damage. The ring then resets and starts expanding again.

| Property | Current Value |
|---|---|
| Tempo | 1 beat (BEAT_SEC, derived from MASTER_BPM=30) |
| Expand duration | 1.0 seconds |
| Damage moment | At peak expansion (ATTACK_EXPAND_TIME) |
| Hitbox | Ring edge ± enemy body radius |
| Max radius | 180 world units |

The player does NOT press a button to attack. The ring pulses automatically. The skill is positioning.

### 2.2 Dash

The player's active ability. A quick burst of movement in the current direction.

| Property | Current Value |
|---|---|
| Distance | 260 units |
| Duration | 0.5 seconds |
| Charges | 2 (upgradeable) |
| Recharge | 3 seconds per charge |
| Input | LMB or Space |
| Cancel | Can dash mid-dash if charges available |

Dash has a smooth sin-curve speed profile — accelerates, peaks, decelerates. Leaves afterimage trail. Green orbiting dots show available charges.

### 2.3 Movement

WASD, 280 units/sec. Subtle cyan afterimage trail while moving.

---

## 3. Rhythm System

### 3.1 Global BPM

All timing derives from `MASTER_BPM` (currently 30). One constant controls the speed of the entire game.

- `BEAT_SEC = 60 / MASTER_BPM` = seconds per beat
- Player tempo = `BEAT_SEC * 1` (quarter note)
- Enemy tempos = multiples of BEAT_SEC (whole, half, quarter, eighth, sixteenth)

### 3.2 Rhythm Clock

A global `RhythmClock` tracks elapsed time. All entities sync their phase to it via `getPhaseForTempo(tempo)`. This means:

- All enemies of the same type pulse in perfect sync regardless of spawn time
- Player and enemies are always in musical time with each other
- Spawning a mix of types creates genuine polyrhythm

### 3.3 Attack Animation

All rings (player and enemy) use identical animation timing:
- 1.0s ease-out expansion
- 0.05s hold at peak
- Particle burst at peak
- Instant reset

This is consistent across all entity types — a Whole note enemy and a Sixteenth note enemy have the same visual attack. Only the interval between attacks differs.

---

## 4. Enemy Types

All enemies are circles. Each type has a distinct color, size, speed, tempo, and audio frequency.

| Type | Key | Tempo | Color | Radius | Speed | HP | Ring | Audio |
|---|---|---|---|---|---|---|---|---|
| Whole | 1 | 4 beats | Red #EF5350 | 64 | 20 | 5 | 220 | 80hz |
| Half | 2 | 2 beats | Orange #FF9800 | 52 | 40 | 3 | 160 | 130hz |
| Quarter | 3 | 1 beat | Yellow #FFEB3B | 44 | 70 | 2 | 110 | 220hz |
| Eighth | 4 | 0.5 beats | Green #66BB6A | 36 | 120 | 1 | 70 | 370hz |
| Sixteenth | 5 | 0.25 beats | Purple #AB47BC | 28 | 180 | 1 | 45 | 520hz |

Design pattern: slow enemies are big, tanky, with huge attack range. Fast enemies are small, fragile, with short range but get in your face.

### 4.1 Enemy Behavior

- Move toward player, stop at ring attack sweet spot (85% of ring radius)
- Hard collision with other enemies (no overlap, edges touch)
- Hard collision with player body
- Sync beat to global rhythm clock

---

## 5. Player

| Property | Value |
|---|---|
| Shape | Filled circle |
| Radius | 43 |
| HP | 1000 (testing, ~5-10 for release) |
| Speed | 280 units/sec |
| Damage | 1 per hit |
| HP display | Pie chart on body, smooth drain |

---

## 6. Visual Design

- Dark void background (#0D0A1A) with subtle grid
- All entities are filled circles with colored outlines
- Rings expand outward, particle trail during expansion, burst at peak
- Red flash ring at damage moment (hitbox visualization)
- Yellow tint on enemies when player ring passes over them
- Red flash on entities when damaged
- Enemy HP shown as pie chart on body (smooth drain)
- Player dash: afterimage trail + orbiting charge dots (green = ready)
- Death animation: dissolve into scattered particles

### 6.1 Color Language

| Element | Color | Meaning |
|---|---|---|
| Player | Cyan #4FC3F7 | Always you |
| Dash charges | Green #64FF78 | Ready to use |
| Enemy hit flash | Red #FF3333 | Damage taken |
| Yellow tint | #FFE664 | Ring passing over (about to hit) |

---

## 7. Audio Design

Audio is mechanical feedback, not cosmetic. Each game event has a distinct sound.

| Event | Sound | Purpose |
|---|---|---|
| Player hit (connected) | 3-osc impact (square snap + sine + sub) | Satisfying crunch |
| Player miss | Hollow descending thud | "You whiffed" |
| Enemy killed | Rising pitch 440→880hz | Reward |
| Player damaged | Heavy low thud (triangle 65 + saw 90) | Danger |
| Enemy beat tick | Square wave at enemy's frequency | Hear the rhythm |
| Dash | Airy whoosh (detuned sawtooths sweeping down) | Speed |

Audio compressor on master output prevents clipping. Enemy ticks throttled to max ~20/sec.

---

## 8. Architecture

### 8.1 File Structure
```
src/
  core/
    GameLoop.ts        — Fixed 120hz timestep
    PhaseSystem.ts     — Beat detection, ring expansion curves
    RhythmClock.ts     — Global phase sync for all entities
    SpatialGrid.ts     — Broadphase for enemy separation (O(n log n))
    EventBus.ts        — Simple pub/sub
  entities/
    Player.ts          — Movement, dash, attack timer
    Enemy.ts           — AI, separation, attack timer, death
    EnemyTypes.ts      — Type definitions
    Ring.ts            — Pure data: phase, radius, tempo, color
  render/
    Renderer.ts        — Canvas2D, particles, all drawing
  audio/
    AudioEngine.ts     — Web Audio API, all sounds
  game/
    InputManager.ts    — Keyboard + mouse
  utils/
    constants.ts       — All tunable values
    math.ts            — Vec2, distance, hex conversion
  main.ts              — Entry point, event wiring, spawning
```

### 8.2 Performance

- SpatialGrid for enemy-enemy separation (avoids O(n²))
- Particle pool capped at 2000
- Enemy audio ticks throttled
- Audio compressor prevents clipping
- Fixed 120hz update, decoupled render

---

## 9. Roguelike Systems (TODO)

### 9.1 Wave System
- Spawn wave of enemies
- Clear wave → upgrade offer
- Next wave harder (more enemies, faster types, mixed types)
- Endless escalation

### 9.2 Upgrades (Modifiable Properties)

| Category | Examples |
|---|---|
| **Ring** | +radius, +damage, faster tempo, multi-ring |
| **Dash** | +distance, +charges, shorter recharge, dash damages |
| **Defense** | +HP, smaller hitbox, heal on kill, damage reduction |
| **Movement** | +speed, trail damages |
| **On-kill** | Chain explosions, heal, speed boost, ring reset |
| **On-beat** | Projectiles, shield pulse, area slow |

### 9.3 Other TODO
- Real HP values + death screen + restart
- Screen shake on damage
- Combo/score system
- Background parallax dots for movement feel
- Wave progression UI

---

## 10. Open Questions

- What's the right BPM for release? 30 feels good for testing but may need to be faster.
- How many enemy types before cognitive overload?
- Should dash have i-frames (invincibility during dash)?
- What's the upgrade offer format? 3 cards? Reroll?
- How does difficulty scale? More enemies? Faster BPM? New types?

---

*Circle Survivors. Position. Pulse. Survive.*

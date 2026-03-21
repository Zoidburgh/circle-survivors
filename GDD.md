# Circle Survivors — Game Design Document v0.5

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
| Tempo | 1 beat (BEAT_SEC, derived from MASTER_BPM=60) |
| Expand duration | 1.0 seconds |
| Damage moment | At peak expansion (ATTACK_EXPAND_TIME) |
| Hitbox | Ring edge +/- enemy body radius |
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

All timing derives from `MASTER_BPM` (currently 60). One constant controls the speed of the entire game.

- `BEAT_SEC = 60 / MASTER_BPM` = seconds per beat

### 3.2 Pattern-Driven Beat System

A `PatternClock` advances through a `SongPattern` that defines when each entity type fires. Patterns are arrays of beat positions within a loop (default 8 beats). All entities of the same type fire simultaneously when their beat position is reached.

- `SongPatterns.ts` defines available patterns (default: Player on every beat, Offbeat between beats)
- `PatternClock.ts` tracks loop position and determines which types should fire each tick
- `shouldFire(typeName)` returns true for all entities of that type simultaneously

This replaces per-entity tempo with a centralized, musical pattern system.

### 3.3 Attack Animation

All rings (player and enemy) use identical animation timing:
- 1.0s ease-out expansion
- 0.05s hold at peak
- Particle burst at peak
- Instant reset

This is consistent across all entity types. Only the interval between attacks differs (determined by the pattern).

---

## 4. Enemy Types

Enemy types are user-designed via the **Enemy Designer** (Tab to toggle). The default type is "Offbeat".

### 4.1 Enemy Designer

- In-game panel for creating custom enemy types
- Configure: name, color, sound, HP, speed, body size, ring range, spawn key, rhythm pattern
- Rhythm presets: offbeat, on-beat, half time, double time, backbeat, syncopated, triplet, sparse, gallop, custom
- Live preview orbits the player showing attack animation
- **Persistence:** designs auto-save to localStorage, can export/import as JSON files
- Saved enemies are restored on page load

### 4.2 Default Enemy Type

| Type | Key | Pattern | Color | Radius | Speed | HP | Ring | Sound |
|---|---|---|---|---|---|---|---|---|
| Offbeat | 1 | Between every player beat | Orange #FF9800 | 44 | 40 | 3 | 140 | rim |

### 4.3 Enemy Behavior

- Move toward player, stop at ring attack sweet spot (85% of ring radius)
- Hard collision with other enemies (no overlap, uses SpatialGrid)
- Hard collision with player body
- Pattern-driven beat firing (all enemies of same type fire together)

---

## 5. Arena System

| Property | Value |
|---|---|
| Size | 2000 x 1200 world units |
| Buffer zone | 80 units outside arena border (visible spawn area) |
| Camera | Brotato-style: smooth follow with movement lead (80 units ahead) |
| Camera smoothing | Exponential, frame-rate independent (factor * dt) |
| Border | Layered glow effect (cyan) with dashed outer buffer line |

Players are clamped inside the arena. Camera is clamped to show up to the buffer zone but not beyond.

---

## 6. Player

| Property | Value |
|---|---|
| Shape | Filled circle |
| Radius | 43 |
| HP | 1000 (testing, ~5-10 for release) |
| Speed | 280 units/sec |
| Damage | 1 per hit |
| HP display | Pie chart on body, smooth drain |

---

## 7. Visual Design

- Dark void background (#0D0A1A) with subtle grid
- All entities are filled circles with colored outlines
- Rings expand outward, particle trail during expansion, burst at peak
- Red flash ring at damage moment (hitbox visualization)
- Damage preview on enemies when player ring passes over them
- Red flash on entities when damaged
- Enemy HP shown as pie chart on body (smooth drain)
- Player dash: afterimage trail + orbiting charge dots (green = ready)
- Death animation: dissolve into scattered particles

### 7.1 Color Language

| Element | Color | Meaning |
|---|---|---|
| Player | Cyan #4FC3F7 | Always you |
| Dash charges | Green #64FF78 | Ready to use |
| Enemy hit flash | Red #FF3333 | Damage taken |

---

## 8. Audio Design

Audio is mechanical feedback, not cosmetic. Each game event has a distinct sound.

| Event | Sound | Purpose |
|---|---|---|
| Player beat | Kick drum | Rhythmic anchor |
| Player hit (connected) | Rising tone (330-500hz) | Satisfying feedback |
| Enemy killed | Rising pitch 440-880hz | Reward |
| Player damaged | Heavy low thud (triangle 65 + saw 90) | Danger |
| Enemy beat tick | Configurable per type (16 sound options) | Hear the rhythm |
| Dash | Airy whoosh (detuned sines sweeping down) | Speed |
| Attack windup | Quiet rising tone | Telegraph incoming |

### 8.1 Music System

- **MusicScale:** generates wave-specific music (root, mode, scale notes) from pentatonic scales
- **MusicDrone:** sustained root + fifth background drone with LFO breathing
- **MusicSynth:** kick, bass, chord, melody, pluck instruments
- Audio compressor on master output prevents clipping
- Enemy ticks throttled (0.04s min interval per type)
- Delay-based reverb on most sounds

---

## 9. Architecture

### 9.1 File Structure
```
src/
  core/
    GameLoop.ts        — Fixed 120hz timestep
    GameManager.ts     — Update + render orchestration
    GameState.ts       — Global state (player, enemies, grid, camera)
    PhaseSystem.ts     — Beat detection, ring expansion curves
    RhythmClock.ts     — Global phase sync for all entities
    SpatialGrid.ts     — Broadphase for neighbor queries
    EventBus.ts        — Simple pub/sub
  entities/
    Player.ts          — Movement, dash, attack timer
    Enemy.ts           — AI, separation, attack timer, death
    EnemyTypes.ts      — Type definitions (user-designed)
    Ring.ts            — Pure data: phase, radius, tempo, color
  render/
    Renderer.ts        — Canvas2D, particles, all drawing
  audio/
    AudioEngine.ts     — Web Audio API, all sounds
    MusicSynth.ts      — Synthesizer instruments
    MusicDrone.ts      — Background drone
    MusicScale.ts      — Scale/key generation
    PatternClock.ts    — Pattern-driven beat timing
    SongPatterns.ts    — Pattern definitions
  game/
    Arena.ts           — Arena bounds, camera, spawning
    InputManager.ts    — Keyboard + mouse
    HitDetection.ts    — Ring-entity collision (uses SpatialGrid)
    EnemyDesigner.ts   — In-game enemy type editor with persistence
  utils/
    constants.ts       — All tunable values
    math.ts            — Vec2, distance, hex conversion
  main.ts              — Entry point, event wiring, spawning
```

### 9.2 Performance

- SpatialGrid for enemy-enemy separation and hit detection (avoids O(n^2))
- Particle pool capped at 2000
- Enemy audio ticks throttled
- Audio compressor prevents clipping
- Fixed 120hz update, decoupled render

---

## 10. Roguelike Systems (TODO)

### 10.1 Wave System
- Spawn wave of enemies
- Clear wave -> upgrade offer
- Next wave harder (more enemies, faster types, mixed types)
- Endless escalation

### 10.2 Upgrades (Modifiable Properties)

| Category | Examples |
|---|---|
| **Ring** | +radius, +damage, faster tempo, multi-ring |
| **Dash** | +distance, +charges, shorter recharge, dash damages |
| **Defense** | +HP, smaller hitbox, heal on kill, damage reduction |
| **Movement** | +speed, trail damages |
| **On-kill** | Chain explosions, heal, speed boost, ring reset |
| **On-beat** | Projectiles, shield pulse, area slow |

### 10.3 Other TODO
- Real HP values + death screen + restart
- Screen shake on damage
- Combo/score system
- Background parallax dots for movement feel
- Wave progression UI

---

*Circle Survivors. Position. Pulse. Survive.*

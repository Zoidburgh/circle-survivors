# Circle Survivors — Claude Code Context

## Philosophy: Modular Bottom-Up Design

Every mechanic must feel good in isolation before composing with others. Validate feel first, then layer complexity.

**Core rule: Don't add a system until the systems beneath it are fun on their own.**

## Design Decisions (Locked)

- **No attack button.** Ring auto-pulses on rhythm. Skill is positioning.
- **Dash is the active ability.** LMB/Space, charge-based (2 charges, 3s recharge), can cancel mid-dash.
- **All enemies are circles.** Hitbox = what you see.
- **All timing derives from MASTER_BPM.** Change one number, everything scales.
- **Same-type enemies sync phase.** Spawn 5 Quarter enemies at different times, they all pulse together.
- **Attack animation is fixed duration** (1.0s expand) regardless of enemy tempo.
- **All art is procedural code.** Zero sprites, zero external assets.
- **All tunable values in constants.ts.**

## Stack

TypeScript 5 + Canvas2D + Web Audio API, bundled with Vite.

## Project Structure

```
src/
  core/       — GameLoop, PhaseSystem, RhythmClock, SpatialGrid, EventBus
  entities/   — Player, Enemy, EnemyTypes, Ring
  render/     — Renderer (Canvas2D + particle system)
  audio/      — AudioEngine
  game/       — InputManager
  utils/      — constants, math
  main.ts     — Entry point
```

## When Adding New Features

1. Does it work standalone? Test in isolation first.
2. Does it need a new constant? Put it in constants.ts.
3. Does it need a new sound? Add to AudioEngine.ts, respect the compressor/throttle.
4. Does it touch enemy types? Add to EnemyTypes.ts, not hardcoded.
5. Performance: use SpatialGrid for any O(n²) neighbor queries.

## Current State

- Auto-pulsing ring attack synced to global BPM
- 5 enemy types (Whole→Sixteenth) with distinct tempo/color/size/speed
- Dash with 2 charges, visual orbiting dots, burst particles
- Enemy separation via SpatialGrid
- HP pie charts (smooth drain) on player and enemies
- Hit/miss/kill/damage/dash audio with compressor
- Spawn panel (1-5 keys, 0 = 100 random)
- Next: wave system, upgrades, death/restart

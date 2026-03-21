# Circle Survivors — Claude Code Context

## Philosophy: Modular Bottom-Up Design

Every mechanic must feel good in isolation before composing with others. Validate feel first, then layer complexity.

**Core rule: Don't add a system until the systems beneath it are fun on their own.**

## Design Decisions (Locked)

- **No attack button.** Ring auto-pulses on rhythm. Skill is positioning.
- **Dash is the active ability.** LMB/Space, charge-based (2 charges, 3s recharge), can cancel mid-dash.
- **All enemies are circles.** Hitbox = what you see.
- **All timing derives from MASTER_BPM (60).** Change one number, everything scales.
- **Pattern-driven beat system.** PatternClock + SongPatterns define when each entity type fires. No per-entity tempo.
- **Attack animation is fixed duration** (1.0s expand) regardless of enemy tempo.
- **All art is procedural code.** Zero sprites, zero external assets.
- **All tunable values in constants.ts.**
- **Enemy types are user-designed via EnemyDesigner.** Default type is "Offbeat". Designs persist in localStorage and can be exported/imported as JSON.
- **Arena system.** Fixed 2000x1200 play area with Brotato-style camera (smooth follow with movement lead).

## Stack

TypeScript 5 + Canvas2D + Web Audio API, bundled with Vite.

## Project Structure

```
src/
  core/       — GameLoop, GameManager, GameState, PhaseSystem, RhythmClock, SpatialGrid, EventBus
  entities/   — Player, Enemy, EnemyTypes, Ring
  render/     — Renderer (Canvas2D + particle system)
  audio/      — AudioEngine, MusicSynth, MusicDrone, MusicScale, PatternClock, SongPatterns
  game/       — Arena, InputManager, HitDetection, EnemyDesigner
  utils/      — constants, math
  main.ts     — Entry point
```

## When Adding New Features

1. Does it work standalone? Test in isolation first.
2. Does it need a new constant? Put it in constants.ts.
3. Does it need a new sound? Add to AudioEngine.ts, respect the compressor/throttle.
4. Does it touch enemy types? Use the EnemyDesigner or modify EnemyTypes.ts.
5. Performance: use SpatialGrid for any O(n^2) neighbor queries.
6. Beat timing: add patterns to SongPatterns.ts, use PatternClock for firing.

## Current State

- Auto-pulsing ring attack synced to MASTER_BPM (60)
- Pattern-driven beat system (PatternClock + SongPatterns) controls when player and enemies fire
- Enemy Designer with persistence (localStorage + JSON export/import), default type is "Offbeat"
- Fixed arena (2000x1200) with Brotato-style camera (smooth follow + movement lead)
- Dash with 2 charges, visual orbiting dots, burst particles
- Enemy separation via SpatialGrid
- Hit detection uses SpatialGrid for broadphase
- HP pie charts (smooth drain) on player and enemies
- Hit/miss/kill/damage/dash audio with compressor + musical synth system (drone, bass, chords, melody)
- Spawn panel (key-based, 0 = 100 random)
- Next: wave system, upgrades, death/restart

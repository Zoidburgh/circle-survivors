// ── Loop ──
export const FIXED_HZ = 120
export const FIXED_DT = 1000 / FIXED_HZ

// ── Master BPM — everything derives from this ──
export const MASTER_BPM = 60   // game attack speed — don't change for music
export const BEAT_SEC = 60 / MASTER_BPM

// ── Ring ──
export const PLAYER_TEMPO = BEAT_SEC * 1
export const BEAT_PHASE = 0.85
export const BEAT_WINDOW_HALF = 0.1
export const MAX_RING_RADIUS = 180

// ── Spatial grid ──
export const GRID_CELL_SIZE = MAX_RING_RADIUS * 2

// ── Art ──
export const GRID_ALPHA = 0.15
export const GRID_CELL_PX = 64

// ── Colors ──
export const COLOR_PLAYER = '#00FFFF'
export const COLOR_BG = '#0D0A1A'

// ── Player ──
export const PLAYER_RADIUS = 43
export const PLAYER_SPEED = 280
export const PLAYER_MAX_HP = 8
export const PLAYER_BASE_DAMAGE = 1

// ── Gameplay tuning ──
export const HIT_FLASH_DURATION = 0.38
export const SPAWN_ANIM_DURATION = 0.4
export const HP_DRAIN_SPEED = 8
// Beat-dash AOE radius = ring.radius × this × beatBlastMult × (Quiet Storm 2×). Shared by the sim
// (GameManager) and the Quiet Storm charge telegraph (Renderer) so they can't drift apart.
export const BEAT_DASH_RADIUS_MULT = 0.77
export const PARTICLE_CAP = 1800
// Adaptive particle LOD — burst sizes scale DOWN as the live particle count climbs, so combat
// pile-ups (many deaths/detonations at once) stop flooding the pool and dropping frames. Full
// quality at/below SOFT, linear ramp to FLOOR by HARD. Tuned to where frames actually drop
// (~1100 live), well below the hard PARTICLE_CAP. Player-feedback effects are exempt.
export const PARTICLE_LOD_SOFT = 400
export const PARTICLE_LOD_HARD = 1500
export const PARTICLE_LOD_FLOOR = 0.25
// Weak-node beat pops happen on getAbsoluteBeats(), the raw scheduling beat. The FELT beat lands a
// touch earlier (audio latency + the game's ~50ms calibration), so shift the node beat forward by
// this many beats so pops sit on the felt beat. Tune to taste (+ = pop earlier).
export const WEAK_NODE_BEAT_OFFSET = 0.05
export const CAMERA_LEAD_AMOUNT = 80
// ── Camera smoothing ── (anti-jitter: lead only engages on SUSTAINED movement, not taps)
export const CAMERA_LEAD_GATE_K = 3.5        // low-pass rate for the speed gate (higher = reacts faster)
export const CAMERA_LEAD_GATE_LO = 0.5       // speed-fraction below which the lead is fully suppressed (kills tap-bounce)
export const CAMERA_LEAD_GATE_HI = 0.9       // speed-fraction at/above which the lead is at full strength
export const CAMERA_LEAD_SMOOTH_K = 4.0      // lead-vector ramp rate (frame-rate-independent)
export const CAMERA_FOLLOW_DEADZONE = 2.0    // px; camera holds still for movements smaller than this
export const ARENA_BUFFER = 80
export const HIT_GRACE = 2  // extra pixels on enemy/orb hitbox for easier hits (visual unchanged)
export const AUDIO_THROTTLE_INTERVAL = 0.04
// Heavies absorb a small fraction of positional separation overlap so anything wedged against
// them (orb between two heavies, normal enemy between heavy + wall, etc.) can carve its own
// space instead of oscillating forever. Heavies still read as "immovable" gameplay-wise —
// drift is bounded by the current overlap so it self-limits as the gap opens.
export const HEAVY_YIELD = 0.05

// Dash-shot projectile speed (Bolt upgrade). Normal Bolt flies 1 beat, so ~700px reach.
// Aftershock extends flight to 2 beats but slows speed to half (~350 px/s) so total distance
// stays the same — same destination, just lands a beat later. Quiet Storm doesn't change
// speed (only radius scales).
export const DASH_SHOT_SPEED = 700
// Bolt's explosion radius is bigger than a normal beat-dash blast — the projectile sells a
// chunkier boom at its destination than the in-place beat-dash. All other beat-dash scalings
// (beatBlastMult, Quiet Storm) still stack on top of this multiplier.
export const DASH_SHOT_RADIUS_MULT = 1.5

// ── Magnet ──
export const MAGNET_RANGE = 200      // pull radius in px
export const MAGNET_STRENGTH = 80    // pull speed in px/s

// ── Shield ──
export const SHIELD_MAX_CHARGES = 1
export const SHIELD_RECHARGE_TIME = 4.0       // seconds to regen one charge
export const SHIELD_BREAK_FLASH = 0.2         // visual break effect duration
export const SHIELD_ORBIT_RADIUS_OFFSET = 12  // px outside player body

// ── Ritual Nodes ──
export const RITUAL_NODE_RADIUS = 37
export const RITUAL_LOCK_FLASH = 0.3
export const RITUAL_COMPLETION_TIME = 0.5
export const SHOP_UPGRADE_COST = 1

// ── Chill / Frostbite upgrade ──
export const CHILL_SLOW_PER_STACK = 0.10   // 10% slow per stack
export const CHILL_MAX_STACKS = 5           // max stacks on a single enemy
export const CHILL_STACK_DECAY_TIME = 2.0   // seconds before one stack drops off

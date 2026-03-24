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
export const COLOR_PLAYER = '#4FC3F7'
export const COLOR_BG = '#0D0A1A'

// ── Player ──
export const PLAYER_RADIUS = 43
export const PLAYER_SPEED = 280
export const PLAYER_MAX_HP = 1000
export const PLAYER_BASE_DAMAGE = 1

// ── Gameplay tuning ──
export const HIT_FLASH_DURATION = 0.15
export const SPAWN_ANIM_DURATION = 0.4
export const HP_DRAIN_SPEED = 8
export const PARTICLE_CAP = 2000
export const CAMERA_LEAD_AMOUNT = 80
export const ARENA_BUFFER = 80
export const HIT_GRACE = 2  // extra pixels on enemy/orb hitbox for easier hits (visual unchanged)
export const AUDIO_THROTTLE_INTERVAL = 0.04

// ── Chill / Frostbite upgrade ──
export const CHILL_SLOW_PER_STACK = 0.10   // 10% slow per stack
export const CHILL_MAX_STACKS = 5           // max stacks on a single enemy
export const CHILL_STACK_DECAY_TIME = 2.0   // seconds before one stack drops off

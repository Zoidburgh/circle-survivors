// ── Loop ──
export const FIXED_HZ = 120
export const FIXED_DT = 1000 / FIXED_HZ

// ── Master BPM — everything derives from this ──
export const MASTER_BPM = 72
export const BEAT_SEC = 60 / MASTER_BPM

// ── Ring ──
export const PLAYER_TEMPO = BEAT_SEC * 1
export const BEAT_PHASE = 0.85
export const BEAT_WINDOW_HALF = 0.1
export const MAX_RING_RADIUS = 180

// ── Spatial grid ──
export const GRID_CELL_SIZE = MAX_RING_RADIUS * 2

// ── Art ──
export const GRID_ALPHA = 0.06
export const GRID_CELL_PX = 64

// ── Colors ──
export const COLOR_PLAYER = '#4FC3F7'
export const COLOR_BG = '#0D0A1A'

// ── Player ──
export const PLAYER_RADIUS = 43
export const PLAYER_SPEED = 280
export const PLAYER_MAX_HP = 1000
export const PLAYER_BASE_DAMAGE = 1

// High score system — local + online leaderboard

const SAVE_KEY = 'beatback_highscores'
const SCORE_SECRET = 'beatback2026'

// Set this to your Cloudflare Worker URL after deploying
let API_URL = ''

export function setLeaderboardUrl(url: string): void { API_URL = url }

export interface ScoreEntry {
  challengeName: string
  time: number
  date: string
  playerName: string
}

let localScores: ScoreEntry[] = []
let onlineScores: Map<string, ScoreEntry[]> = new Map()

export function loadScores(): void {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (raw) localScores = JSON.parse(raw)
  } catch { /* ignore */ }
}

function saveScores(): void {
  localStorage.setItem(SAVE_KEY, JSON.stringify(localScores))
}

async function computeHash(data: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(SCORE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Submit a score — saves locally and posts to online leaderboard */
export async function submitScore(challengeName: string, time: number, playerName = 'Player'): Promise<number> {
  const entry: ScoreEntry = {
    challengeName,
    time,  // already rounded by caller
    date: new Date().toISOString(),
    playerName: playerName.slice(0, 16),
  }

  // Save locally
  localScores.push(entry)
  saveScores()

  // Post to online leaderboard
  if (API_URL) {
    try {
      const hash = await computeHash(challengeName + ':' + time.toFixed(3) + ':' + playerName.slice(0, 16))
      await fetch(`${API_URL}/score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeName, time, playerName: playerName.slice(0, 16), hash }),
      })
      // Refresh online scores
      fetchOnlineScores(challengeName)
    } catch { /* offline, local score saved */ }
  }

  const challengeScores = getScoresForChallenge(challengeName)
  return challengeScores.findIndex(s => s.time === time && s.date === entry.date) + 1
}

/** Fetch online scores for a challenge */
export async function fetchOnlineScores(challengeName: string): Promise<void> {
  if (!API_URL) return
  try {
    const res = await fetch(`${API_URL}/scores?challenge=${encodeURIComponent(challengeName)}`)
    const data = await res.json() as ScoreEntry[]
    onlineScores.set(challengeName, data)
  } catch { /* offline */ }
}

/** Get merged top N scores (local + online, deduplicated by time+name) */
export function getScoresForChallenge(challengeName: string, limit = 30): ScoreEntry[] {
  const local = localScores.filter(s => s.challengeName === challengeName)
  const online = onlineScores.get(challengeName) ?? []

  // Merge and deduplicate — keep only the best time per player
  const all = [...local, ...online]
  const bestPerPlayer = new Map<string, ScoreEntry>()
  for (const s of all) {
    const existing = bestPerPlayer.get(s.playerName)
    if (!existing || s.time < existing.time || (s.time === existing.time && s.date < existing.date)) {
      bestPerPlayer.set(s.playerName, s)
    }
  }
  const unique = Array.from(bestPerPlayer.values())
  unique.sort((a, b) => a.time - b.time || a.date.localeCompare(b.date))

  return unique.slice(0, limit)
}

/** Get the best time for a challenge */
export function getBestTime(challengeName: string): number | null {
  const best = getScoresForChallenge(challengeName, 1)[0]
  return best ? best.time : null
}

/** Format time as M:SS (whole seconds aligned to beats) */
export function formatTime(time: number): string {
  const total = Math.ceil(time)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function hasOnlineScores(challengeName: string): boolean {
  return (onlineScores.get(challengeName)?.length ?? 0) > 0
}

const BANNED = ['fuck','shit','ass','dick','cock','pussy','bitch','slut','whore','cunt','nigger','nigga','faggot','fag','retard','rape','nazi','hitler','penis','vagina','cum','semen','porn','hentai','sex','tits','boob','kys','kms','stfu','gtfo']

export function isNameClean(name: string): boolean {
  const lower = name.toLowerCase().replace(/[^a-z]/g, '')
  return !BANNED.some(w => lower.includes(w))
}

export function clearScores(): void {
  localScores = []
  saveScores()
}

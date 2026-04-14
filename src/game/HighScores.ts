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
    time,
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

  // Merge and deduplicate
  const all = [...local, ...online]
  const seen = new Set<string>()
  const unique = all.filter(s => {
    const key = `${s.playerName}:${s.time.toFixed(3)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return unique.sort((a, b) => a.time - b.time).slice(0, limit)
}

/** Get the best time for a challenge */
export function getBestTime(challengeName: string): number | null {
  const best = getScoresForChallenge(challengeName, 1)[0]
  return best ? best.time : null
}

/** Format time as M:SS.cc */
export function formatTime(time: number): string {
  const mins = Math.floor(time / 60)
  const secs = Math.floor(time % 60)
  const ms = Math.floor((time % 1) * 100)
  return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`
}

export function clearScores(): void {
  localScores = []
  saveScores()
}

// Cloudflare Worker — Beatback Leaderboard API
// KV Namespace binding: SCORES

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MAX_SCORES = 30;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // POST /score — submit a score
    if (url.pathname === '/score' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { challengeName, time, playerName, hash } = body;

        if (!challengeName || typeof time !== 'number' || !playerName) {
          return new Response(JSON.stringify({ error: 'Missing fields' }), {
            status: 400,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        // Basic anti-tamper check
        const expectedHash = await computeHash(challengeName + ':' + time.toFixed(3) + ':' + playerName, env.SCORE_SECRET || 'beatback2026');
        if (hash !== expectedHash) {
          return new Response(JSON.stringify({ error: 'Invalid' }), {
            status: 403,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }

        // Get existing scores for this challenge
        const key = `scores:${challengeName}`;
        const existing = await env.SCORES.get(key, 'json') || [];

        // Add new score
        existing.push({
          playerName: playerName.slice(0, 16),
          time,
          date: new Date().toISOString(),
        });

        // Sort and keep top N
        existing.sort((a, b) => a.time - b.time);
        const trimmed = existing.slice(0, MAX_SCORES);

        await env.SCORES.put(key, JSON.stringify(trimmed));

        const rank = trimmed.findIndex(s => s.time === time && s.playerName === playerName.slice(0, 16)) + 1;

        return new Response(JSON.stringify({ rank, total: trimmed.length }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    // GET /scores?challenge=X — get leaderboard
    if (url.pathname === '/scores' && request.method === 'GET') {
      const challengeName = url.searchParams.get('challenge');
      if (!challengeName) {
        return new Response(JSON.stringify({ error: 'Missing challenge param' }), {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      const key = `scores:${challengeName}`;
      const scores = await env.SCORES.get(key, 'json') || [];

      return new Response(JSON.stringify(scores), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },
};

async function computeHash(data, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

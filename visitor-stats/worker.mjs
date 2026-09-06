// Page-view aggregates only. No visitor/event records, cookies or logging.
export const HOMEPAGE_ORIGIN = 'https://willchow66.github.io';
export const MAX_POINTS = 2000;
const BOT = /bot|crawler|spider|slurp|bingpreview|facebookexternalhit|headless|lighthouse|pagespeed|preview|curl|wget|python-requests|uptimerobot/i;
const PREFLIGHT_HEADERS = new Set(['content-type', 'dnt', 'sec-gpc']);

export const SQL = Object.freeze({
  totalHit: `INSERT INTO totals (id, views) VALUES (1, 1)
    ON CONFLICT(id) DO UPDATE SET views = views + 1`,
  pointHit: `INSERT INTO points (country, city, lat, lon, views) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(country, city, lat, lon) DO UPDATE SET views = views + 1`,
  totals: 'SELECT views FROM totals WHERE id = 1',
  points: `SELECT lon, lat, country, city, views FROM points
    ORDER BY views DESC, country, city, lat, lon LIMIT ?`,
});

function headers(request) {
  const result = new Headers({
    'Cache-Control': 'no-store',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.headers.get('Origin') === HOMEPAGE_ORIGIN) {
    result.set('Access-Control-Allow-Origin', HOMEPAGE_ORIGIN);
  }
  return result;
}

function reply(request, status, body, extra = {}) {
  const h = headers(request);
  for (const [key, value] of Object.entries(extra)) h.set(key, value);
  if (body !== undefined) h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: h });
}

function coordinate(value, maximum) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = String(value).trim();
  if (str.length > 24 || !/^-?\d+(?:\.\d+)?$/.test(str)) return null;
  const number = Number(str);
  if (!Number.isFinite(number) || Math.abs(number) > maximum) return null;
  return Math.round(number * 100) / 100 || 0;
}

function cityName(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 256).normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N} .,'’()\-]/gu, '').trim().slice(0, 80);
}

function geography(cf) {
  if (!cf || typeof cf !== 'object') return null;
  const country = typeof cf.country === 'string' ? cf.country.toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(country) || country === 'XX') return null;
  const lat = coordinate(cf.latitude, 90);
  const lon = coordinate(cf.longitude, 180);
  if (lat === null || lon === null) return null;
  return { country, city: cityName(cf.city), lat, lon };
}

// The IP is read transiently from Cloudflare's edge header. The rate limiter
// receives only a minute-rotated digest; neither is stored in our D1 database.
async function limited(request, env) {
  if (!env.HIT_RATE_LIMITER) return false; // Optional binding; see README.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || ip.length > 64) return false;
  const input = new TextEncoder().encode(`homepage-hit:${Math.floor(Date.now() / 60000)}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  return !(await env.HIT_RATE_LIMITER.limit({ key })).success;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function emptyBody(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && length !== '0') return false;
  if (request.body === null) return true;
  const reader = request.body.getReader();
  try {
    // Accept a truly empty stream, including a zero-byte chunk, without ever
    // collecting a payload. Cap reads so endless empty chunks cannot loop.
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) return true;
      if (value?.byteLength) return false;
    }
    return false;
  } finally {
    await reader.cancel();
  }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path !== '/hit' && path !== '/points') {
      return reply(request, 404, { error: 'Not found' });
    }
    const allowedMethod = path === '/hit' ? 'POST' : 'GET';

    if (request.method === 'OPTIONS') {
      if (request.headers.get('Origin') !== HOMEPAGE_ORIGIN) {
        return reply(request, 403, { error: 'Origin not allowed' });
      }
      const requestedHeaders = (request.headers.get('Access-Control-Request-Headers') || '')
        .toLowerCase().split(',').map(h => h.trim()).filter(Boolean);
      if (request.headers.get('Access-Control-Request-Method') !== allowedMethod ||
          requestedHeaders.some(h => !PREFLIGHT_HEADERS.has(h))) {
        return reply(request, 403, { error: 'Preflight not allowed' });
      }
      return reply(request, 204, undefined, {
        'Access-Control-Allow-Methods': `${allowedMethod}, OPTIONS`,
        'Access-Control-Allow-Headers': 'Content-Type, DNT, Sec-GPC',
        'Access-Control-Max-Age': '600',
        'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
      });
    }
    if (request.method !== allowedMethod) {
      return reply(request, 405, { error: 'Method not allowed' }, { Allow: `${allowedMethod}, OPTIONS` });
    }

    try {
      if (path === '/hit') {
        if (request.headers.get('Origin') !== HOMEPAGE_ORIGIN) {
          return reply(request, 403, { error: 'Origin not allowed' });
        }
        if (request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1' ||
            BOT.test(request.headers.get('User-Agent') || '')) {
          return reply(request, 204);
        }
        // Location data is accepted exclusively from request.cf, never a body.
        if (!(await emptyBody(request))) return reply(request, 400, { error: 'Empty POST required' });
        if (await limited(request, env)) {
          return reply(request, 429, { error: 'Too many requests' }, { 'Retry-After': '60' });
        }
        const point = geography(request.cf);
        const batch = [env.DB.prepare(SQL.totalHit)];
        if (point) batch.push(env.DB.prepare(SQL.pointHit).bind(point.country, point.city, point.lat, point.lon));
        // D1 batch executes this counter pair in one transaction, rolling back
        // the total too if the geographic increment fails.
        await env.DB.batch(batch);
        return reply(request, 204);
      }

      const [total, locations] = await env.DB.batch([
        env.DB.prepare(SQL.totals),
        env.DB.prepare(SQL.points).bind(MAX_POINTS),
      ]);
      const points = (locations.results || []).slice(0, MAX_POINTS).flatMap(row => {
        const point = geography({ ...row, latitude: row.lat, longitude: row.lon });
        return point ? [{ lon: point.lon, lat: point.lat, country: point.country,
          city: point.city, views: safeCount(row.views) }] : [];
      });
      return reply(request, 200, { views: safeCount(total.results?.[0]?.views), points });
    } catch {
      // No raw errors, request headers, IPs or geo metadata are logged/returned.
      return reply(request, 503, { error: 'Statistics temporarily unavailable' });
    }
  },
};

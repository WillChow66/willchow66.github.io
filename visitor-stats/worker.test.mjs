import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { HOMEPAGE_ORIGIN, MAX_POINTS } from './worker.mjs';

// A narrow D1 adapter backed by real, in-memory SQLite. batch reproduces D1's
// documented transaction semantics; SQL is actually parsed and executed.
class SQLiteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
    this.batches = 0;
  }
  prepare(sql) {
    return { sql, params: [], bind(...params) { return { sql, params }; } };
  }
  async batch(statements) {
    this.batches++;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(({ sql, params }) => ({
        success: true, results: this.sqlite.prepare(sql).all(...params),
      }));
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function request(path = '/hit', { method, headers = {}, cf, body } = {}) {
  const req = new Request(`https://map.example${path}`, {
    method: method || (path.startsWith('/hit') ? 'POST' : 'GET'),
    headers: { Origin: HOMEPAGE_ORIGIN, 'User-Agent': 'Mozilla/5.0', ...headers },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
  Object.defineProperty(req, 'cf', { value: cf });
  return req;
}

const geo = { country: 'CN', city: 'Shanghai', latitude: '31.23042', longitude: '121.47370' };
const get = async env => (await worker.fetch(request('/points'), env)).json();

test('fresh database contains no synthetic visits', async () => {
  assert.deepEqual(await get({ DB: new SQLiteD1() }), { views: 0, points: [] });
});

test('foreign, null and missing origins never reach the database', async () => {
  const DB = new SQLiteD1();
  for (const origin of ['https://evil.example', 'https://willchow66.github.io.evil.example', 'null', '']) {
    const req = request('/hit', { headers: { Origin: origin }, cf: geo });
    if (!origin) req.headers.delete('Origin');
    const res = await worker.fetch(req, { DB });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
  }
  assert.equal(DB.batches, 0);
});

test('valid views aggregate with rounded city coordinates and atomic increments', async () => {
  const DB = new SQLiteD1();
  await worker.fetch(request('/hit', { cf: geo }), { DB });
  await worker.fetch(request('/hit', { cf: { ...geo, latitude: '31.23049' } }), { DB });
  assert.deepEqual(await get({ DB }), { views: 2, points: [
    { lon: 121.47, lat: 31.23, country: 'CN', city: 'Shanghai', views: 2 },
  ] });
});

test('unknown or malformed geography increases total without invented dots', async () => {
  const DB = new SQLiteD1();
  for (const cf of [undefined, {}, { ...geo, latitude: '' }, { ...geo, longitude: 'NaN' },
    { ...geo, latitude: '91' }, { ...geo, longitude: '180.01' }, { ...geo, latitude: '31; DROP TABLE totals' },
    { ...geo, country: 'XX' }, { ...geo, country: 'T1' }]) {
    assert.equal((await worker.fetch(request('/hit?lat=32&lon=120', { cf }), { DB })).status, 204);
  }
  assert.deepEqual(await get({ DB }), { views: 9, points: [] });
});

test('CORS works for homepage preflight and aggregate; credentials are never enabled', async () => {
  const DB = new SQLiteD1();
  const res = await worker.fetch(request('/hit', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, dnt, sec-gpc',
  } }), { DB });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), HOMEPAGE_ORIGIN);
  assert.equal(res.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(DB.batches, 0);
  assert.equal((await worker.fetch(request('/hit', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization',
  } }), { DB })).status, 403);
  const aggregate = await worker.fetch(request('/points'), { DB });
  assert.equal(aggregate.headers.get('Access-Control-Allow-Origin'), HOMEPAGE_ORIGIN);
  assert.equal(aggregate.headers.get('Cache-Control'), 'no-store');
  const publicReq = request('/points');
  publicReq.headers.delete('Origin');
  assert.equal((await worker.fetch(publicReq, { DB })).status, 200);
});

test('DNT, GPC and recognizable bots skip all writes and rate-limit processing', async () => {
  const DB = new SQLiteD1();
  for (const headers of [{ DNT: '1' }, { 'Sec-GPC': '1' }, { 'User-Agent': 'Googlebot/2.1' },
    { 'User-Agent': 'facebookexternalhit/1.1' }, { 'User-Agent': 'curl/8.0' }]) {
    assert.equal((await worker.fetch(request('/hit', { headers, cf: geo }), { DB })).status, 204);
  }
  assert.equal(DB.batches, 0);
});

test('bodies are rejected; browser geography headers are ignored', async () => {
  const DB = new SQLiteD1();
  const payload = request('/hit', { body: JSON.stringify(geo) });
  assert.equal((await worker.fetch(payload, { DB })).status, 400);
  assert.equal(DB.batches, 0);
  await worker.fetch(request('/hit', { headers: { 'cf-iplatitude': '31', 'cf-iplongitude': '121', 'cf-ipcountry': 'CN' } }), { DB });
  assert.deepEqual(await get({ DB }), { views: 1, points: [] });
});

test('genuinely empty POST streams count but nonempty streams do not', async () => {
  const DB = new SQLiteD1();
  const empty = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array()); controller.close();
  } });
  const nonempty = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array([1])); controller.close();
  } });
  assert.equal((await worker.fetch(request('/hit', { body: empty, cf: geo }), { DB })).status, 204);
  assert.equal((await worker.fetch(request('/hit', { body: nonempty, cf: geo }), { DB })).status, 400);
  assert.equal((await get({ DB })).views, 1);
});

test('city metadata is bounded and SQL injection is treated as bound text', async () => {
  const DB = new SQLiteD1();
  const hostile = "'); DROP TABLE totals; -- <script>\u0000" + 'A'.repeat(2000);
  await worker.fetch(request('/hit', { cf: { ...geo, city: hostile } }), { DB });
  const result = await get({ DB });
  assert.equal(result.views, 1);
  assert.equal(result.points.length, 1);
  assert.ok(result.points[0].city.length <= 80);
  assert.doesNotMatch(result.points[0].city, /[<>;\u0000]/);
  assert.equal(DB.sqlite.prepare('SELECT count(*) AS n FROM totals').get().n, 1);
});

test('SQLite rollback keeps the total unchanged if point insertion fails', async () => {
  const DB = new SQLiteD1();
  DB.sqlite.exec("CREATE TRIGGER reject_point BEFORE INSERT ON points BEGIN SELECT RAISE(ABORT, 'private metadata'); END");
  const res = await worker.fetch(request('/hit', { cf: geo }), { DB });
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /private metadata/);
  assert.deepEqual(await get({ DB }), { views: 0, points: [] });
});

test('rate-limit denial skips D1 and uses a digest instead of a raw IP', async () => {
  const DB = new SQLiteD1();
  const ip = '203.0.113.10';
  let rateKey;
  const HIT_RATE_LIMITER = { async limit({ key }) { rateKey = key; return { success: false }; } };
  const res = await worker.fetch(request('/hit', { headers: { 'CF-Connecting-IP': ip }, cf: geo }), { DB, HIT_RATE_LIMITER });
  assert.equal(res.status, 429);
  assert.equal(DB.batches, 0);
  assert.match(rateKey, /^[a-f0-9]{64}$/);
  assert.ok(!rateKey.includes(ip));
  assert.equal(res.headers.get('Retry-After'), '60');
});

test('aggregate bounds output while total retains all counted views', async () => {
  const DB = new SQLiteD1();
  const insert = DB.sqlite.prepare('INSERT INTO points VALUES (?, ?, ?, ?, ?)');
  DB.sqlite.exec('BEGIN');
  for (let i = 0; i < MAX_POINTS + 5; i++) insert.run('CN', `City ${i}`, 31, 121, 1);
  DB.sqlite.exec(`INSERT INTO totals VALUES (1, ${MAX_POINTS + 5}); COMMIT`);
  const result = await get({ DB });
  assert.equal(result.points.length, MAX_POINTS);
  assert.equal(result.views, MAX_POINTS + 5);
  assert.ok(JSON.stringify(result).length < 1000000);
});

// Shared state — the multi-instance standard path (feature 11).
// Part 1: the SqliteSharedState contract (the same contract the Neon/Postgres
// and HTTP coordinator adapters implement).
// Part 2: two live app instances, two separate SQLite connections to ONE
// durable file — revocation and rate limits proven to hold across instances.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { SqliteSharedState } from '../src/shared/sqlite.mjs';
import { createApp, configFromEnv } from '../src/server.mjs';

const SECRET = 'test-session-secret-0123456789abcdef';
const key = (s) => createHash('sha256').update(s).digest('hex');

async function tempState(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'qp-state-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'state.sqlite');
}

test('SqliteSharedState enforces revocation, rate limits, and write intents', async (t) => {
  const file = await tempState(t);
  const a = new SqliteSharedState(file);
  const b = new SqliteSharedState(file);
  t.after(() => { a.close(); b.close(); });

  const jti = key('session-1');
  assert.equal(await a.isRevoked(jti), false);
  await a.revoke(jti, Date.now() + 60000);
  assert.equal(await b.isRevoked(jti), true); // visible from the other connection

  const bucket = key('bucket-1');
  assert.equal((await a.checkRateLimit(bucket, 3, 60000)).allowed, true);
  assert.equal((await b.checkRateLimit(bucket, 3, 60000)).allowed, true);
  assert.equal((await a.checkRateLimit(bucket, 3, 60000)).allowed, true);
  assert.equal((await b.checkRateLimit(bucket, 3, 60000)).allowed, false); // global cap across connections

  const intent = key('intent-1');
  const claim = await a.claim(intent);
  assert.equal(claim.state, 'claimed');
  assert.equal((await b.claim(intent)).state, 'pending'); // never double-claimed
  await a.complete(intent, claim.ownerToken, 'rec123');
  const done = await b.claim(intent);
  assert.equal(done.state, 'done');
  assert.equal(done.recordId, 'rec123');
});

test('SqliteSharedState refuses in-memory operation', async (t) => {
  assert.throws(() => new SqliteSharedState(':memory:'), /Durable path required/);
  assert.throws(() => new SqliteSharedState(''), /Durable path required/);
});

function demoConfig() {
  return configFromEnv({ QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: SECRET });
}
async function serve(app) {
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function call(base, path, { method = 'GET', body, cookie, csrf } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}

test('two app instances share revocation and login rate limits through one store', async (t) => {
  const file = await tempState(t);
  const stateA = new SqliteSharedState(file);
  const stateB = new SqliteSharedState(file);
  t.after(() => { stateA.close(); stateB.close(); });
  const appA = createApp({ config: demoConfig(), sharedState: stateA });
  const appB = createApp({ config: demoConfig(), sharedState: stateB });
  const A = await serve(appA);
  const B = await serve(appB);
  t.after(async () => { await A.close(); await B.close(); });

  // Sign in on A; the session is honored on B (stateless cookie + shared store).
  const login = await call(A.base, '/api/login', { method: 'POST', body: { email: 'owner@quotepilot.invalid', password: 'DemoPass-2026!' } });
  assert.equal(login.status, 200);
  const cookie = login.cookie;
  const csrf = login.data.csrf;
  assert.equal((await call(B.base, '/api/me', { cookie })).status, 200);

  // Sign out on A; the revocation lands in the shared store, so B refuses too.
  assert.equal((await call(A.base, '/api/logout', { method: 'POST', body: {}, cookie, csrf })).status, 200);
  assert.equal((await call(B.base, '/api/me', { cookie })).status, 401);
  assert.equal((await call(A.base, '/api/me', { cookie })).status, 401);
});

test('login rate limit is global across instances, not per-instance', async (t) => {
  const file = await tempState(t);
  const stateA = new SqliteSharedState(file);
  const stateB = new SqliteSharedState(file);
  t.after(() => { stateA.close(); stateB.close(); });
  const A = await serve(createApp({ config: demoConfig(), sharedState: stateA }));
  const B = await serve(createApp({ config: demoConfig(), sharedState: stateB }));
  t.after(async () => { await A.close(); await B.close(); });

  // 12 failed attempts split across the two instances exhaust the shared cap.
  for (let i = 0; i < 12; i++) {
    const target = i % 2 === 0 ? A : B;
    const res = await call(target.base, '/api/login', { method: 'POST', body: { email: 'owner@quotepilot.invalid', password: 'wrong-password' } });
    assert.equal(res.status, 401, `attempt ${i + 1}`);
  }
  const thirteenth = await call(A.base, '/api/login', { method: 'POST', body: { email: 'owner@quotepilot.invalid', password: 'wrong-password' } });
  assert.equal(thirteenth.status, 429);
});

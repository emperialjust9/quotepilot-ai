// Auth primitives — src/lib/auth.mjs (pure, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword, verifyPassword, issueCookie, parseSession, clearCookie,
  findLoginUser, requireCsrf, credentialVersion, demoUsers,
} from '../src/lib/auth.mjs';

const SECRET = 'test-session-secret-0123456789abcdef';

test('hashPassword produces the salt:hash format configFromEnv validates', () => {
  const stored = hashPassword('correct horse battery');
  assert.match(stored, /^([a-f0-9]{32}):([a-f0-9]{128})$/i);
});

test('verifyPassword round-trips hashPassword output', () => {
  const stored = hashPassword('correct horse battery');
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('wrong password entirely', stored), false);
});

test('hashPassword salts uniquely per call', () => {
  assert.notEqual(hashPassword('correct horse battery'), hashPassword('correct horse battery'));
});

test('hashPassword enforces the 12-character minimum', () => {
  assert.throws(() => hashPassword('short'), /at least 12 characters/);
});

test('verifyPassword fails closed on malformed stored values', () => {
  assert.equal(verifyPassword('whatever-password', 'not-a-hash'), false);
  assert.equal(verifyPassword('whatever-password', ''), false);
  assert.equal(verifyPassword(123456789012, hashPassword('correct horse battery')), false);
});

test('issueCookie / parseSession round-trip a signed session', () => {
  const user = { email: 'owner@example.com', businessKey: 'BIZ-1', role: 'owner' };
  const { cookie, session } = issueCookie(user, SECRET, false, 'epoch-1', 'cv-1');
  assert.match(cookie, /^qp_session=/);
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  const req = { headers: { cookie: cookie.split(';')[0] } };
  const parsed = parseSession(req, SECRET);
  assert.equal(parsed.email, 'owner@example.com');
  assert.equal(parsed.businessKey, 'BIZ-1');
  assert.equal(parsed.role, 'owner');
  assert.equal(parsed.csrf, session.csrf);
  assert.equal(parsed.epoch, 'epoch-1');
});

test('parseSession rejects tampered payloads and wrong secrets', () => {
  const user = { email: 'owner@example.com', businessKey: 'BIZ-1', role: 'owner' };
  const { cookie } = issueCookie(user, SECRET);
  const value = cookie.split(';')[0];
  const tampered = value.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal(parseSession({ headers: { cookie: tampered } }, SECRET), null);
  assert.equal(parseSession({ headers: { cookie: value } }, 'a-different-secret-0123456789'), null);
  assert.equal(parseSession({ headers: {} }, SECRET), null);
});

test('clearCookie expires the session cookie', () => {
  assert.match(clearCookie(), /qp_session=;.*Max-Age=0/);
  assert.match(clearCookie(true), /; Secure$/);
});

test('findLoginUser authenticates demo users, case-insensitive on email', () => {
  const demo = demoUsers[0];
  const found = findLoginUser(demo.email.toUpperCase(), demo.password, 'demo', []);
  assert.deepEqual(found, { email: demo.email, businessKey: demo.businessKey, role: demo.role });
  assert.equal(findLoginUser(demo.email, 'wrong-password', 'demo', []), null);
  assert.equal(findLoginUser('nobody@example.com', demo.password, 'demo', []), null);
});

test('findLoginUser verifies configured users against scrypt hashes', () => {
  const users = [{ email: 'op@example.com', passwordHash: hashPassword('a-strong-password'), businessKey: 'BIZ-9', role: 'operator' }];
  assert.equal(findLoginUser('op@example.com', 'a-strong-password', 'airtable', users)?.role, 'operator');
  assert.equal(findLoginUser('op@example.com', 'not-the-password', 'airtable', users), null);
});

test('requireCsrf accepts the session token and rejects mismatches', () => {
  const session = { csrf: 'token-123' };
  assert.doesNotThrow(() => requireCsrf({ headers: { 'x-csrf-token': 'token-123' } }, session));
  assert.throws(() => requireCsrf({ headers: { 'x-csrf-token': 'other' } }, session), /CSRF/);
  assert.throws(() => requireCsrf({ headers: {} }, session), /CSRF/);
});

test('credentialVersion is stable per credential set and changes with the hash', () => {
  const user = { email: 'Op@Example.com', businessKey: 'BIZ-1', role: 'owner', passwordHash: 'aa:bb' };
  assert.equal(credentialVersion(user), credentialVersion({ ...user }));
  assert.notEqual(credentialVersion(user), credentialVersion({ ...user, passwordHash: 'cc:dd' }));
});

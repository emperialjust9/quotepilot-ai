// Storage + environment configuration seams (pure parts only).
// Live Airtable / Neon paths need real credentials and network access; those
// tests are marked SKIP below — they are never faked into passing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AirtableRepo, PRODUCTION_TABLES, STAGING_BASE_ID, stagingTableMapFromEnv, scopedFormula } from '../src/storage/airtable.mjs';
import { validateNeonConnectionString } from '../src/shared/neon.mjs';
import { configFromEnv } from '../src/server.mjs';

const SECRET = 'test-session-secret-0123456789abcdef';

test('scopedFormula builds the tenant filter', () => {
  assert.equal(scopedFormula('DEMO-001'), '{Business Key}="DEMO-001"');
});

test('AirtableRepo constructor requires a token and a valid base ID', () => {
  assert.throws(() => new AirtableRepo({}), /AIRTABLE_TOKEN required/);
  assert.throws(() => new AirtableRepo({ token: 'x', baseId: 'bad' }), /Invalid Airtable base ID/);
  assert.throws(() => new AirtableRepo({ token: 'x', tables: { Businesses: 'nope' } }), /Invalid Airtable table map/);
});

test('stagingTableMapFromEnv is null outside staging mode', () => {
  assert.equal(stagingTableMapFromEnv({}), null);
  // A stray staging map outside staging mode is refused, fail-closed.
  assert.throws(() => stagingTableMapFromEnv({ QP_AIRTABLE_STAGING_TABLE_IDS_JSON: '{}' }), /requires staging mode/);
});

test('stagingTableMapFromEnv demands an explicit, isolated map in staging mode', () => {
  assert.throws(() => stagingTableMapFromEnv({ QP_AIRTABLE_STAGING: '1' }), /explicit table ID map/);
  const names = Object.keys(PRODUCTION_TABLES);
  const map = Object.fromEntries(names.map((n, i) => [n, `tblSTAGING${String(i).padStart(7, '0')}`]));
  const env = {
    QP_AIRTABLE_STAGING: '1',
    QP_AIRTABLE_STAGING_BASE_ID: STAGING_BASE_ID,
    QP_AIRTABLE_STAGING_TABLE_IDS_JSON: JSON.stringify(map),
  };
  const parsed = stagingTableMapFromEnv(env);
  assert.deepEqual({ ...parsed }, map);
  assert.ok(Object.isFrozen(parsed));
  // A production table ID inside the staging map must be refused.
  const leaked = { ...map, Businesses: PRODUCTION_TABLES.Businesses };
  assert.throws(
    () => stagingTableMapFromEnv({ ...env, QP_AIRTABLE_STAGING_TABLE_IDS_JSON: JSON.stringify(leaked) }),
    /Production table ID/,
  );
  // Wrong staging base must be refused.
  assert.throws(() => stagingTableMapFromEnv({ ...env, QP_AIRTABLE_STAGING_BASE_ID: 'app00000000000000' }), /isolated base/);
});

test('validateNeonConnectionString accepts only the QuotePilot security target', () => {
  const good = 'postgresql://quotepilot_security_app:pw@ep-test.us-east-2.aws.neon.tech/quotepilot_security?sslmode=require';
  assert.equal(validateNeonConnectionString(good), good);
  assert.throws(() => validateNeonConnectionString(''), /connection required/);
  assert.throws(() => validateNeonConnectionString('postgresql://quotepilot_security_app:pw@db.example.com/quotepilot_security?sslmode=require'), /mismatch/);
  assert.throws(() => validateNeonConnectionString('postgresql://other_role:pw@ep-test.us-east-2.aws.neon.tech/quotepilot_security?sslmode=require'), /mismatch/);
  assert.throws(() => validateNeonConnectionString('postgresql://quotepilot_security_app:pw@ep-test.us-east-2.aws.neon.tech/other_db?sslmode=require'), /mismatch/);
  assert.throws(() => validateNeonConnectionString('postgresql://quotepilot_security_app:pw@ep-test.us-east-2.aws.neon.tech/quotepilot_security'), /mismatch/);
});

test('configFromEnv accepts a localhost demo configuration', () => {
  const cfg = configFromEnv({ QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: SECRET });
  assert.equal(cfg.mode, 'demo');
  assert.equal(cfg.host, '127.0.0.1');
});

test('configFromEnv validates external-action capabilities per capability (2026-11-27 build)', () => {
  const base = { QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: SECRET };
  // All flags off still boots exactly as the private pilot did.
  const off = configFromEnv(base);
  assert.equal(off.sendsEnabled, false);
  assert.equal(off.billingEnabled, false);
  assert.equal(off.bookingsEnabled, false);
  // A flag without its required configuration refuses startup, fail-closed.
  assert.throws(() => configFromEnv({ ...base, QP_ALLOW_CUSTOMER_SENDS: '1' }), /require a configured channel/);
  assert.throws(() => configFromEnv({ ...base, QP_ALLOW_LIVE_BILLING: '1' }), /requires QP_GUMROAD_CHECKOUT_URL/);
  assert.throws(() => configFromEnv({ ...base, QP_ALLOW_LIVE_BILLING: '1', QP_GUMROAD_CHECKOUT_URL: 'https://gumroad.com/l/quotepilot' }), /QP_GUMROAD_WEBHOOK_SECRET/);
  // Fully configured capabilities are accepted and reported truthfully.
  const on = configFromEnv({ ...base,
    QP_ALLOW_CUSTOMER_SENDS: '1', QP_EMAIL_PROVIDER: 'outbox', QP_EMAIL_FROM: 'quotes@example.com',
    QP_ALLOW_LIVE_BILLING: '1', QP_GUMROAD_CHECKOUT_URL: 'https://gumroad.com/l/quotepilot', QP_GUMROAD_WEBHOOK_SECRET: 'whsec-test-123456',
    QP_ALLOW_AUTOMATED_BOOKINGS: '1' });
  assert.equal(on.sendsEnabled, true);
  assert.equal(on.billingEnabled, true);
  assert.equal(on.bookingsEnabled, true);
  assert.equal(on.planPriceMonthly, 19);
});

test('configFromEnv validates messaging providers', () => {
  const base = { QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: SECRET };
  assert.throws(() => configFromEnv({ ...base, QP_EMAIL_PROVIDER: 'pigeon' }), /must be smtp or outbox/);
  assert.throws(() => configFromEnv({ ...base, QP_EMAIL_PROVIDER: 'smtp' }), /QP_EMAIL_FROM required/);
  assert.throws(() => configFromEnv({ ...base, QP_EMAIL_PROVIDER: 'smtp', QP_EMAIL_FROM: 'a@b.co' }), /QP_SMTP_URL required/);
  assert.throws(() => configFromEnv({ ...base, QP_SMS_PROVIDER: 'http', QP_SMS_FROM: '+15550000000' }), /QP_SMS_API_URL and QP_SMS_API_TOKEN/);
});

test('configFromEnv gates signup and uploads on their prerequisites', () => {
  const base = { QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: SECRET };
  assert.throws(() => configFromEnv({ ...base, QP_ALLOW_SIGNUP: '1' }), /requires an email provider/);
  const ok = configFromEnv({ ...base, QP_ALLOW_SIGNUP: '1', QP_EMAIL_PROVIDER: 'outbox', QP_EMAIL_FROM: 'a@b.co', QP_UPLOADS_ENABLED: '1' });
  assert.equal(ok.signupEnabled, true);
  assert.equal(ok.uploadsEnabled, true);
});

test('configFromEnv makes shared state the standard production path', () => {
  const prod = { QP_DATA_MODE: 'airtable', NODE_ENV: 'production', QP_SESSION_SECRET: SECRET, AIRTABLE_TOKEN: 'tok',
    QP_USERS_JSON: JSON.stringify([{ email: 'op@example.com', businessKey: 'BIZ-1', role: 'owner', passwordHash: `${'a'.repeat(32)}:${'b'.repeat(128)}` }]),
    QP_ALLOWED_ORIGINS: 'https://app.example.com' };
  // Production connected mode without any shared-state backend: refused.
  assert.throws(() => configFromEnv(prod), /Shared-state backend required/);
  // HTTP coordinator backend: accepted.
  assert.equal(configFromEnv({ ...prod, QP_SHARED_STATE_URL: 'https://state.example.com', QP_SHARED_STATE_TOKEN: 't'.repeat(32) }).sharedStateRequired, true);
  // Neon provider: accepted.
  assert.equal(configFromEnv({ ...prod, QP_SHARED_STATE_PROVIDER: 'neon', QP_SECURITY_DATABASE_URL: 'postgresql://x' }).sharedStateProvider, 'neon');
  // SQLite provider requires a durable path, never :memory:.
  assert.throws(() => configFromEnv({ ...prod, QP_SHARED_STATE_PROVIDER: 'sqlite' }), /durable QP_SHARED_STATE_SQLITE_PATH/);
  assert.throws(() => configFromEnv({ ...prod, QP_SHARED_STATE_PROVIDER: 'sqlite', QP_SHARED_STATE_SQLITE_PATH: ':memory:' }), /durable QP_SHARED_STATE_SQLITE_PATH/);
  assert.equal(configFromEnv({ ...prod, QP_SHARED_STATE_PROVIDER: 'sqlite', QP_SHARED_STATE_SQLITE_PATH: '/tmp/qp-state.sqlite' }).sharedStateProvider, 'sqlite');
});

test('configFromEnv fails closed: short session secret and missing Airtable token', () => {
  assert.throws(() => configFromEnv({ QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: 'short' }), />=32 chars/);
  assert.throws(() => configFromEnv({ QP_DATA_MODE: 'airtable', QP_SESSION_SECRET: SECRET }), /AIRTABLE_TOKEN required/);
  assert.throws(() => configFromEnv({ QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '0.0.0.0', QP_SESSION_SECRET: SECRET }), /localhost/);
});

// --- Credential-dependent paths: SKIPPED, never faked. ---
test('AirtableRepo live round-trip against a real base', { skip: 'requires live AIRTABLE_TOKEN and base access — not available in this environment' }, () => {
  throw new Error('must never run without credentials');
});

test('createNeonSharedState live connection and self-test', { skip: 'requires live QP_SECURITY_DATABASE_URL (Neon) — not available in this environment' }, () => {
  throw new Error('must never run without credentials');
});

test('createApp end-to-end HTTP flow in connected (Airtable) mode', { skip: 'requires live Airtable + Neon credentials — not available in this environment' }, () => {
  throw new Error('must never run without credentials');
});

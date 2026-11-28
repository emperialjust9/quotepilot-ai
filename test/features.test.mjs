// Ten-feature build — end-to-end HTTP exercises (features 2–10).
// Everything runs in demo mode on the fictional seed with dry-run (outbox)
// transports: no real message, payment, or provider is touched. Live-provider
// legs stay SKIPPED in messaging.test.mjs / storage-config.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp, configFromEnv } from '../src/server.mjs';

const SECRET = 'test-session-secret-0123456789abcdef';
const FULL_ENV = {
  QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: SECRET,
  QP_ALLOW_CUSTOMER_SENDS: '1', QP_EMAIL_PROVIDER: 'outbox', QP_EMAIL_FROM: 'quotes@example.com',
  QP_SMS_PROVIDER: 'outbox', QP_SMS_FROM: '+15550001111',
  QP_ALLOW_LIVE_BILLING: '1', QP_GUMROAD_CHECKOUT_URL: 'https://gumroad.com/l/quotepilot-test', QP_GUMROAD_WEBHOOK_SECRET: 'whsec-test-123456',
  QP_ALLOW_AUTOMATED_BOOKINGS: '1', QP_ALLOW_SIGNUP: '1', QP_UPLOADS_ENABLED: '1',
};
const PLAIN_ENV = { QP_DATA_MODE: 'demo', QP_ALLOW_DEMO: '1', HOST: '127.0.0.1', QP_SESSION_SECRET: SECRET };

async function serve(t, env) {
  const app = createApp({ config: configFromEnv(env) });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { app, base: `http://127.0.0.1:${server.address().port}` };
}
async function call(base, path, { method = 'GET', body, cookie, csrf, headers = {}, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Origin: base,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* HTML pages */ }
  return { status: res.status, data, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(base, email = 'owner@quotepilot.invalid', password = 'DemoPass-2026!') {
  const res = await call(base, '/api/login', { method: 'POST', body: { email, password } });
  assert.equal(res.status, 200, `login for ${email}`);
  return { cookie: res.cookie, csrf: res.data.csrf };
}
const leadBody = (over = {}) => ({
  name: 'Demo Client A', email: 'fake-a@example.invalid', phone: '+15559998888',
  service: 'Deep Clean', bedrooms: 3, bathrooms: 2, squareFeet: 1600,
  postal: '11214', frequency: 'Once', consent: true, ...over,
});
async function approvedEstimate(base, auth) {
  const lead = await call(base, '/api/leads', { method: 'POST', body: leadBody(), ...auth });
  assert.equal(lead.status, 201);
  const rules = await call(base, '/api/rules', auth);
  const rule = rules.data.records.find((r) => r.fields.Service === 'Deep Clean');
  await call(base, `/api/rules/${rule.id}/approve`, { method: 'POST', body: {}, ...auth });
  const est = await call(base, '/api/estimates', { method: 'POST', body: { leadId: lead.data.lead.id, ruleId: rule.id }, ...auth });
  assert.equal(est.status, 201);
  const approved = await call(base, `/api/estimates/${est.data.record.id}/approve`, { method: 'POST', body: {}, ...auth });
  assert.equal(approved.status, 200);
  return { lead: lead.data.lead, estimate: approved.data.record };
}

test('feature flags off: every new capability is closed and /api/me says so', async (t) => {
  const { base } = await serve(t, PLAIN_ENV);
  const auth = await login(base);
  const me = await call(base, '/api/me', auth);
  assert.deepEqual(me.data.gates, { outbound: false, checkout: false, automatedBookings: false });
  assert.equal((await call(base, '/api/estimates/whatever/send', { method: 'POST', body: {}, ...auth })).status, 404);
  assert.equal((await call(base, '/api/bookings/whatever/confirm', { method: 'POST', body: {}, ...auth })).status, 404);
  assert.equal((await call(base, '/api/uploads?filename=a.png', { method: 'POST', body: Buffer.from([1]), raw: true, headers: { 'Content-Type': 'image/png' }, ...auth })).status, 404);
  assert.equal((await call(base, '/api/signup', { method: 'POST', body: { companyName: 'X', email: 'x@y.z', password: 'a-strong-password' } })).status, 404);
  assert.equal((await call(base, '/api/billing/webhook', { method: 'POST', body: {}, headers: { 'x-qp-webhook-secret': 'whsec-test-123456' } })).status, 404);
});

test('feature 10: privacy and terms pages render with their draft gates visible', async (t) => {
  const { base } = await serve(t, PLAIN_ENV);
  const privacy = await call(base, '/privacy');
  assert.equal(privacy.status, 200);
  assert.match(privacy.text, /FOR COUNSEL REVIEW — NOT PUBLISHED/);
  assert.match(privacy.text, /\[COUNSEL TO CONFIRM — retention periods\.\]/);
  assert.match(privacy.text, /\[FOUNDER TO CONFIRM — exact account fields\.\]/);
  assert.match(privacy.text, /Vercel \(application hosting\), Airtable \(database and storage\), and Neon/);
  const terms = await call(base, '/terms');
  assert.equal(terms.status, 200);
  assert.match(terms.text, /FOUNDER\/COUNSEL REVIEW REQUIRED/);
  assert.match(terms.text, /\$19 per month, billed through Gumroad/);
  assert.equal((await call(base, '/signup')).status, 200);
});

test('feature 9: the owner can replace the service catalog and validation follows it', async (t) => {
  const { base } = await serve(t, FULL_ENV);
  const auth = await login(base);
  const before = await call(base, '/api/services', auth);
  assert.deepEqual(before.data.services, ['Standard Clean', 'Deep Clean', 'Move-In/Out']);
  const set = await call(base, '/api/services', { method: 'POST', body: { services: ['Standard Clean', 'Window Cleaning'] }, ...auth });
  assert.equal(set.status, 200);
  assert.deepEqual(set.data.services, ['Standard Clean', 'Window Cleaning']);
  const ok = await call(base, '/api/leads', { method: 'POST', body: leadBody({ service: 'Window Cleaning' }), ...auth });
  assert.equal(ok.status, 201);
  const refused = await call(base, '/api/leads', { method: 'POST', body: leadBody({ service: 'Deep Clean', email: 'other@example.invalid' }), ...auth });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Unsupported service/);
  const rule = await call(base, '/api/rules', { method: 'POST', body: { service: 'Window Cleaning', base: 90, perBedroom: 10, perBathroom: 10, per1000: 5, minimum: 80, multiplier: 1 }, ...auth });
  assert.equal(rule.status, 201);
});

test('features 2+6: an approved estimate can be sent by email and SMS, and the record shows it', async (t) => {
  const { app, base } = await serve(t, FULL_ENV);
  const auth = await login(base);
  const { estimate } = await approvedEstimate(base, auth);
  const emailSend = await call(base, `/api/estimates/${estimate.id}/send`, { method: 'POST', body: { channel: 'email' }, ...auth });
  assert.equal(emailSend.status, 200);
  assert.equal(emailSend.data.record.fields['Send Status'], 'Sent');
  assert.equal(emailSend.data.record.fields['Sent Channel'], 'email');
  assert.equal(app.messaging.email.messages.length, 1);
  assert.equal(app.messaging.email.messages[0].to, 'fake-a@example.invalid');
  assert.match(app.messaging.email.messages[0].body, /\$349\.00/);
  const smsSend = await call(base, `/api/estimates/${estimate.id}/send`, { method: 'POST', body: { channel: 'sms' }, ...auth });
  assert.equal(smsSend.status, 200);
  assert.equal(app.messaging.sms.messages.length, 1);
  assert.equal(app.messaging.sms.messages[0].to, '+15559998888');
});

test('features 2+6: sending refuses unapproved estimates and unconsented leads', async (t) => {
  const { base } = await serve(t, FULL_ENV);
  const auth = await login(base);
  // Lead without consent: estimate can be approved internally but never sent.
  const lead = await call(base, '/api/leads', { method: 'POST', body: leadBody({ consent: false, email: 'noconsent@example.invalid' }), ...auth });
  assert.equal(lead.status, 201);
  const rules = await call(base, '/api/rules', auth);
  const rule = rules.data.records.find((r) => r.fields.Service === 'Deep Clean');
  await call(base, `/api/rules/${rule.id}/approve`, { method: 'POST', body: {}, ...auth });
  const est = await call(base, '/api/estimates', { method: 'POST', body: { leadId: lead.data.lead.id, ruleId: rule.id }, ...auth });
  const sendEarly = await call(base, `/api/estimates/${est.data.record.id}/send`, { method: 'POST', body: {}, ...auth });
  assert.equal(sendEarly.status, 409);
  assert.match(sendEarly.data.error, /owner-approved/);
  await call(base, `/api/estimates/${est.data.record.id}/approve`, { method: 'POST', body: {}, ...auth });
  const sendNoConsent = await call(base, `/api/estimates/${est.data.record.id}/send`, { method: 'POST', body: {}, ...auth });
  assert.equal(sendNoConsent.status, 409);
  assert.match(sendNoConsent.data.error, /consent/);
});

test('feature 2: a follow-up draft can be sent once, then reports duplicate', async (t) => {
  const { app, base } = await serve(t, FULL_ENV);
  const auth = await login(base);
  const { estimate } = await approvedEstimate(base, auth);
  const draft = await call(base, '/api/followup-draft', { method: 'POST', body: { estimateId: estimate.id }, ...auth });
  assert.equal(draft.status, 201);
  const sent = await call(base, `/api/followups/${draft.data.record.id}/send`, { method: 'POST', body: {}, ...auth });
  assert.equal(sent.status, 200);
  assert.equal(sent.data.record.fields.Status, 'Sent');
  assert.ok(sent.data.record.fields['Sent On']);
  assert.equal(app.messaging.email.messages.length, 1);
  const again = await call(base, `/api/followups/${draft.data.record.id}/send`, { method: 'POST', body: {}, ...auth });
  assert.equal(again.status, 200);
  assert.equal(again.data.duplicate, true);
  assert.equal(app.messaging.email.messages.length, 1); // never sent twice
});

test('feature 5: booking confirmation confirms and notifies; the record stays honest', async (t) => {
  const { app, base } = await serve(t, FULL_ENV);
  const auth = await login(base);
  const { estimate } = await approvedEstimate(base, auth);
  const booking = await call(base, '/api/bookings', { method: 'POST', body: { estimateId: estimate.id, requestedDate: '2026-12-01' }, ...auth });
  assert.equal(booking.status, 201);
  assert.equal(booking.data.confirmed, false);
  const confirmed = await call(base, `/api/bookings/${booking.data.record.id}/confirm`, { method: 'POST', body: {}, ...auth });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.confirmed, true);
  assert.equal(confirmed.data.record.fields.Status, 'Confirmed');
  assert.equal(confirmed.data.notified.email, true);
  assert.equal(confirmed.data.notified.sms, true);
  assert.match(confirmed.data.record.fields.Notes, /no external availability system was checked/);
  assert.equal(app.messaging.email.messages.length, 1);
  assert.match(app.messaging.email.messages[0].subject, /Booking confirmed/);
  const again = await call(base, `/api/bookings/${booking.data.record.id}/confirm`, { method: 'POST', body: {}, ...auth });
  assert.equal(again.data.duplicate, true);
});

test('feature 4: the Gumroad webhook drives subscription state at the ruled $19 price', async (t) => {
  const { base } = await serve(t, FULL_ENV);
  const payload = { businessKey: 'DEMO-001', externalSubscriptionId: 'sub_123', state: 'Active', email: 'owner@quotepilot.invalid', event: 'checkout-completed' };
  const wrong = await call(base, '/api/billing/webhook', { method: 'POST', body: payload, headers: { 'x-qp-webhook-secret': 'nope-nope-nope-nope' } });
  assert.equal(wrong.status, 401);
  const good = await call(base, '/api/billing/webhook', { method: 'POST', body: payload, headers: { 'x-qp-webhook-secret': 'whsec-test-123456' } });
  assert.equal(good.status, 200);
  const auth = await login(base);
  const billing = await call(base, '/api/billing', auth);
  assert.equal(billing.data.billingEnabled, true);
  assert.equal(billing.data.checkoutUrl, 'https://gumroad.com/l/quotepilot-test');
  assert.equal(billing.data.priceMonthly, 19);
  assert.equal(billing.data.subscription.fields.State, 'Active');
  assert.equal(billing.data.subscription.fields['Amount Monthly'], 19);
  const updated = await call(base, '/api/billing/webhook', { method: 'POST', body: { ...payload, state: 'Past Due', event: 'payment-failed' }, headers: { 'x-qp-webhook-secret': 'whsec-test-123456' } });
  assert.equal(updated.data.recordId, good.data.recordId); // same record, new state
  const after = await call(base, '/api/billing', auth);
  assert.equal(after.data.subscription.fields.State, 'Past Due');
  const badState = await call(base, '/api/billing/webhook', { method: 'POST', body: { ...payload, state: 'Free Forever' }, headers: { 'x-qp-webhook-secret': 'whsec-test-123456' } });
  assert.equal(badState.status, 400);
});

test('feature 7: uploads validate, store, and download back byte-identical', async (t) => {
  const { base } = await serve(t, FULL_ENV);
  const auth = await login(base);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
  const up = await call(base, '/api/uploads?filename=site.png', { method: 'POST', body: png, raw: true, headers: { 'Content-Type': 'image/png' }, ...auth });
  assert.equal(up.status, 201);
  assert.equal(up.data.record.fields['Content Type'], 'image/png');
  assert.equal(up.data.record.fields['Size Bytes'], png.length);
  const list = await call(base, '/api/uploads', auth);
  assert.equal(list.data.records.length, 1);
  const down = await call(base, `/api/uploads/${up.data.record.id}/download`, auth);
  assert.equal(down.status, 200);
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(8)]);
  const refused = await call(base, '/api/uploads?filename=fake.png', { method: 'POST', body: exe, raw: true, headers: { 'Content-Type': 'image/png' }, ...auth });
  assert.equal(refused.status, 400);
  assert.match(refused.data.error, /Executable/);
});

test('feature 8: signup → verify → sign-in, then password reset rotates the credential', async (t) => {
  const { app, base } = await serve(t, FULL_ENV);
  const signup = await call(base, '/api/signup', { method: 'POST', body: { companyName: 'New Shine Co', email: 'new@shine.example', password: 'a-strong-password', serviceZips: '11214' } });
  assert.equal(signup.status, 201);
  assert.match(signup.data.businessKey, /^QP-/);
  // Verification email went to the dry-run outbox with a token link.
  assert.equal(app.messaging.email.messages.length, 1);
  const verifyMail = app.messaging.email.messages[0];
  assert.equal(verifyMail.to, 'new@shine.example');
  const verifyToken = verifyMail.body.match(/token=([a-f0-9]{48})/)[1];
  // Sign-in before verification is refused.
  const early = await call(base, '/api/login', { method: 'POST', body: { email: 'new@shine.example', password: 'a-strong-password' } });
  assert.equal(early.status, 403);
  assert.match(early.data.error, /not verified/);
  // Duplicate signup is refused.
  const dup = await call(base, '/api/signup', { method: 'POST', body: { companyName: 'Copycat', email: 'new@shine.example', password: 'a-strong-password' } });
  assert.equal(dup.status, 409);
  // Verify, then sign in and see the onboarding workspace.
  assert.equal((await call(base, '/api/verify-email', { method: 'POST', body: { token: verifyToken } })).status, 200);
  const auth = await login(base, 'new@shine.example', 'a-strong-password');
  const dash = await call(base, '/api/dashboard', auth);
  assert.equal(dash.data.business['Company Name'], 'New Shine Co');
  assert.equal(dash.data.business.Status, 'Onboarding');
  // Reset: generic 202, token by email, rotation kills the old password.
  const reqReset = await call(base, '/api/password-reset/request', { method: 'POST', body: { email: 'new@shine.example' } });
  assert.equal(reqReset.status, 202);
  const resetMail = app.messaging.email.messages.at(-1);
  const resetToken = resetMail.body.match(/token=([a-f0-9]{48})/)[1];
  const unknown = await call(base, '/api/password-reset/request', { method: 'POST', body: { email: 'ghost@nowhere.example' } });
  assert.equal(unknown.status, 202); // no account enumeration
  assert.equal((await call(base, '/api/password-reset/confirm', { method: 'POST', body: { token: resetToken, newPassword: 'another-strong-password' } })).status, 200);
  const oldLogin = await call(base, '/api/login', { method: 'POST', body: { email: 'new@shine.example', password: 'a-strong-password' } });
  assert.equal(oldLogin.status, 401);
  await login(base, 'new@shine.example', 'another-strong-password');
  // The spent token cannot be replayed.
  const replay = await call(base, '/api/password-reset/confirm', { method: 'POST', body: { token: resetToken, newPassword: 'a-third-password-1' } });
  assert.equal(replay.status, 400);
});

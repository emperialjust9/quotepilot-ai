// Messaging transports + composition — src/lib/messaging.mjs.
// Outbox (dry-run) and HTTP-gateway paths are exercised with fakes; the live
// SMTP send needs a real mail server and is SKIPPED, never faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OutboxTransport, SmtpTransport, HttpSmsTransport, buildMessaging,
  parseSmtpUrl, formatEmailMessage,
  estimateEmail, estimateSms, followupEmail, bookingConfirmation,
  verifyEmailMessage, resetEmailMessage,
} from '../src/lib/messaging.mjs';

test('OutboxTransport records messages and returns dry-run ids', async () => {
  const outbox = new OutboxTransport('email');
  const sent = await outbox.send({ to: 'a@example.com', subject: 'Hi', body: 'Body' });
  assert.match(sent.id, /^outbox-/);
  assert.equal(sent.transport, 'outbox-email');
  assert.equal(outbox.messages.length, 1);
  assert.equal(outbox.messages[0].to, 'a@example.com');
  assert.equal(outbox.messages[0].subject, 'Hi');
});

test('parseSmtpUrl parses implicit-TLS and plain URLs with credentials', () => {
  const tls = parseSmtpUrl('smtps://user%40example.com:p%40ss@mail.example.com');
  assert.deepEqual(
    { secure: tls.secure, host: tls.host, port: tls.port, user: tls.user, pass: tls.pass },
    { secure: true, host: 'mail.example.com', port: 465, user: 'user@example.com', pass: 'p@ss' },
  );
  const plain = parseSmtpUrl('smtp://mail.example.com:2525');
  assert.equal(plain.secure, false);
  assert.equal(plain.port, 2525);
  assert.throws(() => parseSmtpUrl('https://mail.example.com'), /smtp:\/\/ or smtps:\/\//);
  assert.throws(() => parseSmtpUrl('not a url'), /smtp:\/\/ or smtps:\/\//);
});

test('formatEmailMessage emits headers, CRLF, and dot-stuffed body lines', () => {
  const raw = formatEmailMessage({ from: 'q@example.com', to: 'c@example.com', subject: 'Your estimate', body: 'Line one\n.hidden\nLine three' });
  assert.match(raw, /^From: q@example\.com\r\nTo: c@example\.com\r\nSubject: Your estimate\r\n/);
  assert.match(raw, /\r\n\.\.hidden\r\n/);
  assert.ok(raw.endsWith('\r\n.'));
  // Header injection via subject is flattened: the smuggled text stays inert
  // on the Subject line and can never become a header line of its own.
  const evil = formatEmailMessage({ from: 'q@example.com', to: 'c@example.com', subject: 'Hi\r\nBcc: x@y.z', body: 'b' });
  assert.ok(!evil.split('\r\n').some((line) => line.startsWith('Bcc:')));
  assert.match(evil, /^Subject: Hi Bcc: x@y\.z\r\n/m);
});

test('HttpSmsTransport posts JSON with the bearer token and returns the gateway id', async () => {
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return { ok: true, json: async () => ({ id: 'sms-42' }) };
  };
  const transport = new HttpSmsTransport({ url: 'https://sms.example.com/send', token: 'tok-123', from: '+15550001111', fetchImpl: fakeFetch });
  const sent = await transport.send({ to: '+15559998888', body: 'Hello' });
  assert.equal(sent.id, 'sms-42');
  assert.equal(captured.url, 'https://sms.example.com/send');
  assert.equal(captured.init.headers.Authorization, 'Bearer tok-123');
  assert.deepEqual(JSON.parse(captured.init.body), { from: '+15550001111', to: '+15559998888', body: 'Hello' });
});

test('HttpSmsTransport fails closed on gateway errors and refuses non-HTTPS URLs', async () => {
  const failing = new HttpSmsTransport({ url: 'https://sms.example.com/send', token: 't', from: '+1', fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  await assert.rejects(() => failing.send({ to: '+2', body: 'x' }), /SMS delivery failed/);
  assert.throws(() => new HttpSmsTransport({ url: 'http://sms.example.com/send', token: 't', from: '+1' }), /HTTPS/);
});

test('buildMessaging wires only the configured providers', () => {
  const none = buildMessaging({});
  assert.equal(none.email, null);
  assert.equal(none.sms, null);
  const dry = buildMessaging({ emailProvider: 'outbox', smsProvider: 'outbox' });
  assert.ok(dry.email instanceof OutboxTransport);
  assert.ok(dry.sms instanceof OutboxTransport);
  const smtp = buildMessaging({ emailProvider: 'smtp', smtpUrl: 'smtps://mail.example.com', emailFrom: 'q@example.com' });
  assert.ok(smtp.email instanceof SmtpTransport);
});

test('message composers carry the verified figures and links', () => {
  const lead = { 'Customer Name': 'Demo Client A', Service: 'Deep Clean' };
  const estimate = { total: 349, base: 180, bedroomCharge: 75, bathroomCharge: 70, areaCharge: 24, addonCharge: 0, minimum: 220, multiplier: 1 };
  const email = estimateEmail({ companyName: 'Evergreen Cleaning', lead, estimate });
  assert.match(email.subject, /\$349\.00/);
  assert.match(email.body, /Demo Client A/);
  assert.match(email.body, /subject to final scope verification/i);
  const sms = estimateSms({ companyName: 'Evergreen Cleaning', lead, estimate });
  assert.match(sms.body, /\$349\.00/);
  const follow = followupEmail({ companyName: 'Evergreen Cleaning', lead, estimate });
  assert.match(follow.body, /\$349\.00/);
  const booking = bookingConfirmation({ companyName: 'Evergreen Cleaning', lead, booking: { 'Booked Date': '2026-12-01', Amount: 349 } });
  assert.match(booking.subject, /2026-12-01/);
  assert.match(booking.smsBody, /confirmed/);
  assert.match(verifyEmailMessage({ companyName: 'Evergreen Cleaning', link: '/verify-email?token=abc' }).body, /token=abc/);
  assert.match(resetEmailMessage({ link: '/reset-password?token=xyz' }).body, /token=xyz/);
});

// --- Live-provider paths: SKIPPED, never faked. ---
test('SmtpTransport live send against a real mail server', { skip: 'requires a live SMTP server — not available in this environment' }, () => {
  throw new Error('must never run without a live server');
});

test('HttpSmsTransport live send against a real gateway account', { skip: 'requires live QP_SMS_API_URL / QP_SMS_API_TOKEN — not available in this environment' }, () => {
  throw new Error('must never run without credentials');
});

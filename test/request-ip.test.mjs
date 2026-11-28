// Client IP resolution — src/lib/request-ip.mjs (pure, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestIP } from '../src/lib/request-ip.mjs';

test('non-Vercel mode uses the socket address and ignores forwarded headers', () => {
  const req = { headers: { 'x-forwarded-for': '198.51.100.99' }, socket: { remoteAddress: '203.0.113.7' } };
  assert.equal(requestIP(req, {}), '203.0.113.7');
  assert.equal(requestIP(req, { vercelRuntime: false }), '203.0.113.7');
});

test('non-Vercel mode falls back to "unknown" without a valid socket address', () => {
  assert.equal(requestIP({ headers: {}, socket: {} }, {}), 'unknown');
  assert.equal(requestIP({ headers: {} }, {}), 'unknown');
});

test('Vercel mode trusts x-vercel-forwarded-for and takes the first entry', () => {
  const req = { headers: { 'x-vercel-forwarded-for': '198.51.100.23, 10.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(requestIP(req, { vercelRuntime: true }), '198.51.100.23');
});

test('Vercel mode fails closed when the trusted header is missing or invalid', () => {
  assert.throws(() => requestIP({ headers: {}, socket: {} }, { vercelRuntime: true }), /Trusted client identity/);
  assert.throws(() => requestIP({ headers: { 'x-vercel-forwarded-for': 'not-an-ip' } }, { vercelRuntime: true }), /Trusted client identity/);
});

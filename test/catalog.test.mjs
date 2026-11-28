// Configurable service catalog — src/lib/validators.mjs (feature 9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SERVICES, parseServiceCatalog, serviceCatalogInput, leadInput, pricingInput } from '../src/lib/validators.mjs';

const lead = { name: 'Jane', email: 'j@example.com', bedrooms: 1, bathrooms: 1, squareFeet: 900, postal: '11214' };

test('parseServiceCatalog falls back to the built-in three on empty/invalid input', () => {
  assert.deepEqual(parseServiceCatalog(''), DEFAULT_SERVICES);
  assert.deepEqual(parseServiceCatalog(undefined), DEFAULT_SERVICES);
  assert.deepEqual(parseServiceCatalog('   '), DEFAULT_SERVICES);
});

test('parseServiceCatalog parses stored lists and dedupes', () => {
  assert.deepEqual(parseServiceCatalog('Window Cleaning\nDeep Clean, Window Cleaning; Move-In/Out'), ['Window Cleaning', 'Deep Clean', 'Move-In/Out']);
});

test('serviceCatalogInput validates the owner-supplied list', () => {
  assert.deepEqual(serviceCatalogInput({ services: ['Window Cleaning', 'Deep Clean', 'Window Cleaning'] }), ['Window Cleaning', 'Deep Clean']);
  assert.throws(() => serviceCatalogInput({ services: [] }), /1-25/);
  assert.throws(() => serviceCatalogInput({ services: 'Deep Clean' }), /1-25/);
  assert.throws(() => serviceCatalogInput({ services: [''] }), /Service name/);
});

test('leadInput and pricingInput validate against the tenant catalog', () => {
  const catalog = ['Window Cleaning'];
  assert.equal(leadInput({ ...lead, service: 'Window Cleaning' }, catalog)['Service'], 'Window Cleaning');
  assert.throws(() => leadInput({ ...lead, service: 'Deep Clean' }, catalog), /Unsupported service/);
  // Default behavior is unchanged for existing callers.
  assert.equal(leadInput({ ...lead, service: 'Deep Clean' })['Service'], 'Deep Clean');
  const rule = { base: 100, perBedroom: 10, perBathroom: 10, per1000: 5, minimum: 90, multiplier: 1 };
  assert.equal(pricingInput({ ...rule, service: 'Window Cleaning' }, catalog)['Service'], 'Window Cleaning');
  assert.throws(() => pricingInput({ ...rule, service: 'Deep Clean' }, catalog), /Unsupported pricing service/);
});

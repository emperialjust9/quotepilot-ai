// Input validation — src/lib/validators.mjs (pure, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpError, requiredString, optionalString, optionalEmail, quantity,
  area, postal, isoDate, leadInput, pricingInput,
} from '../src/lib/validators.mjs';

test('HttpError carries a status', () => {
  const err = new HttpError(422, 'nope');
  assert.equal(err.status, 422);
  assert.equal(err.message, 'nope');
});

test('requiredString trims and enforces 1..max characters', () => {
  assert.equal(requiredString('  Jane  ', 'Name'), 'Jane');
  assert.throws(() => requiredString('   ', 'Name'), /Name/);
  assert.throws(() => requiredString(42, 'Name'), /must be text/);
  assert.throws(() => requiredString('x'.repeat(121), 'Name'), /1-120/);
});

test('optionalString allows empty and bounds length', () => {
  assert.equal(optionalString(undefined, 'Phone'), '');
  assert.equal(optionalString(null, 'Phone'), '');
  assert.equal(optionalString('', 'Phone'), '');
  assert.equal(optionalString(' 555 ', 'Phone'), '555');
  assert.throws(() => optionalString('x'.repeat(501), 'Phone'), /invalid/);
});

test('optionalEmail normalizes case and validates shape', () => {
  assert.equal(optionalEmail(''), '');
  assert.equal(optionalEmail(undefined), '');
  assert.equal(optionalEmail('Jane@Example.COM'), 'jane@example.com');
  assert.throws(() => optionalEmail('not-an-email'), /Email is invalid/);
});

test('quantity requires an integer inside the range', () => {
  assert.equal(quantity('3', 'Bedrooms', 0, 30), 3);
  assert.throws(() => quantity(2.5, 'Bedrooms', 0, 30), /integer/);
  assert.throws(() => quantity(31, 'Bedrooms', 0, 30), /integer/);
  assert.throws(() => quantity('abc', 'Bedrooms', 0, 30), /integer/);
});

test('area enforces the 100..20000 sq ft band', () => {
  assert.equal(area(1500), 1500);
  assert.throws(() => area(99), /Square Feet/);
  assert.throws(() => area(20001), /Square Feet/);
});

test('postal accepts US ZIP and ZIP+4 only', () => {
  assert.equal(postal('11214'), '11214');
  assert.equal(postal('11214-1234'), '11214-1234');
  assert.throws(() => postal('1121'), /ZIP/);
  assert.throws(() => postal('ABCDE'), /ZIP/);
});

test('isoDate requires a real YYYY-MM-DD calendar date', () => {
  assert.equal(isoDate('2026-12-01'), '2026-12-01');
  assert.throws(() => isoDate('2026-02-30'), /YYYY-MM-DD/);
  assert.throws(() => isoDate('12/01/2026'), /YYYY-MM-DD/);
});

test('leadInput maps a valid submission to storage fields', () => {
  const lead = leadInput({
    name: '  Jane Doe ', email: 'Jane@Example.com', phone: '',
    service: 'Deep Clean', bedrooms: 3, bathrooms: 2, squareFeet: 1600,
    postal: '11214', frequency: 'Weekly', requestedDate: '2026-12-01',
    notes: 'Gate code 1', consent: true,
  });
  assert.equal(lead['Customer Name'], 'Jane Doe');
  assert.equal(lead['Customer Email'], 'jane@example.com');
  assert.equal(lead['Service'], 'Deep Clean');
  assert.equal(lead['Bedrooms'], 3);
  assert.equal(lead['Square Feet'], 1600);
  assert.equal(lead['Postal Code'], '11214');
  assert.equal(lead['Frequency'], 'Weekly');
  assert.equal(lead['Requested Date'], '2026-12-01');
  assert.equal(lead['Consent To Follow Up'], true);
  assert.equal(lead['Opted Out'], false);
  assert.equal(lead['Stage'], 'Needs Review');
  assert.equal(lead['Lead Source'], 'Website');
});

test('leadInput requires email or phone, and a supported service', () => {
  const base = { name: 'Jane', service: 'Deep Clean', bedrooms: 1, bathrooms: 1, squareFeet: 900, postal: '11214' };
  assert.throws(() => leadInput(base), /email or phone/);
  assert.throws(() => leadInput({ ...base, email: 'j@example.com', service: 'Window Wash' }), /Unsupported service/);
});

test('leadInput defaults an unknown frequency to Once', () => {
  const lead = leadInput({
    name: 'Jane', phone: '555-0100', service: 'Standard Clean',
    bedrooms: 1, bathrooms: 1, squareFeet: 900, postal: '11214', frequency: 'Daily',
  });
  assert.equal(lead['Frequency'], 'Once');
  assert.equal(lead['Requested Date'], undefined);
});

test('pricingInput maps a valid rule and bounds its values', () => {
  const rule = pricingInput({
    service: 'Standard Clean', base: 110, perBedroom: '20', perBathroom: 25,
    per1000: 10, minimum: 130, flatAddon: 0, multiplier: 1.5,
  });
  assert.deepEqual(rule, {
    'Service': 'Standard Clean', 'Base Price': 110, 'Per Bedroom': 20,
    'Per Bathroom': 25, 'Per 1000 Sq Ft': 10, 'Minimum Price': 130,
    'Flat Addon': 0, 'Multiplier': 1.5,
  });
  assert.throws(() => pricingInput({ service: 'Standard Clean', base: 1, perBedroom: 1, perBathroom: 1, per1000: 1, minimum: 1, multiplier: 6 }), /Multiplier/);
  assert.throws(() => pricingInput({ service: 'Standard Clean', base: '10.999', perBedroom: 1, perBathroom: 1, per1000: 1, minimum: 1 }), /monetary amount/);
  assert.throws(() => pricingInput({ service: 'Standard Clean', base: -5, perBedroom: 1, perBathroom: 1, per1000: 1, minimum: 1 }), /monetary amount/);
  assert.throws(() => pricingInput({ service: 'Roof Wash', base: 1, perBedroom: 1, perBathroom: 1, per1000: 1, minimum: 1 }), /Unsupported pricing service/);
});

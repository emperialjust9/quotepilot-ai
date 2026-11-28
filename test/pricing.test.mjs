// Deterministic pricing engine — src/lib/pricing.mjs (pure, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { cents, computeEstimate } from '../src/lib/pricing.mjs';

// Mirrors the fictional demo rule DEMO-STD-v1 in src/storage/demo.mjs.
const stdRule = {
  'Base Price': 110, 'Per Bedroom': 20, 'Per Bathroom': 25,
  'Per 1000 Sq Ft': 10, 'Minimum Price': 130, 'Flat Addon': 0,
  Multiplier: 1, Version: 1, Approved: false,
};
const lead = { Bedrooms: 2, Bathrooms: 1, 'Square Feet': 1500 };

test('cents converts dollars to integer cents', () => {
  assert.equal(cents(0), 0);
  assert.equal(cents(19.99), 1999);
  assert.equal(cents(110), 11000);
});

test('cents rejects negative, non-finite, and oversized values', () => {
  assert.throws(() => cents(-1), /invalid/);
  assert.throws(() => cents(Number.NaN), /invalid/);
  assert.throws(() => cents(1000001), /invalid/);
  assert.throws(() => cents('10'), /invalid/);
});

test('computeEstimate itemizes a standard estimate', () => {
  const est = computeEstimate(stdRule, lead);
  assert.equal(est.base, 110);
  assert.equal(est.bedroomCharge, 40);
  assert.equal(est.bathroomCharge, 25);
  assert.equal(est.areaCharge, 15);
  assert.equal(est.addonCharge, 0);
  assert.equal(est.subtotal, 190);
  assert.equal(est.total, 190);
  assert.equal(est.minimum, 130);
  assert.equal(est.multiplier, 1);
  assert.equal(est.ruleVersion, 1);
  assert.equal(est.ruleApproved, false);
  // Estimates are internal drafts — never sendable from the product.
  assert.equal(est.canSend, false);
});

test('computeEstimate enforces the rule minimum price', () => {
  const est = computeEstimate(stdRule, { Bedrooms: 0, Bathrooms: 0, 'Square Feet': 100 });
  assert.equal(est.subtotal, 111);
  assert.equal(est.total, 130);
});

test('computeEstimate applies the multiplier after the subtotal', () => {
  const est = computeEstimate({ ...stdRule, Multiplier: 2 }, lead);
  assert.equal(est.subtotal, 190);
  assert.equal(est.total, 380);
});

test('computeEstimate defaults a missing multiplier to 1', () => {
  const { Multiplier, ...noMult } = stdRule;
  const est = computeEstimate(noMult, lead);
  assert.equal(est.multiplier, 1);
  assert.equal(est.total, 190);
});

test('computeEstimate rejects missing rule or lead', () => {
  assert.throws(() => computeEstimate(null, lead), /missing/);
  assert.throws(() => computeEstimate(stdRule, null), /missing/);
});

test('computeEstimate rejects out-of-bounds lead inputs', () => {
  assert.throws(() => computeEstimate(stdRule, { ...lead, Bedrooms: 31 }), /bounds/);
  assert.throws(() => computeEstimate(stdRule, { ...lead, Bedrooms: 1.5 }), /bounds/);
  assert.throws(() => computeEstimate(stdRule, { ...lead, 'Square Feet': 99 }), /bounds/);
  assert.throws(() => computeEstimate(stdRule, { ...lead, 'Square Feet': 20001 }), /bounds/);
});

test('computeEstimate rejects multipliers outside the safe band', () => {
  assert.throws(() => computeEstimate({ ...stdRule, Multiplier: 0.1 }, lead), /Multiplier/);
  assert.throws(() => computeEstimate({ ...stdRule, Multiplier: 5.5 }, lead), /Multiplier/);
});

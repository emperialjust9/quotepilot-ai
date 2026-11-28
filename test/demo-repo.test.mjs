// In-memory demo repository — src/storage/demo.mjs (pure, no credentials).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DemoRepo, DEMO_DATA } from '../src/storage/demo.mjs';

test('list returns only records scoped to the business key', async () => {
  const repo = new DemoRepo();
  const mine = await repo.list('Businesses', 'DEMO-001');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].fields['Company Name'], 'Evergreen Cleaning (FICTIONAL DEMO)');
  const none = await repo.list('Businesses', 'NOPE-999');
  assert.equal(none.length, 0);
});

test('list returns clones — callers cannot mutate stored records', async () => {
  const repo = new DemoRepo();
  const [rec] = await repo.list('Businesses', 'DEMO-001');
  rec.fields['Company Name'] = 'MUTATED';
  const [again] = await repo.list('Businesses', 'DEMO-001');
  assert.equal(again.fields['Company Name'], 'Evergreen Cleaning (FICTIONAL DEMO)');
});

test('get enforces tenant scoping', async () => {
  const repo = new DemoRepo();
  const [rec] = await repo.list('Leads', 'DEMO-001');
  const got = await repo.get('Leads', 'DEMO-001', rec.id);
  assert.equal(got.fields['Lead Key'], 'DEMO-LEAD-001');
  await assert.rejects(() => repo.get('Leads', 'DEMO-002', rec.id), /Record not found/);
});

test('create stamps the business key and update merges fields', async () => {
  const repo = new DemoRepo();
  const created = await repo.create('Follow Ups', 'DEMO-001', { 'Lead Key': 'DEMO-LEAD-001', Note: 'Call Tuesday' });
  assert.equal(created.fields['Business Key'], 'DEMO-001');
  const updated = await repo.update('Follow Ups', 'DEMO-001', created.id, { Note: 'Called' });
  assert.equal(updated.fields.Note, 'Called');
  assert.equal(updated.fields['Lead Key'], 'DEMO-LEAD-001');
  await assert.rejects(() => repo.create('Nope Table', 'DEMO-001', {}), /Table not allowed/);
});

test('DEMO_DATA seed is explicitly fictional', () => {
  for (const biz of DEMO_DATA.Businesses) {
    assert.match(biz['Company Name'], /FICTIONAL/);
  }
});

// Upload validation + storage — src/lib/uploads.mjs (pure / local only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateUpload, MemoryUploadStore, LocalUploadStore, newUploadRef } from '../src/lib/uploads.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.7\n%fake body', 'utf8');

test('validateUpload accepts well-formed files of each binary family', () => {
  assert.equal(validateUpload({ filename: 'photo.png', contentType: 'image/png', data: PNG }).ext, '.png');
  assert.equal(validateUpload({ filename: 'scan.JPG', contentType: 'image/jpeg', data: JPEG }).ext, '.jpg');
  assert.equal(validateUpload({ filename: 'doc.pdf', contentType: 'application/pdf', data: PDF }).contentType, 'application/pdf');
  assert.equal(validateUpload({ filename: 'notes.txt', contentType: 'text/plain', data: Buffer.from('plain notes') }).size, 11);
});

test('validateUpload refuses executables and scripts, however named', () => {
  const mz = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(16)]);
  assert.throws(() => validateUpload({ filename: 'photo.png', contentType: 'image/png', data: mz }), /Executable/);
  assert.throws(() => validateUpload({ filename: 'run.txt', contentType: 'text/plain', data: Buffer.from('#!/bin/sh\nrm -rf /') }), /Executable/);
  assert.throws(() => validateUpload({ filename: 'page.txt', contentType: 'text/plain', data: Buffer.from('<script>alert(1)</script>') }), /does not match/);
});

test('validateUpload refuses type/extension mismatch, bad types, empty and oversize files', () => {
  assert.throws(() => validateUpload({ filename: 'photo.jpg', contentType: 'image/png', data: PNG }), /extension does not match/);
  assert.throws(() => validateUpload({ filename: 'photo.png', contentType: 'image/jpeg', data: PNG }), /does not match/);
  assert.throws(() => validateUpload({ filename: 'app.exe', contentType: 'application/octet-stream', data: PNG }), /not allowed/);
  assert.throws(() => validateUpload({ filename: 'photo.png', contentType: 'image/png', data: Buffer.alloc(0) }), /empty/);
  assert.throws(() => validateUpload({ filename: 'big.png', contentType: 'image/png', data: Buffer.concat([PNG, Buffer.alloc(2048)]), maxBytes: 1024 }), /size limit/);
  assert.throws(() => validateUpload({ filename: 'bad.txt', contentType: 'text/plain', data: Buffer.from([0xff, 0xfe, 0x41]) }), /does not match/);
});

test('MemoryUploadStore round-trips bytes and 404s on unknown refs', async () => {
  const store = new MemoryUploadStore();
  const ref = newUploadRef('.png');
  await store.put(ref, PNG);
  assert.deepEqual(await store.get(ref), PNG);
  await assert.rejects(() => store.get('upl_missing.png'), /not found/);
});

test('LocalUploadStore round-trips via generated names and refuses traversal refs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qp-uploads-'));
  try {
    const store = new LocalUploadStore({ dir });
    const ref = newUploadRef('.pdf');
    await store.put(ref, PDF);
    assert.deepEqual(await store.get(ref), PDF);
    await assert.rejects(() => store.get('../secret.pdf'), /Invalid storage reference/);
    await assert.rejects(() => store.get('upl_missing.pdf'), /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

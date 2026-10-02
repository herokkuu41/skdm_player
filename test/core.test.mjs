import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openVideoConfig,
  parseDriveFileId,
  sealVideoConfig
} from '../lib/core.mjs';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz12345';
const SECRET = 'this-is-a-test-secret-that-is-definitely-long-enough';

test('parses standard Drive links', () => {
  assert.equal(parseDriveFileId(`https://drive.google.com/file/d/${ID}/view?usp=sharing`), ID);
  assert.equal(parseDriveFileId(`https://drive.google.com/open?id=${ID}`), ID);
  assert.equal(parseDriveFileId(`https://drive.google.com/uc?export=download&id=${ID}`), ID);
  assert.equal(parseDriveFileId(ID), ID);
});

test('rejects non-Google hosts', () => {
  assert.throws(() => parseDriveFileId(`https://example.com/file/d/${ID}/view`));
});

test('encrypts and decrypts a watch config', () => {
  const token = sealVideoConfig({ fileId: ID, title: 'My Video', expiresAt: 0 }, SECRET, 1_000_000);
  assert.ok(!token.includes(ID));
  const value = openVideoConfig(token, SECRET, 1_000_100);
  assert.equal(value.fileId, ID);
  assert.equal(value.title, 'My Video');
});

test('detects tampering', () => {
  const token = sealVideoConfig({ fileId: ID, title: 'My Video', expiresAt: 0 }, SECRET);
  const parts = token.split('.');
  const c = Buffer.from(parts[1], 'base64url');
  c[0] ^= 1;
  parts[1] = c.toString('base64url');
  assert.throws(() => openVideoConfig(parts.join('.'), SECRET));
});

test('expires links', () => {
  const token = sealVideoConfig({ fileId: ID, title: 'My Video', expiresAt: 2_000_000 }, SECRET, 1_000_000);
  assert.throws(() => openVideoConfig(token, SECRET, 2_001_000), /expired/i);
});

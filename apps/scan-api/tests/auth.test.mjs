import assert from 'node:assert/strict';
import test from 'node:test';
import { hashPassword, verifyPassword } from '../src/auth.mjs';

test('scrypt password encoding verifies and rejects malformed parameters', () => {
  const encoded=hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(verifyPassword('wrong', encoded), false);
  assert.equal(verifyPassword('correct horse battery staple', encoded.replace('$16384$', '$1024$')), false);
  assert.equal(verifyPassword('correct horse battery staple', encoded.replace(/\$[0-9a-f]{64}$/i, '$00')), false);
});

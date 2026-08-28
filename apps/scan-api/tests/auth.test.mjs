import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuthenticator,hashPassword, verifyPassword } from '../src/auth.mjs';

test('scrypt password encoding verifies and rejects malformed parameters', () => {
  const encoded=hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(verifyPassword('wrong', encoded), false);
  assert.equal(verifyPassword('correct horse battery staple', encoded.replace('$16384$', '$1024$')), false);
  assert.equal(verifyPassword('correct horse battery staple', encoded.replace(/\$[0-9a-f]{64}$/i, '$00')), false);
});

test('local authentication excludes revoked sessions at the database boundary',async()=>{let query;const db={query:async(sql)=>{query=sql;return{rowCount:0,rows:[]};}},authenticate=await createAuthenticator({AUTH_MODE:'local',db,SESSION_COOKIE_NAME:'reliacode_session'});assert.equal(await authenticate({headers:{cookie:'reliacode_session=token'}}),null);assert.match(query,/revoked_at IS NULL/);});

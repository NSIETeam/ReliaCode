import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('offsite backup is not marked verified until archive and manifest uploads succeed', () => {
  const script = read('backup-postgres.sh');
  const archiveUpload = script.indexOf('aws s3 cp "$encrypted"');
  const manifestUpload = script.indexOf('aws s3 cp "$manifest"');
  const verifiedRecord = script.indexOf("'VERIFIED'");
  assert.ok(archiveUpload >= 0 && manifestUpload > archiveUpload && verifiedRecord > manifestUpload);
  assert.match(script, /-v object_uri=/);
  assert.match(script, /archive_version_id=.*head-object/);
  assert.match(script, /manifest_version_id=.*head-object/);
  assert.match(script, /Backup bucket versioning is required/);
  assert.doesNotMatch(script, /sed "s\/'\/''\/g"/);
});

test('restore drill validates encrypted bytes, archive readability, schema and forced RLS', () => {
  const script = read('restore-drill.sh');
  assert.match(script, /sha256sum --check/);
  assert.match(script, /Backup manifest filename does not match ciphertext/);
  assert.match(script, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(script, /pg_restore --list/);
  assert.match(script, /required schema migration is missing/i);
  assert.match(script, /relforcerowsecurity/);
  assert.match(script, /RESTORE_DATABASE_URL must contain reliacode_drill/);
  assert.match(script, /BACKUP_OBJECT_VERSION_ID is required/);
  assert.match(script, /BACKUP_MANIFEST_VERSION_ID is required/);
  assert.match(script, /get-object --bucket "\$object_bucket" --key "\$object_key" --version-id "\$BACKUP_OBJECT_VERSION_ID"/);
});

test('encrypted backup verification requires an offline identity and inspects plaintext only after decryption', () => {
  const script = read('verify-backup.sh');
  assert.match(script, /AGE_IDENTITY_FILE is required to inspect an encrypted backup/);
  assert.match(script, /Backup manifest filename does not match backup/);
  assert.match(script, /age --decrypt --identity "\$identity" --output "\$archive" "\$backup"/);
  assert.match(script, /pg_restore --list "\$archive"/);
  assert.doesNotMatch(script, /pg_restore --list "\$backup"/);
});

test('backup verifier rejects a valid checksum that names a different file', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'reliacode-backup-verify-'));
  t.after(() => rmSync(root, { recursive:true, force:true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pg_restore'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'pg_restore'), 0o700);
  const backup = join(root, 'selected.dump');
  const body = Buffer.from('custom-archive-test');
  writeFileSync(backup, body);
  const checksum = createHash('sha256').update(body).digest('hex');
  const manifest = `${backup}.sha256`;
  writeFileSync(manifest, `${checksum}  different.dump\n`);
  const result = spawnSync('/bin/sh', [new URL('../verify-backup.sh', import.meta.url).pathname, backup, manifest], {
    env:{ ...process.env, PATH:`${bin}:${process.env.PATH}` }, encoding:'utf8'
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /manifest filename does not match backup/i);
});

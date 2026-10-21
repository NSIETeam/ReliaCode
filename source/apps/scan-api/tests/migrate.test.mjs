import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('multi-statement SQL migrations use PostgreSQL simple query protocol', () => {
  const source = readFileSync(new URL('../src/migrate.mjs', import.meta.url), 'utf8');
  assert.match(source, /client\.query\(\{\s*text:sql,\s*queryMode:"simple"\s*\}\)/);
  assert.doesNotMatch(source, /client\.query\(sql\)/);
});

test('migration discovery rejects hidden and editor-generated SQL files', () => {
  const source = readFileSync(new URL('../src/migrate.mjs', import.meta.url), 'utf8');
  assert.match(source, /Only numbered migrations are executable/);
  assert.doesNotMatch(source, /file\.endsWith\("\.sql"\)/);
});

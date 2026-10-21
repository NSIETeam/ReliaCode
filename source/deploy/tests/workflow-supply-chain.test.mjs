import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const workflowDir = new URL('../../.github/workflows/', import.meta.url);

test('every external GitHub Action is pinned to a full commit SHA', () => {
  for (const name of readdirSync(workflowDir).filter((file) => file.endsWith('.yml'))) {
    const source = readFileSync(new URL(name, workflowDir), 'utf8');
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const reference = match[1];
      if (reference.startsWith('./')) continue;
      assert.match(reference, /@[0-9a-f]{40}$/, `${name} has an unpinned Action: ${reference}`);
    }
  }
});

test('main CI enforces operations contracts and audits every production workspace', () => {
  const ci = readFileSync(new URL('ci.yml', workflowDir), 'utf8');
  assert.match(ci, /npm run test:ops/);
  assert.match(ci, /npm audit --omit=dev --audit-level=high/);
  assert.doesNotMatch(ci, /npm audit --workspace/);
});

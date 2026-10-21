import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWorkspace } from '../src/routes.mjs';

test('invalid workspace payloads are client errors', () => {
  assert.throws(() => parseWorkspace(undefined), (error) => error.code === 'WORKSPACE_INVALID' && error.statusCode === 400);
  assert.throws(() => parseWorkspace(null), (error) => error.code === 'WORKSPACE_INVALID' && error.statusCode === 400);
  assert.throws(() => parseWorkspace('{not-json'), (error) => error.statusCode === 400);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => parseWorkspace(cyclic), (error) => error.code === 'WORKSPACE_INVALID' && error.statusCode === 400);
});

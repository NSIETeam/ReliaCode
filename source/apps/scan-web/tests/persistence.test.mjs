import assert from "node:assert/strict";
import test from "node:test";
import { createPersistenceQueue, createLocalStorageAdapter, isWorkspaceState, parseWorkspaceResponse } from "../persistence.mjs";

const workspace = {
  schemaVersion: 1, initialized: true, workspace: { id: "workspace", brandName: "Acme", createdAt: "now" },
  accounts: [], products: [], codeBatches: [], objects: {}, events: [], campaigns: [], ledger: [], risks: [], agentRuns: []
};

test("single-flight queue flushes a mutation that arrives during a write", async () => {
  let release;
  let writes = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const queue = createPersistenceQueue({ delay: 50, jitter: 0, write: async () => { writes += 1; if (writes === 1) await gate; } });
  queue.markDirty();
  await new Promise((resolve) => setTimeout(resolve, 60));
  queue.markDirty();
  release();
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(writes, 2);
});

test("409 blocks automatic retries and exposes a conflict", async () => {
  let writes = 0;
  let conflict;
  const queue = createPersistenceQueue({ delay: 50, jitter: 0, write: async () => { writes += 1; const error = new Error("conflict"); error.status = 409; throw error; }, onConflict: (error) => { conflict = error; } });
  queue.markDirty();
  await new Promise((resolve) => setTimeout(resolve, 130));
  queue.markDirty();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(writes, 1);
  assert.equal(conflict.status, 409);
  assert.deepEqual(queue.status, { dirty: true, running: false, blocked: true, online: true, retryAttempt: 0 });
});

test("network failures back off and resume after going online", async () => {
  let writes = 0;
  const queue = createPersistenceQueue({ delay: 50, maxDelay: 200, jitter: 0, write: async () => { writes += 1; if (writes === 1) throw new Error("offline"); } });
  queue.markDirty();
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(writes, 1);
  assert.equal(queue.status.dirty, true);
  queue.setOnline(false);
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(writes, 1);
  queue.setOnline(true);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(writes, 2);
  assert.equal(queue.status.dirty, false);
});

test("workspace payload validation rejects malformed server responses", () => {
  assert.equal(isWorkspaceState(workspace), true);
  assert.throws(() => parseWorkspaceResponse({ version: 1, workspace: { initialized: true } }), /工作区数据无效/);
  assert.equal(parseWorkspaceResponse({ version: "2", workspace }).version, 2);
});

test("local storage adapter safely restores and clears blocked queue state", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const adapter = createLocalStorageAdapter({ storage, key: "queue" });
  let writes = 0;
  const first = createPersistenceQueue({ adapter, delay: 50, jitter: 0, write: async () => { writes += 1; const error = new Error("conflict"); error.status = 409; throw error; } });
  first.markDirty(); await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(first.status.blocked, true);
  const restored = createPersistenceQueue({ adapter, delay: 50, jitter: 0, write: async () => { writes += 1; } });
  assert.equal(restored.status.blocked, true);
  await restored.retry();
  assert.equal(restored.status.dirty, false);
  assert.equal(writes, 2);
  restored.markDirty(); restored.clear();
  assert.equal(adapter.load(), null);
});
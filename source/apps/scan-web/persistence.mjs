/**
 * Side-effect-free persistence primitives used by the browser app and tests.
 * A stale-version conflict blocks automatic retries until the user resolves it.
 */
export function createPersistenceQueue({ write, delay = 500, maxDelay = 30_000, jitter = 0.2, random = Math.random, online = true, onConflict = () => {}, onError = () => {}, adapter = null, storageAdapter = null, snapshotKey = null } = {}) {
  if (typeof write !== "function") throw new TypeError("write must be a function");
  const baseDelay = Math.max(50, Number(delay) || 500);
  const retryMaxDelay = Math.max(baseDelay, Number(maxDelay) || 30_000);
  let dirty = false;
  let running = false;
  let blocked = false;
  let isOnline = online !== false;
  let retryAttempt = 0;
  let dirtyGeneration = 0;
  let timer = null;
  const persistence = adapter || storageAdapter || (snapshotKey ? createLocalStorageAdapter({ key: snapshotKey }) : null);
  const snapshot = () => ({ schemaVersion: 1, dirty, blocked, retryAttempt, dirtyGeneration });
  const saveSnapshot = () => { try { persistence?.save(snapshot()); } catch {} };
  const restored = (() => { try { return persistence?.load?.(); } catch { return null; } })();
  if (restored?.schemaVersion === 1) { dirty = restored.dirty === true; blocked = restored.blocked === true; retryAttempt = Number.isInteger(restored.retryAttempt) && restored.retryAttempt >= 0 ? restored.retryAttempt : 0; dirtyGeneration = Number.isInteger(restored.dirtyGeneration) ? restored.dirtyGeneration : 0; }
  const schedule = () => {
    if (!dirty || running || blocked || !isOnline) return;
    clearTimeout(timer);
    const exponential = Math.min(retryMaxDelay, baseDelay * (2 ** Math.min(retryAttempt, 10)));
    const spread = Math.max(0, Math.min(0.5, Number(jitter) || 0));
    const offset = exponential * spread * ((Number(random()) || 0) * 2 - 1);
    timer = setTimeout(flush, Math.max(50, Math.round(exponential + offset)));
  };
  const flush = async () => {
    if (!dirty || running || blocked || !isOnline) return false;
    clearTimeout(timer);
    timer = null;
    running = true;
    const generation = dirtyGeneration;
    try {
      await write();
      if (dirtyGeneration===generation) dirty = false;
      retryAttempt = 0;
      saveSnapshot();
      return true;
    } catch (error) {
      dirty = true;
      if (error?.status === 409) { blocked = true; onConflict(error); }
      else { retryAttempt += 1; onError(error); }
      saveSnapshot();
      return false;
    } finally {
      running = false;
      schedule();
    }
  };
  const markDirty = () => {
    dirty = true;
    dirtyGeneration += 1;
    saveSnapshot();
    schedule();
  };
  if (dirty && isOnline && !blocked) schedule();
  return {
    markDirty,
    flush,
    clearConflict() { blocked = false; retryAttempt = 0; markDirty(); },
    retry() { blocked = false; retryAttempt = 0; saveSnapshot(); return flush(); },
    clear() { dirty = false; blocked = false; retryAttempt = 0; dirtyGeneration += 1; clearTimeout(timer); timer = null; try { persistence?.clear?.(); } catch {} return true; },
    setOnline(value) { isOnline = value !== false; if (isOnline) schedule(); else { clearTimeout(timer); timer = null; } },
    get status() { return { dirty, running, blocked, online: isOnline, retryAttempt }; }
  };
}

export function isWorkspaceState(value) {
  return Boolean(value && value.schemaVersion === 1 && value.initialized === true &&
    value.workspace && typeof value.workspace === "object" && Array.isArray(value.accounts) &&
    Array.isArray(value.products) && Array.isArray(value.codeBatches) && value.objects &&
    typeof value.objects === "object" && Array.isArray(value.events) && Array.isArray(value.campaigns) &&
    Array.isArray(value.ledger) && Array.isArray(value.risks) && Array.isArray(value.agentRuns));
}

export function parseWorkspaceResponse(body) {
  if (!body || !Number.isInteger(Number(body.version)) || !isWorkspaceState(body.workspace)) {
    const error = new Error("服务器返回的工作区数据无效");
    error.code = "INVALID_WORKSPACE_PAYLOAD";
    throw error;
  }
  return { ...body, version: Number(body.version) };
}

/** Defensive localStorage adapter; storage failures and malformed snapshots are ignored. */
export function createLocalStorageAdapter({ storage = globalThis.localStorage, key = "reliacode-persistence-queue-v1", parse = JSON.parse, stringify = JSON.stringify } = {}) {
  const valid = storage && typeof storage.getItem === "function" && typeof storage.setItem === "function";
  return {
    load() { if (!valid) return null; try { const raw=storage.getItem(key); if (!raw) return null; const value=parse(raw); return value && typeof value === "object" ? value : null; } catch { return null; } },
    save(value) { if (!valid) return false; try { storage.setItem(key,stringify(value)); return true; } catch { return false; } },
    clear() { if (!storage || typeof storage.removeItem !== "function") return false; try { storage.removeItem(key); return true; } catch { return false; } }
  };
}
export function createMemoryStorageAdapter(initial = null) { let value=initial; return { load:()=>value, save:(next)=>{value=next; return true;}, clear:()=>{value=null; return true;} }; }
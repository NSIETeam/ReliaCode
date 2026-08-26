/**
 * Side-effect-free persistence primitives used by the browser app and tests.
 * A stale-version conflict blocks automatic retries until the user resolves it.
 */
export function createPersistenceQueue({ write, delay = 500, maxDelay = 30_000, jitter = 0.2, random = Math.random, online = true, onConflict = () => {}, onError = () => {} }) {
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
      return true;
    } catch (error) {
      dirty = true;
      if (error?.status === 409) { blocked = true; onConflict(error); }
      else { retryAttempt += 1; onError(error); }
      return false;
    } finally {
      running = false;
      schedule();
    }
  };
  const markDirty = () => {
    dirty = true;
    dirtyGeneration += 1;
    schedule();
  };
  return {
    markDirty,
    flush,
    clearConflict() { blocked = false; retryAttempt = 0; markDirty(); },
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

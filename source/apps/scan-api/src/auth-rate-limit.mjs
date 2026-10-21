import { createHmac } from "node:crypto";

export const AUTH_RATE_LIMIT_WINDOW_MS = 300_000;
export const AUTH_RATE_LIMIT_BLOCK_MS = 300_000;
export const AUTH_RATE_LIMIT_MAX_FAILURES = 5;

export function authRateLimitKey(secret, scope, ...components) {
  if (!secret) throw new TypeError("A rate-limit key secret is required");
  return createHmac("sha256", secret)
    .update([scope, ...components].map((value) => String(value || "").trim().toLowerCase()).join("\0"))
    .digest("hex");
}

export async function authenticationBlocked(db, keyHash) {
  const result = await db.query(
    `SELECT blocked_until>now() blocked
       FROM authentication_rate_limits
      WHERE key_hash=$1 AND expires_at>now()`,
    [keyHash]
  );
  return result.rows[0]?.blocked === true;
}

export async function recordAuthenticationFailure(db, keyHash, {
  maxFailures = AUTH_RATE_LIMIT_MAX_FAILURES,
  windowMs = AUTH_RATE_LIMIT_WINDOW_MS,
  blockMs = AUTH_RATE_LIMIT_BLOCK_MS
} = {}) {
  const run = db.transaction ? (work) => db.transaction(work) : (work) => work({ query:db.query.bind(db) });
  return run(async (client) => {
    await client.query(
      `DELETE FROM authentication_rate_limits WHERE key_hash IN (
         SELECT key_hash FROM authentication_rate_limits WHERE expires_at<=now() ORDER BY expires_at LIMIT 100
      )`
    );
    // The advisory lock also serializes the first failure, before a row exists
    // for SELECT ... FOR UPDATE to lock.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [keyHash]);
    const databaseClock = await client.query("SELECT clock_timestamp() database_now");
    const current = await client.query(
      `SELECT failure_count,window_started_at,blocked_until
         FROM authentication_rate_limits WHERE key_hash=$1 FOR UPDATE`,
      [keyHash]
    );
    const now = new Date(databaseClock.rows[0].database_now).getTime();
    if (!Number.isFinite(now)) throw new Error("Database clock is unavailable");
    const row = current.rows[0];
    const windowExpired = !row || Date.parse(row.window_started_at) + windowMs <= now;
    const count = windowExpired ? 1 : Number(row.failure_count) + 1;
    const blockedUntil = count >= maxFailures ? new Date(now + blockMs) : null;
    const expiresAt = blockedUntil || new Date(now + windowMs);
    if (!row) {
      await client.query(
        `INSERT INTO authentication_rate_limits(key_hash,failure_count,window_started_at,blocked_until,expires_at)
         VALUES($1,$2,now(),$3,$4)`,
        [keyHash, count, blockedUntil, expiresAt]
      );
    } else {
      await client.query(
        `UPDATE authentication_rate_limits
            SET failure_count=$2,
                window_started_at=CASE WHEN $3 THEN now() ELSE window_started_at END,
                blocked_until=$4,expires_at=$5,updated_at=now()
          WHERE key_hash=$1`,
        [keyHash, count, windowExpired, blockedUntil, expiresAt]
      );
    }
    return { count, blocked:blockedUntil !== null, blockedUntil };
  });
}

export async function clearAuthenticationFailures(db, keyHash) {
  await db.query("DELETE FROM authentication_rate_limits WHERE key_hash=$1", [keyHash]);
}

export async function cleanupAuthenticationRateLimits(db, limit = 500) {
  const bounded = Math.max(1, Math.min(5_000, Number(limit) || 500));
  return db.query(
    `DELETE FROM authentication_rate_limits WHERE key_hash IN (
       SELECT key_hash FROM authentication_rate_limits WHERE expires_at<=now() ORDER BY expires_at LIMIT $1
     )`,
    [bounded]
  );
}

export async function consumeSharedAuthenticationQuota(db, secret, scope, ip, {
  maxRequests,
  windowMs,
  blockMs = windowMs
}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1) throw new TypeError("maxRequests must be a positive integer");
  if (!Number.isFinite(windowMs) || windowMs < 1) throw new TypeError("windowMs must be positive");
  const keyHash=authRateLimitKey(secret,`request:${scope}`,ip);
  if(await authenticationBlocked(db,keyHash))return{allowed:false,keyHash};
  const result=await recordAuthenticationFailure(db,keyHash,{maxFailures:maxRequests+1,windowMs,blockMs});
  return{allowed:!result.blocked,keyHash,retryAt:result.blockedUntil};
}

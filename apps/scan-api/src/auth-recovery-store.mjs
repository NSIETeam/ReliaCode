/**
 * PostgreSQL persistence for the account-recovery domain service.
 *
 * The store deliberately accepts token hashes only.  Callers must hash the
 * opaque token before invoking any method here; a raw token is never used as
 * a query parameter or persisted value.
 */
export function createPostgresRecoveryStore(db) {
  if (!db || typeof db.query !== "function") throw new TypeError("A database query client is required");

  async function findUserByEmail(normalizedEmail) {
    const result = await db.query(
      `SELECT id, email, email_verified_at
       FROM local_users
       WHERE normalized_email=$1 AND status='ACTIVE'
       LIMIT 1`,
      [normalizedEmail]
    );
    const row = result.rows?.[0];
    return row ? { id: row.id, email: row.email, emailVerifiedAt: row.email_verified_at ?? null } : null;
  }

  async function findActiveToken(tokenHash, purpose) {
    if (!purpose) throw new TypeError("A token purpose is required");
    const result = await db.query(
      `SELECT id, user_id, purpose, expires_at, consumed_at
       FROM local_account_tokens
       WHERE token_hash=$1 AND purpose=$2 AND consumed_at IS NULL AND expires_at > now()
       LIMIT 1`,
      [tokenHash, purpose]
    );
    const row = result.rows?.[0];
    return row ? {
      id: row.id,
      userId: row.user_id,
      purpose: row.purpose,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at ?? null
    } : null;
  }

  async function latestIssuedAt(userId, purpose) {
    const result = await db.query(
      `SELECT requested_at
       FROM local_account_tokens
       WHERE user_id=$1 AND purpose=$2
       ORDER BY requested_at DESC
       LIMIT 1`,
      [userId, purpose]
    );
    return result.rows?.[0]?.requested_at ?? null;
  }

  async function insertToken({ id, userId, purpose, tokenHash, expiresAt, requestedAt }) {
    await db.query(
      `INSERT INTO local_account_tokens
       (id, user_id, purpose, token_hash, expires_at, requested_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, userId, purpose, tokenHash, expiresAt, requestedAt]
    );
  }

  async function consumePasswordReset({ id, consumedAt, passwordHash }) {
    const result = await db.query(
      `WITH consumed AS (
         UPDATE local_account_tokens
         SET consumed_at=$2
         WHERE id=$1 AND purpose='PASSWORD_RESET'
           AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id
       ), updated AS (
       UPDATE local_users AS u
       SET password_hash=$3, updated_at=now()
       FROM consumed
       WHERE u.id=consumed.user_id
       RETURNING u.id,u.tenant_id
       ), revoked AS (
         UPDATE admin_sessions s SET revoked_at=now(),revoked_by='PASSWORD_RESET',revocation_reason='Password was reset'
         FROM updated WHERE s.user_id=updated.id AND s.revoked_at IS NULL RETURNING s.id
       ), security_event AS (
         INSERT INTO authentication_events(tenant_id,user_id,event_type,risk_level,actor_id,reason)
         SELECT tenant_id,id,'SESSION_REVOKED','LOW',id::text,'Password was reset' FROM updated RETURNING id
       ) SELECT id FROM updated`,
      [id, consumedAt, passwordHash]
    );
    return (result.rowCount ?? result.rows?.length ?? 0) > 0;
  }

  async function consumeEmailVerification({ id, userId, consumedAt }) {
    const result = await db.query(
      `WITH consumed AS (
         UPDATE local_account_tokens
         SET consumed_at=$3
         WHERE id=$1 AND user_id=$2 AND purpose='EMAIL_VERIFICATION'
           AND consumed_at IS NULL AND expires_at > now()
         RETURNING user_id
       )
       UPDATE local_users AS u
       SET email_verified_at=COALESCE(u.email_verified_at, $3), updated_at=now()
       FROM consumed
       WHERE u.id=consumed.user_id
       RETURNING u.id`,
      [id, userId, consumedAt]
    );
    return (result.rowCount ?? result.rows?.length ?? 0) > 0;
  }

  // Names below are the persistence-agnostic contract consumed by
  // createAccountRecoveryService.  The shorter names remain available for
  // callers that work directly with the PostgreSQL store.
  return Object.freeze({
    findUserByEmail,
    findActiveToken,
    latestIssuedAt,
    insertToken,
    consumePasswordReset,
    consumeEmailVerification,
    async findLatestAccountToken(userId, purpose) {
      const requestedAt = await latestIssuedAt(userId, purpose);
      return requestedAt == null ? null : { requestedAt };
    },
    createAccountToken: insertToken,
    findAccountTokenByHash: findActiveToken
  });
}

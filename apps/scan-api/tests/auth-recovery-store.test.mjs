import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresRecoveryStore } from "../src/auth-recovery-store.mjs";

function mockDb() {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (text.includes("SELECT id, email, email_verified_at")) {
        return { rowCount: 1, rows: [{ id: "u1", email: "owner@example.com", email_verified_at: null }] };
      }
      if (text.includes("SELECT requested_at")) return { rowCount: 1, rows: [{ requested_at: "2026-01-01T00:00:00.000Z" }] };
      if (text.includes("SELECT id, user_id, purpose, expires_at, consumed_at")) {
        return { rowCount: 1, rows: [{ id: "t1", user_id: "u1", purpose: params[1], expires_at: "2026-01-01T01:00:00.000Z", consumed_at: null }] };
      }
      return { rowCount: 1, rows: [{ id: "u1" }] };
    }
  };
}

test("Postgres store maps users and token timestamps without accepting raw tokens", async () => {
  const db = mockDb();
  const store = createPostgresRecoveryStore(db);
  assert.deepEqual(await store.findUserByEmail("owner@example.com"), {
    id: "u1", email: "owner@example.com", emailVerifiedAt: null
  });
  assert.equal(await store.latestIssuedAt("u1", "PASSWORD_RESET"), "2026-01-01T00:00:00.000Z");
  assert.deepEqual(await store.findActiveToken("sha256-hash", "PASSWORD_RESET"), {
    id: "t1", userId: "u1", purpose: "PASSWORD_RESET",
    expiresAt: "2026-01-01T01:00:00.000Z", consumedAt: null
  });
  await assert.rejects(() => store.findActiveToken("raw-token", ""), /purpose is required/);
  const tokenRead = db.calls.find(({ text }) => text.includes("token_hash=$1"));
  assert.deepEqual(tokenRead.params, ["sha256-hash", "PASSWORD_RESET"]);
  assert.equal(tokenRead.params.includes("raw-token"), false);
  assert.match(tokenRead.text, /consumed_at IS NULL/);
  assert.match(tokenRead.text, /expires_at > now\(\)/);
});

test("insertToken passes only the token hash and preserves purpose", async () => {
  const db = mockDb();
  await createPostgresRecoveryStore(db).insertToken({
    id: "t1", userId: "u1", purpose: "EMAIL_VERIFICATION",
    tokenHash: "sha256-hash", expiresAt: "2026-01-01T01:00:00.000Z",
    requestedAt: "2026-01-01T00:00:00.000Z"
  });
  assert.deepEqual(db.calls[0].params, ["t1", "u1", "EMAIL_VERIFICATION", "sha256-hash", "2026-01-01T01:00:00.000Z", "2026-01-01T00:00:00.000Z"]);
  assert.equal(db.calls[0].params.includes("raw-token"), false);
});

test("password consumption is one atomic CTE and guards purpose, expiry, and reuse", async () => {
  const db = mockDb();
  const result = await createPostgresRecoveryStore(db).consumePasswordReset({
    id: "t1", consumedAt: "2026-01-01T00:10:00.000Z", passwordHash: "scrypt$hash"
  });
  assert.equal(result, true);
  const call = db.calls[0];
  assert.match(call.text, /^\s*WITH consumed AS \(/);
  assert.match(call.text, /UPDATE local_account_tokens/);
  assert.match(call.text, /purpose='PASSWORD_RESET'/);
  assert.match(call.text, /consumed_at IS NULL/);
  assert.match(call.text, /expires_at > now\(\)/);
  assert.match(call.text, /UPDATE local_users/);
  assert.match(call.text, /SET password_hash=\$3/);
  assert.match(call.text, /UPDATE admin_sessions/);
  assert.match(call.text, /revoked_at=now\(\)/);
  assert.match(call.text, /INSERT INTO authentication_events/);
  assert.deepEqual(call.params, ["t1", "2026-01-01T00:10:00.000Z", "scrypt$hash"]);
});

test("email verification consumption atomically marks the matching user", async () => {
  const db = mockDb();
  await createPostgresRecoveryStore(db).consumeEmailVerification({
    id: "t1", userId: "u1", consumedAt: "2026-01-01T00:10:00.000Z"
  });
  const call = db.calls[0];
  assert.match(call.text, /^\s*WITH consumed AS \(/);
  assert.match(call.text, /purpose='EMAIL_VERIFICATION'/);
  assert.match(call.text, /user_id=\$2/);
  assert.match(call.text, /email_verified_at=COALESCE/);
  assert.match(call.text, /UPDATE local_users/);
  assert.deepEqual(call.params, ["t1", "u1", "2026-01-01T00:10:00.000Z"]);
});

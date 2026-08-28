import assert from "node:assert/strict";
import test from "node:test";
import { hashPassword, verifyPassword } from "../src/auth.mjs";
import {
  ACCOUNT_TOKEN_PURPOSE, RecoveryRateLimitError, createAccountRecoveryService,
  generateRecoveryToken, hashRecoveryToken
} from "../src/auth-recovery.mjs";

function fixture() {
  const state = { users: [{ id: "user-1", email: "owner@example.com", emailVerifiedAt:"2025-12-01T00:00:00.000Z" }], tokens: [], passwords: [] };
  const store = {
    state,
    async findUserByEmail(email) { return state.users.find((u) => u.email === email) ?? null; },
    async findLatestAccountToken(userId, purpose) {
      return state.tokens.filter((t) => t.userId === userId && t.purpose === purpose).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0] ?? null;
    },
    async createAccountToken(record) { assert.equal("token" in record, false); state.tokens.push({ ...record, consumedAt: null }); },
    async findAccountTokenByHash(tokenHash) { return state.tokens.find((t) => t.tokenHash === tokenHash) ?? null; },
    async consumePasswordReset({ id, consumedAt, passwordHash }) {
      const row = state.tokens.find((t) => t.id === id);
      if (!row || row.consumedAt) return false;
      row.consumedAt = consumedAt; state.passwords.push({ userId: row.userId, passwordHash }); return true;
    },
    async consumeEmailVerification({ id, userId, consumedAt }) {
      const row = state.tokens.find((t) => t.id === id);
      if (!row || row.consumedAt) return false;
      row.consumedAt = consumedAt; const user = state.users.find((u) => u.id === userId); user.emailVerifiedAt = consumedAt; return true;
    }
  };
  let now = new Date("2026-01-01T00:00:00.000Z");
  let tokenNumber = 0;
  return { state, store, setNow(value) { now = new Date(value); }, service: createAccountRecoveryService({ store, clock: () => now, tokenGenerator: () => `test-token-value-${++tokenNumber}`, passwordHasher: hashPassword }) };
}

test("recovery tokens have sufficient entropy and are persisted only as hashes", async () => {
  const { service, state } = fixture();
  const issued = await service.requestPasswordReset(" Owner@Example.com ");
  assert.equal(issued.token, "test-token-value-1");
  assert.equal(state.tokens[0].tokenHash, hashRecoveryToken(issued.token));
  assert.equal("token" in state.tokens[0], false);
  assert.notEqual(generateRecoveryToken(), generateRecoveryToken());
});

test("unknown addresses receive an enumeration-resistant response", async () => {
  const { service, state } = fixture();
  const result = await service.requestPasswordReset("unknown@example.com");
  assert.deepEqual(result, { accepted: true, delivered: false });
  assert.equal(state.tokens.length, 0);
});

test("unverified email receives the same generic response and no reset token",async()=>{const{service,state}=fixture();state.users[0].emailVerifiedAt=null;const result=await service.requestPasswordReset("owner@example.com");assert.deepEqual(result,{accepted:true,delivered:false});assert.equal(state.tokens.length,0);});

test("requests enforce the minimum interval", async () => {
  const { service, setNow } = fixture();
  await service.requestPasswordReset("owner@example.com");
  setNow("2026-01-01T00:00:30Z");
  await assert.rejects(() => service.requestPasswordReset("owner@example.com"), (error) => error instanceof RecoveryRateLimitError && error.retryAfterMs === 30_000);
});

test("reset token is single-use, expires, and updates with a password hash", async () => {
  const { service, state, setNow } = fixture();
  const issued = await service.requestPasswordReset("owner@example.com");
  const result = await service.confirmPasswordReset(issued.token, "a sufficiently long password");
  assert.deepEqual(result, { userId: "user-1", updated: true });
  assert.equal(verifyPassword("a sufficiently long password", state.passwords[0].passwordHash), true);
  await assert.rejects(() => service.confirmPasswordReset(issued.token, "another sufficiently long password"), /already been used/);
  setNow("2026-01-01T02:00:00Z");
  const expired = await service.requestPasswordReset("owner@example.com");
  setNow("2026-01-01T04:00:00Z");
  await assert.rejects(() => service.confirmPasswordReset(expired.token, "a sufficiently long password"), /expired/);
});

test("email verification uses a distinct purpose and is single-use", async () => {
  const { service, state } = fixture();
  const issued = await service.requestEmailVerification("owner@example.com");
  assert.equal(state.tokens[0].purpose, ACCOUNT_TOKEN_PURPOSE.EMAIL_VERIFICATION);
  assert.deepEqual(await service.confirmEmailVerification(issued.token), { userId: "user-1", verified: true });
  assert.ok(state.users[0].emailVerifiedAt);
  await assert.rejects(() => service.confirmEmailVerification(issued.token), /already been used/);
});

test("wrong token purpose cannot be used for reset", async () => {
  const { service } = fixture();
  const issued = await service.requestEmailVerification("owner@example.com");
  await assert.rejects(() => service.confirmPasswordReset(issued.token, "a sufficiently long password"), /invalid/);
});

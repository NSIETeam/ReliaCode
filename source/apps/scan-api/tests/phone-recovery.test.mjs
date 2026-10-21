import assert from 'node:assert/strict';
import test from 'node:test';
import { createPhoneRecoveryService, generatePhoneOtp, hashPhoneOtp, normalizePhone, PhoneRecoveryError } from '../src/phone-recovery.mjs';

function fixture() {
  const state = { users: [{ id: 'u1', normalizedPhone: '+8613800138000' }], tokens: [], passwords: [] };
  const store = {
    async findUserByPhone(phone) { return state.users.find((u) => u.normalizedPhone === phone) ?? null; },
    async findLatestPhoneOtp(userId) { return state.tokens.filter((t) => t.userId === userId).at(-1) ?? null; },
    async createPhoneOtp(row) { assert.equal('otp' in row, false); state.tokens.push({ ...row, failedAttempts: 0, consumedAt: null }); },
    async findPhoneOtpByHash(phone, hash) { return [...state.tokens].reverse().find((t) => t.phone === phone && t.otpHash === hash && !t.consumedAt) ?? null; },
    async findLatestActivePhoneOtp(phone) { return [...state.tokens].reverse().find((t) => t.phone === phone && !t.consumedAt) ?? null; },
    async consumePhonePasswordReset({ id, userId, consumedAt, passwordHash, maxAttempts }) {
      const row = state.tokens.find((t) => t.id === id && t.userId === userId && !t.consumedAt && t.failedAttempts < maxAttempts);
      if (!row) return false; row.consumedAt = consumedAt; state.passwords.push(passwordHash); return true;
    },
    async recordPhoneOtpFailure({ id, maxAttempts }) { const row = state.tokens.find((t) => t.id === id); if (!row || row.failedAttempts >= maxAttempts) return false; row.failedAttempts += 1; return true; }
  };
  let now = new Date('2026-01-01T00:00:00Z');
  return { state, store, setNow: (v) => { now = new Date(v); }, service: createPhoneRecoveryService({ store, clock: () => now, otpGenerator: () => '012345', otpSecret: 'test-secret' }) };
}

test('normalizes accepted China mobile forms to E.164 and rejects unsafe forms', () => {
  assert.equal(normalizePhone('138 0013 8000'), '+8613800138000');
  assert.equal(normalizePhone('+86 (138) 0013-8000'), '+8613800138000');
  assert.equal(normalizePhone('008613800138000'), '+8613800138000');
  for (const value of ['+8612800138000', '01013800138000', '+12025550123', '1380013800', '']) assert.throws(() => normalizePhone(value), PhoneRecoveryError);
});

test('OTP uses six digits and only its digest is persisted', async () => {
  const { service, state } = fixture();
  const issued = await service.request('13800138000');
  assert.equal(issued.otp, '012345');
  assert.equal(state.tokens[0].otpHash, hashPhoneOtp('012345', 'test-secret'));
  assert.equal('otp' in state.tokens[0], false);
  assert.match(generatePhoneOtp(), /^\d{6}$/);
});

test('unknown phone returns generic response without enumeration', async () => {
  const { service, state } = fixture();
  assert.deepEqual(await service.request('13900139000'), { accepted: true, delivered: false });
  assert.equal(state.tokens.length, 0);
});

test('request interval, ten-minute expiry, single use, and password update are enforced', async () => {
  const { service, state, setNow } = fixture();
  const issued = await service.request('+8613800138000');
  assert.deepEqual(await service.request('+8613800138000'), { accepted: true, delivered: false });
  assert.deepEqual(await service.confirm('+8613800138000', issued.otp, 'a sufficiently long password'), { userId: 'u1', updated: true });
  await assert.rejects(() => service.confirm('+8613800138000', issued.otp, 'another sufficiently long password'), /invalid or expired/);
  setNow('2026-01-01T00:01:01Z');
  const expired = await service.request('+8613800138000');
  setNow('2026-01-01T00:11:02Z');
  await assert.rejects(() => service.confirm('+8613800138000', expired.otp, 'a sufficiently long password'), /invalid or expired/);
  assert.equal(state.passwords.length, 1);
});

test('wrong OTPs increment failures and lock after five attempts', async () => {
  const { service, state } = fixture();
  await service.request('+8613800138000');
  for (let i = 0; i < 5; i++) await assert.rejects(() => service.confirm('+8613800138000', '999999', 'a sufficiently long password'), /invalid or expired/);
  assert.equal(state.tokens[0].failedAttempts, 5);
  await assert.rejects(() => service.confirm('+8613800138000', '012345', 'a sufficiently long password'), /invalid or expired/);
});

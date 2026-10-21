import { createHash, randomInt, randomUUID } from 'node:crypto';
import { hashPassword } from './auth.mjs';

export const PHONE_OTP_TTL_MS = 10 * 60 * 1000;
export const PHONE_OTP_MIN_INTERVAL_MS = 60 * 1000;
export const PHONE_OTP_MAX_ATTEMPTS = 5;

export class PhoneRecoveryError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message); this.name = 'PhoneRecoveryError'; this.code = code; this.statusCode = statusCode;
  }
}

export function normalizePhone(phone) {
  const raw = String(phone ?? '').trim().replace(/[\s()-]/g, '');
  let national;
  if (/^\+86\d{11}$/.test(raw)) national = raw.slice(3);
  else if (/^0086\d{11}$/.test(raw)) national = raw.slice(4);
  else if (/^1\d{10}$/.test(raw)) national = raw;
  else throw new PhoneRecoveryError('A valid mobile phone number is required', 'INVALID_PHONE');
  if (!/^1[3-9]\d{9}$/.test(national)) throw new PhoneRecoveryError('A valid mobile phone number is required', 'INVALID_PHONE');
  return `+86${national}`;
}

export function generatePhoneOtp() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function hashPhoneOtp(otp, secret = '') {
  const value = String(otp ?? '');
  if (!/^\d{6}$/.test(value)) throw new PhoneRecoveryError('OTP is invalid', 'INVALID_OTP');
  return createHash('sha256').update(`${String(secret)}:${value}`, 'utf8').digest('hex');
}

export function createPhoneRecoveryService({
  store, clock = () => new Date(), otpTtlMs = PHONE_OTP_TTL_MS,
  minRequestIntervalMs = PHONE_OTP_MIN_INTERVAL_MS, maxAttempts = PHONE_OTP_MAX_ATTEMPTS,
  otpGenerator = generatePhoneOtp, otpSecret = ''
} = {}) {
  if (!store) throw new TypeError('A phone recovery store is required');
  if (!Number.isFinite(otpTtlMs) || otpTtlMs <= 0) throw new RangeError('otpTtlMs must be positive');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be between 1 and 10');
  const generic = () => ({ accepted: true, delivered: false });
  async function request(phone) {
    const normalizedPhone = normalizePhone(phone);
    const user = await store.findUserByPhone(normalizedPhone);
    if (!user) return generic();
    const now = new Date(clock());
    const latest = await store.findLatestPhoneOtp(user.id);
    if (latest?.requestedAt && now.getTime() - new Date(latest.requestedAt).getTime() < minRequestIntervalMs) return generic();
    const otp = String(otpGenerator());
    if (!/^\d{6}$/.test(otp)) throw new PhoneRecoveryError('OTP generator returned an invalid value', 'INVALID_OTP');
    const requestedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + otpTtlMs).toISOString();
    await store.createPhoneOtp({ id: randomUUID(), userId: user.id, phone: normalizedPhone, otpHash: hashPhoneOtp(otp, otpSecret), requestedAt, expiresAt, maxAttempts });
    return { accepted: true, delivered: true, userId: String(user.id), phone: normalizedPhone, otp, expiresAt };
  }
  async function confirm(phone, otp, newPassword) {
    const normalizedPhone = normalizePhone(phone);
    const user = await store.findUserByPhone(normalizedPhone);
    if (!user || typeof newPassword !== 'string' || newPassword.length < 12) throw new PhoneRecoveryError('The code is invalid or expired', 'INVALID_OTP');
    const row = await store.findPhoneOtpByHash(normalizedPhone, hashPhoneOtp(otp, otpSecret));
    const now = new Date(clock());
    if (!row) {
      const active = await store.findLatestActivePhoneOtp?.(normalizedPhone);
      if (active) await store.recordPhoneOtpFailure({ id: active.id, maxAttempts });
      throw new PhoneRecoveryError('The code is invalid or expired', 'INVALID_OTP');
    }
    if (row.consumedAt || new Date(row.expiresAt) <= now || Number(row.failedAttempts || 0) >= maxAttempts) throw new PhoneRecoveryError('The code is invalid or expired', 'INVALID_OTP');
    const consumed = await store.consumePhonePasswordReset({ id: row.id, userId: user.id, consumedAt: now.toISOString(), passwordHash: hashPassword(newPassword), maxAttempts });
    if (consumed) return { userId: String(user.id), updated: true };
    await store.recordPhoneOtpFailure({ id: row.id, maxAttempts });
    throw new PhoneRecoveryError('The code is invalid or expired', 'INVALID_OTP');
  }
  return Object.freeze({ request, confirm });
}


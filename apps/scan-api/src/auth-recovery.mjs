import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword, hashToken } from "./auth.mjs";

export const ACCOUNT_TOKEN_PURPOSE = Object.freeze({
  PASSWORD_RESET: "PASSWORD_RESET",
  EMAIL_VERIFICATION: "EMAIL_VERIFICATION"
});

const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 60 * 1000;
const TOKEN_BYTES = 32;

export class RecoveryError extends Error {
  constructor(message, code, statusCode = 400) {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class RecoveryRateLimitError extends RecoveryError {
  constructor(retryAfterMs) {
    super("Recovery request rate limit exceeded", "RECOVERY_RATE_LIMITED", 429);
    this.retryAfterMs = Math.max(0, Math.ceil(retryAfterMs));
  }
}

export function normalizeEmail(email) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new RecoveryError("A valid email address is required", "INVALID_EMAIL");
  }
  return normalized;
}

export function generateRecoveryToken(bytes = TOKEN_BYTES) {
  if (!Number.isInteger(bytes) || bytes < 32 || bytes > 128) throw new RangeError("Token entropy must be between 32 and 128 bytes");
  return randomBytes(bytes).toString("base64url");
}

export function hashRecoveryToken(token) {
  const value = String(token ?? "");
  if (!value) throw new RecoveryError("Recovery token is required", "INVALID_TOKEN");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asDate(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid date`);
  return date;
}

function assertPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) {
    throw new RecoveryError("Password must be between 12 and 1024 characters", "INVALID_PASSWORD");
  }
}

/**
 * Build the password-reset and email-verification domain service.
 *
 * `store` is intentionally persistence-agnostic and must implement:
 * - findUserByEmail(normalizedEmail) -> { id, email, emailVerifiedAt? } | null
 * - findLatestAccountToken(userId, purpose) -> { requestedAt } | null
 * - createAccountToken({ id, userId, purpose, tokenHash, expiresAt, requestedAt })
 * - findAccountTokenByHash(tokenHash) -> { id, userId, purpose, expiresAt, consumedAt } | null
 * - consumePasswordReset({ id, consumedAt, passwordHash }) -> boolean (atomic)
 * - consumeEmailVerification({ id, userId, consumedAt }) -> boolean (atomic)
 *
 * The raw token is returned only to the caller that sends email. It is never
 * passed to the store; persistence receives only its SHA-256 hash.
 */
export function createAccountRecoveryService({
  store,
  clock = () => new Date(),
  tokenTtlMs = DEFAULT_TOKEN_TTL_MS,
  minRequestIntervalMs = DEFAULT_MIN_REQUEST_INTERVAL_MS,
  passwordHasher = hashPassword,
  tokenGenerator = generateRecoveryToken
} = {}) {
  if (!store) throw new TypeError("A recovery token store is required");
  if (!Number.isFinite(tokenTtlMs) || tokenTtlMs <= 0) throw new RangeError("tokenTtlMs must be positive");
  if (!Number.isFinite(minRequestIntervalMs) || minRequestIntervalMs < 0) throw new RangeError("minRequestIntervalMs must not be negative");

  async function issue(purpose, email, { generic = false } = {}) {
    const normalizedEmail = normalizeEmail(email);
    const user = await store.findUserByEmail(normalizedEmail);
    // Keep the public reset endpoint enumeration-resistant: unknown addresses
    // have the same accepted response and no token is created.
    if (!user || (purpose === ACCOUNT_TOKEN_PURPOSE.PASSWORD_RESET && !user.emailVerifiedAt)) return { accepted: true, delivered: false };
    const now = asDate(clock(), "clock");
    const latest = await store.findLatestAccountToken(user.id, purpose);
    if (latest?.requestedAt) {
      const elapsed = now.getTime() - asDate(latest.requestedAt, "requestedAt").getTime();
      if (elapsed < minRequestIntervalMs) {
        if (generic) return { accepted: true, delivered: false };
        throw new RecoveryRateLimitError(minRequestIntervalMs - elapsed);
      }
    }
    const rawToken = tokenGenerator();
    const requestedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + tokenTtlMs).toISOString();
    await store.createAccountToken({
      id: randomUUID(), userId: user.id, purpose,
      tokenHash: hashRecoveryToken(rawToken), expiresAt, requestedAt
    });
    return { accepted: true, delivered: true, userId: String(user.id), email: normalizedEmail, token: rawToken, expiresAt };
  }

  async function inspect(token, purpose) {
    const row = await store.findAccountTokenByHash(hashRecoveryToken(token));
    if (!row || row.purpose !== purpose) throw new RecoveryError("Recovery token is invalid", "INVALID_TOKEN");
    const now = asDate(clock(), "clock");
    if (row.consumedAt) throw new RecoveryError("Recovery token has already been used", "TOKEN_USED");
    if (asDate(row.expiresAt, "expiresAt") <= now) throw new RecoveryError("Recovery token has expired", "TOKEN_EXPIRED");
    return row;
  }

  return Object.freeze({
    requestPasswordReset: (email, options) => issue(ACCOUNT_TOKEN_PURPOSE.PASSWORD_RESET, email, options),
    requestEmailVerification: (email, options) => issue(ACCOUNT_TOKEN_PURPOSE.EMAIL_VERIFICATION, email, options),
    async confirmPasswordReset(token, newPassword) {
      assertPassword(newPassword);
      const row = await inspect(token, ACCOUNT_TOKEN_PURPOSE.PASSWORD_RESET);
      const consumed = await store.consumePasswordReset({ id: row.id, consumedAt: asDate(clock(), "clock").toISOString(), passwordHash: passwordHasher(newPassword) });
      if (!consumed) throw new RecoveryError("Recovery token has already been used", "TOKEN_USED");
      return { userId: String(row.userId), updated: true };
    },
    async confirmEmailVerification(token) {
      const row = await inspect(token, ACCOUNT_TOKEN_PURPOSE.EMAIL_VERIFICATION);
      const consumed = await store.consumeEmailVerification({ id: row.id, userId: row.userId, consumedAt: asDate(clock(), "clock").toISOString() });
      if (!consumed) throw new RecoveryError("Verification token has already been used", "TOKEN_USED");
      return { userId: String(row.userId), verified: true };
    }
  });
}

export const recoveryTokenHash = hashToken;

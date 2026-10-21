ALTER TABLE local_users
  ADD COLUMN IF NOT EXISTS normalized_phone text;

CREATE UNIQUE INDEX IF NOT EXISTS local_users_normalized_phone_uq
  ON local_users(normalized_phone)
  WHERE normalized_phone IS NOT NULL AND status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS local_phone_recovery_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  normalized_phone text NOT NULL,
  otp_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0 AND failed_attempts <= 10),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1 AND max_attempts <= 10),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS local_phone_recovery_tokens_user_idx
  ON local_phone_recovery_tokens(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS local_phone_recovery_tokens_lookup_idx
  ON local_phone_recovery_tokens(normalized_phone, otp_hash, expires_at)
  WHERE consumed_at IS NULL;

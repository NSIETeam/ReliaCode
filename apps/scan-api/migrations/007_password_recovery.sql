ALTER TABLE local_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS local_account_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('PASSWORD_RESET','EMAIL_VERIFICATION')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS local_account_tokens_user_purpose_idx
  ON local_account_tokens(user_id, purpose, requested_at DESC);
CREATE INDEX IF NOT EXISTS local_account_tokens_active_hash_idx
  ON local_account_tokens(token_hash, expires_at)
  WHERE consumed_at IS NULL;

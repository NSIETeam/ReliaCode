ALTER TABLE admin_sessions
  ADD COLUMN IF NOT EXISTS passkey_verified_at timestamptz;

CREATE INDEX IF NOT EXISTS admin_sessions_passkey_step_up_idx
  ON admin_sessions(user_id,passkey_verified_at DESC)
  WHERE revoked_at IS NULL AND passkey_verified_at IS NOT NULL;

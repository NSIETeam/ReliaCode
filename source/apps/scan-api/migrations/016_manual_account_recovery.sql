CREATE TABLE IF NOT EXISTS platform_account_recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES local_users(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','COMPLETED','EXPIRED')),
  requested_by text NOT NULL,
  request_reason text NOT NULL,
  reviewed_by text,
  review_reason text,
  reviewed_at timestamptz,
  recovery_token_hash text UNIQUE,
  recovery_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_account_recovery_pending_user_uq
  ON platform_account_recovery_cases(user_id) WHERE status IN ('PENDING','APPROVED');
CREATE INDEX IF NOT EXISTS platform_account_recovery_queue_idx
  ON platform_account_recovery_cases(status,created_at DESC,id DESC);

ALTER TABLE authentication_events DROP CONSTRAINT IF EXISTS authentication_events_event_type_check;
ALTER TABLE authentication_events ADD CONSTRAINT authentication_events_event_type_check CHECK (event_type IN (
  'LOGIN_SUCCEEDED','LOGIN_RISK_DETECTED','SESSION_ROTATED','SESSION_REVOKED',
  'ACCOUNT_FROZEN','ACCOUNT_UNFROZEN','MANUAL_RECOVERY_COMPLETED'
));

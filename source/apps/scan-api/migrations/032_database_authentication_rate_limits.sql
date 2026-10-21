CREATE TABLE authentication_rate_limits (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  failure_count integer NOT NULL CHECK (failure_count >= 0),
  window_started_at timestamptz NOT NULL,
  blocked_until timestamptz,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (blocked_until IS NULL OR blocked_until <= expires_at)
);

CREATE INDEX authentication_rate_limits_expiry_idx ON authentication_rate_limits(expires_at);

ALTER TABLE authentication_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE authentication_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY system_only ON authentication_rate_limits
  USING (reliacode_system_access())
  WITH CHECK (reliacode_system_access());

REVOKE ALL ON TABLE authentication_rate_limits FROM PUBLIC;

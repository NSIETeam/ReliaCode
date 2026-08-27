-- Explicit tenant plans and auditable monthly usage metering.
CREATE TABLE IF NOT EXISTS tenant_entitlements (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'team')),
  effective_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_entitlements_plan_idx ON tenant_entitlements(plan);

-- A row is keyed by the UTC calendar month (the first day of that month).
CREATE TABLE IF NOT EXISTS tenant_usage_monthly (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  usage_month date NOT NULL,
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  scan_count integer NOT NULL DEFAULT 0 CHECK (scan_count >= 0),
  code_count integer NOT NULL DEFAULT 0 CHECK (code_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, usage_month),
  CHECK (usage_month = date_trunc('month', usage_month)::date)
);

CREATE INDEX IF NOT EXISTS tenant_usage_monthly_month_idx
  ON tenant_usage_monthly(usage_month DESC);

CREATE TABLE IF NOT EXISTS tenant_entitlement_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('PLAN_ASSIGNED', 'PLAN_CHANGED', 'USAGE_RECORDED', 'QUOTA_BLOCKED')),
  plan_before text CHECK (plan_before IS NULL OR plan_before IN ('free', 'team')),
  plan_after text CHECK (plan_after IS NULL OR plan_after IN ('free', 'team')),
  usage_month date,
  usage_delta jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_code text,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_entitlement_audit_tenant_idx
  ON tenant_entitlement_audit(tenant_id, created_at DESC);

DROP TRIGGER IF EXISTS tenant_entitlement_audit_append_only ON tenant_entitlement_audit;
CREATE TRIGGER tenant_entitlement_audit_append_only
  BEFORE UPDATE OR DELETE ON tenant_entitlement_audit
  FOR EACH ROW EXECUTE FUNCTION reject_update_delete();

-- Existing tenants start with the least-privilege plan and can be upgraded by
-- an explicitly audited operator action.
INSERT INTO tenant_entitlements (tenant_id)
SELECT id FROM tenants
ON CONFLICT (tenant_id) DO NOTHING;

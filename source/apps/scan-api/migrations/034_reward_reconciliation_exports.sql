CREATE TABLE reward_reconciliation_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','EXPORTING','COMPLETED','FAILED','DEAD_LETTER','CANCELLED')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  beneficiary_organization_id uuid,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  output_object_key text,
  output_size_bytes bigint CHECK (output_size_bytes IS NULL OR output_size_bytes > 0),
  output_sha256 text CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
  row_count bigint CHECK (row_count IS NULL OR row_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (period_end <= snapshot_at),
  FOREIGN KEY (tenant_id,beneficiary_organization_id) REFERENCES organizations(tenant_id,id)
);

CREATE INDEX reward_reconciliation_exports_queue_idx
  ON reward_reconciliation_exports(status,available_at,created_at)
  WHERE status IN ('PENDING','EXPORTING','FAILED');
CREATE INDEX reward_reconciliation_exports_tenant_created_idx
  ON reward_reconciliation_exports(tenant_id,created_at DESC,id DESC);

ALTER TABLE reward_reconciliation_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_reconciliation_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reward_reconciliation_exports
USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context())
WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context());

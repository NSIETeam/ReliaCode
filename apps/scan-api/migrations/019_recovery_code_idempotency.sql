CREATE UNIQUE INDEX IF NOT EXISTS local_users_tenant_id_id_uq ON local_users(tenant_id,id);

CREATE TABLE IF NOT EXISTS recovery_code_issuances (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id,idempotency_key),
  CONSTRAINT recovery_code_issuances_tenant_user_fk FOREIGN KEY (tenant_id,user_id) REFERENCES local_users(tenant_id,id) ON DELETE CASCADE
);

ALTER TABLE recovery_code_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_code_issuances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON recovery_code_issuances;
CREATE POLICY tenant_isolation ON recovery_code_issuances
  USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context())
  WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context());

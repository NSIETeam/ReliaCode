-- Keep the shared schema tenant-scoped without adding per-tenant tables.
-- Existing primary/unique indexes already cover tenant_id where it is leading.
CREATE INDEX IF NOT EXISTS organizations_tenant_status_idx ON organizations (tenant_id, status, id);
CREATE INDEX IF NOT EXISTS code_batches_tenant_created_idx ON code_batches (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS serialized_objects_tenant_created_idx ON serialized_objects (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS shipments_tenant_created_idx ON shipments (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS trace_events_tenant_event_time_idx ON trace_events (tenant_id, event_time DESC, id);
CREATE INDEX IF NOT EXISTS reward_claims_tenant_created_idx ON reward_claims (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS ledger_entries_tenant_created_idx ON ledger_entries (tenant_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS risk_cases_tenant_status_created_idx ON risk_cases (tenant_id, status, created_at DESC, id);
CREATE INDEX IF NOT EXISTS local_users_tenant_status_idx ON local_users (tenant_id, status, id);
CREATE INDEX IF NOT EXISTS local_organizations_tenant_status_idx ON local_organizations (tenant_id, status, id);
CREATE INDEX IF NOT EXISTS local_memberships_org_status_user_idx ON local_memberships (organization_id, status, user_id);
CREATE INDEX IF NOT EXISTS local_invitations_org_active_created_idx ON local_invitations (organization_id, created_at DESC, id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

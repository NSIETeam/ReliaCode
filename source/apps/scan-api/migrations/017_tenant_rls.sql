-- Database-enforced tenant isolation. Background workers, authentication,
-- public projection and platform control-plane operations explicitly run with
-- reliacode.system_access=on; tenant request handlers set reliacode.tenant_id.
CREATE OR REPLACE FUNCTION reliacode_system_access() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT current_setting('reliacode.system_access',true)='on' $$;
CREATE OR REPLACE FUNCTION reliacode_tenant_context() RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('reliacode.tenant_id',true),'')::uuid $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants','organizations','products','code_batches','serialized_objects','shipments','trace_events',
    'campaigns','reward_claims','ledger_entries','risk_cases','audit_log','idempotency_records','event_outbox',
    'tenant_settings','tenant_entitlements','tenant_usage_monthly','tenant_entitlement_audit',
    'locations','devices','business_documents','code_generation_jobs','package_relationship_events','recalls','recall_objects',
    'webhook_endpoints','webhook_deliveries','webhook_replay_requests','epcis_replay_requests','authentication_events',
    'local_users','local_organizations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',table_name);
    IF table_name='tenants' THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (reliacode_system_access() OR id=reliacode_tenant_context()) WITH CHECK (reliacode_system_access() OR id=reliacode_tenant_context())',table_name);
    ELSE
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context()) WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context())',table_name);
    END IF;
  END LOOP;
END $$;

ALTER TABLE supply_relationships ENABLE ROW LEVEL SECURITY; ALTER TABLE supply_relationships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supply_relationships;
CREATE POLICY tenant_isolation ON supply_relationships USING (reliacode_system_access() OR source_tenant_id=reliacode_tenant_context() OR target_tenant_id=reliacode_tenant_context()) WITH CHECK (reliacode_system_access() OR source_tenant_id=reliacode_tenant_context());

ALTER TABLE supply_object_grants ENABLE ROW LEVEL SECURITY; ALTER TABLE supply_object_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supply_object_grants;
CREATE POLICY tenant_isolation ON supply_object_grants USING (reliacode_system_access() OR owner_tenant_id=reliacode_tenant_context() OR partner_tenant_id=reliacode_tenant_context()) WITH CHECK (reliacode_system_access() OR owner_tenant_id=reliacode_tenant_context() OR partner_tenant_id=reliacode_tenant_context());

ALTER TABLE supply_grant_objects ENABLE ROW LEVEL SECURITY; ALTER TABLE supply_grant_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON supply_grant_objects;
CREATE POLICY tenant_isolation ON supply_grant_objects USING (reliacode_system_access() OR owner_tenant_id=reliacode_tenant_context() OR EXISTS(SELECT 1 FROM supply_object_grants g WHERE g.id=grant_id AND g.partner_tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR owner_tenant_id=reliacode_tenant_context());

ALTER TABLE shared_trace_events ENABLE ROW LEVEL SECURITY; ALTER TABLE shared_trace_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shared_trace_events;
CREATE POLICY tenant_isolation ON shared_trace_events USING (reliacode_system_access() OR object_owner_tenant_id=reliacode_tenant_context() OR actor_tenant_id=reliacode_tenant_context()) WITH CHECK (reliacode_system_access() OR actor_tenant_id=reliacode_tenant_context());

ALTER TABLE shipment_objects ENABLE ROW LEVEL SECURITY; ALTER TABLE shipment_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON shipment_objects;
CREATE POLICY tenant_isolation ON shipment_objects USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM shipments s WHERE s.id=shipment_id AND s.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM shipments s WHERE s.id=shipment_id AND s.tenant_id=reliacode_tenant_context()));

ALTER TABLE campaign_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE campaign_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON campaign_versions;
CREATE POLICY tenant_isolation ON campaign_versions USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM campaigns c WHERE c.id=campaign_id AND c.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM campaigns c WHERE c.id=campaign_id AND c.tenant_id=reliacode_tenant_context()));

ALTER TABLE local_memberships ENABLE ROW LEVEL SECURITY; ALTER TABLE local_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON local_memberships;
CREATE POLICY tenant_isolation ON local_memberships USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=user_id AND u.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=user_id AND u.tenant_id=reliacode_tenant_context()));

ALTER TABLE local_account_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE local_account_tokens FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON local_account_tokens;
CREATE POLICY tenant_isolation ON local_account_tokens USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=user_id AND u.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=user_id AND u.tenant_id=reliacode_tenant_context()));

ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE admin_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON admin_sessions;
CREATE POLICY tenant_isolation ON admin_sessions USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context()) WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context());

ALTER TABLE local_core_organization_mappings ENABLE ROW LEVEL SECURITY; ALTER TABLE local_core_organization_mappings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON local_core_organization_mappings;
CREATE POLICY tenant_isolation ON local_core_organization_mappings USING (reliacode_system_access() OR local_tenant_id=reliacode_tenant_context()) WITH CHECK (reliacode_system_access() OR local_tenant_id=reliacode_tenant_context());

DO $$
DECLARE table_name text; relation_column text;
BEGIN
  FOR table_name,relation_column IN VALUES
    ('local_user_workspaces','user_id'),('local_account_tokens','user_id'),('local_phone_recovery_tokens','user_id'),
    ('webauthn_credentials','user_id'),('account_recovery_codes','user_id')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=%I AND u.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=%I AND u.tenant_id=reliacode_tenant_context()))',table_name,relation_column,relation_column);
  END LOOP;
END $$;

DO $$
DECLARE table_name text; relation_column text;
BEGIN
  FOR table_name,relation_column IN VALUES
    ('local_organization_workspaces','organization_id'),('local_invitations','organization_id'),('workspace_normalization_state','local_organization_id')
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_organizations o WHERE o.id=%I AND o.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_organizations o WHERE o.id=%I AND o.tenant_id=reliacode_tenant_context()))',table_name,relation_column,relation_column);
  END LOOP;
END $$;

ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY; ALTER TABLE webauthn_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webauthn_challenges;
CREATE POLICY tenant_isolation ON webauthn_challenges USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=user_id AND u.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=user_id AND u.tenant_id=reliacode_tenant_context()));

ALTER TABLE admin_public_objects ENABLE ROW LEVEL SECURITY; ALTER TABLE admin_public_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON admin_public_objects;
CREATE POLICY tenant_isolation ON admin_public_objects USING (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=owner_user_id AND u.tenant_id=reliacode_tenant_context())) WITH CHECK (reliacode_system_access() OR EXISTS(SELECT 1 FROM local_users u WHERE u.id=owner_user_id AND u.tenant_id=reliacode_tenant_context()));

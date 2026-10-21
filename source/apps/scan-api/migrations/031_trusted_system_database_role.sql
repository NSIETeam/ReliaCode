CREATE TABLE IF NOT EXISTS reliacode_system_database_role (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  role_name name NOT NULL UNIQUE,
  registered_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE reliacode_system_database_role FROM PUBLIC;

CREATE OR REPLACE FUNCTION reliacode_system_access() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT current_setting('reliacode.system_access',true)='on'
    AND EXISTS (
      SELECT 1 FROM public.reliacode_system_database_role
      WHERE role_name=session_user::name
    )
$$;

REVOKE ALL ON FUNCTION reliacode_system_access() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reliacode_system_access() TO PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'admin_workspaces','backup_runs','platform_account_recovery_cases',
    'platform_audit_log','platform_idempotency_records','tenant_applications'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS system_only ON %I',table_name);
    EXECUTE format('CREATE POLICY system_only ON %I USING (reliacode_system_access()) WITH CHECK (reliacode_system_access())',table_name);
  END LOOP;
END $$;

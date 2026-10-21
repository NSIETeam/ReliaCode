CREATE UNIQUE INDEX IF NOT EXISTS trace_events_tenant_id_id_uq ON trace_events(tenant_id,id);
CREATE TABLE IF NOT EXISTS trace_event_object_snapshots (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  trace_event_id uuid NOT NULL,
  object_id uuid NOT NULL,
  depth integer NOT NULL CHECK (depth >= 0 AND depth <= 16),
  parent_object_id uuid,
  previous_status text NOT NULL,
  resulting_status text NOT NULL,
  object_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,trace_event_id,object_id),
  FOREIGN KEY (tenant_id,trace_event_id) REFERENCES trace_events(tenant_id,id),
  FOREIGN KEY (tenant_id,object_id) REFERENCES serialized_objects(tenant_id,id),
  FOREIGN KEY (tenant_id,parent_object_id) REFERENCES serialized_objects(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS trace_event_object_snapshots_tenant_object_idx
  ON trace_event_object_snapshots(tenant_id,object_id,created_at DESC);
DROP TRIGGER IF EXISTS trace_event_object_snapshots_append_only ON trace_event_object_snapshots;
CREATE TRIGGER trace_event_object_snapshots_append_only BEFORE UPDATE OR DELETE ON trace_event_object_snapshots
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();
ALTER TABLE trace_event_object_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE trace_event_object_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON trace_event_object_snapshots;
CREATE POLICY tenant_isolation ON trace_event_object_snapshots
  USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context())
  WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context());

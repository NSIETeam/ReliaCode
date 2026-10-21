ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_active_authorization_check;
ALTER TABLE devices ADD CONSTRAINT devices_active_authorization_check CHECK (
  status<>'ACTIVE' OR (
    credential_hash IS NOT NULL AND cardinality(allowed_event_types)>0 AND
    allowed_event_types <@ ARRAY['PACKING','UNPACKING','REPACKING','SHIPPING','RECEIVING_DISTRIBUTOR','RECEIVING_STORE','RETURNING','SELLING','DESTROYING']::text[]
  )
);
ALTER TABLE trace_event_object_snapshots ADD COLUMN IF NOT EXISTS resulting_parent_object_id uuid;
ALTER TABLE trace_event_object_snapshots DROP CONSTRAINT IF EXISTS trace_event_object_snapshots_tenant_resulting_parent_fk;
ALTER TABLE trace_event_object_snapshots ADD CONSTRAINT trace_event_object_snapshots_tenant_resulting_parent_fk
  FOREIGN KEY (tenant_id,resulting_parent_object_id) REFERENCES serialized_objects(tenant_id,id);

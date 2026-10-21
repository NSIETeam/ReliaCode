ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS devices_tenant_id_id_uq ON devices(tenant_id,id);
UPDATE devices SET status='SUSPENDED'
WHERE status='ACTIVE' AND (
  credential_hash IS NULL OR cardinality(allowed_event_types)=0 OR
  NOT allowed_event_types <@ ARRAY['PACKING','UNPACKING','SHIPPING','RECEIVING_DISTRIBUTOR','RECEIVING_STORE','RETURNING','SELLING','DESTROYING']::text[]
);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_active_authorization_check;
ALTER TABLE devices ADD CONSTRAINT devices_active_authorization_check CHECK (
  status<>'ACTIVE' OR (
    credential_hash IS NOT NULL AND cardinality(allowed_event_types)>0 AND
    allowed_event_types <@ ARRAY['PACKING','UNPACKING','SHIPPING','RECEIVING_DISTRIBUTOR','RECEIVING_STORE','RETURNING','SELLING','DESTROYING']::text[]
  )
);

ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS device_id uuid;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE trace_events DROP CONSTRAINT IF EXISTS trace_events_tenant_device_fk;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_tenant_device_fk
  FOREIGN KEY (tenant_id,device_id) REFERENCES devices(tenant_id,id);
ALTER TABLE trace_events DROP CONSTRAINT IF EXISTS trace_events_tenant_location_fk;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_tenant_location_fk
  FOREIGN KEY (tenant_id,location_id) REFERENCES locations(tenant_id,id);

ALTER TABLE shared_trace_events ADD COLUMN IF NOT EXISTS device_id uuid;
ALTER TABLE shared_trace_events ADD COLUMN IF NOT EXISTS location_id uuid;
ALTER TABLE shared_trace_events DROP CONSTRAINT IF EXISTS shared_trace_events_actor_device_fk;
ALTER TABLE shared_trace_events ADD CONSTRAINT shared_trace_events_actor_device_fk
  FOREIGN KEY (actor_tenant_id,device_id) REFERENCES devices(tenant_id,id);
ALTER TABLE shared_trace_events DROP CONSTRAINT IF EXISTS shared_trace_events_actor_location_fk;
ALTER TABLE shared_trace_events ADD CONSTRAINT shared_trace_events_actor_location_fk
  FOREIGN KEY (actor_tenant_id,location_id) REFERENCES locations(tenant_id,id);

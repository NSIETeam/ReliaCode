ALTER TABLE business_document_objects ADD COLUMN IF NOT EXISTS line_role text NOT NULL DEFAULT 'ACTION';
ALTER TABLE business_document_objects DROP CONSTRAINT IF EXISTS business_document_objects_line_role_check;
ALTER TABLE business_document_objects ADD CONSTRAINT business_document_objects_line_role_check CHECK (line_role IN ('ACTION','CONTEXT'));
ALTER TABLE business_document_objects ADD COLUMN IF NOT EXISTS fulfilled_event_id uuid;
ALTER TABLE business_document_objects ADD COLUMN IF NOT EXISTS fulfilled_at timestamptz;
ALTER TABLE business_document_objects DROP CONSTRAINT IF EXISTS business_document_objects_fulfilled_pair_check;
ALTER TABLE business_document_objects ADD CONSTRAINT business_document_objects_fulfilled_pair_check CHECK ((fulfilled_event_id IS NULL)=(fulfilled_at IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS business_document_objects_tenant_fulfilled_event_uq
  ON business_document_objects(tenant_id,fulfilled_event_id) WHERE fulfilled_event_id IS NOT NULL;
ALTER TABLE business_document_objects DROP CONSTRAINT IF EXISTS business_document_objects_tenant_fulfilled_event_fk;
ALTER TABLE business_document_objects ADD CONSTRAINT business_document_objects_tenant_fulfilled_event_fk
  FOREIGN KEY (tenant_id,fulfilled_event_id) REFERENCES trace_events(tenant_id,id);

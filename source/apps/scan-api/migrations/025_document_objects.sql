CREATE TABLE IF NOT EXISTS business_document_objects (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL,
  object_id uuid NOT NULL,
  expected boolean NOT NULL DEFAULT true,
  object_snapshot jsonb NOT NULL,
  added_by text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,document_id,object_id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES business_documents(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id,object_id) REFERENCES serialized_objects(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS business_document_objects_tenant_object_idx ON business_document_objects(tenant_id,object_id,document_id);
ALTER TABLE business_document_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_document_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON business_document_objects;
CREATE POLICY tenant_isolation ON business_document_objects
  USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context())
  WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context());

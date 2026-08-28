-- Multi-tenant SaaS control plane and normalized operational model.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free','team','enterprise'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS suspended_reason text;

CREATE TABLE IF NOT EXISTS tenant_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  contact_name text NOT NULL,
  contact_email text NOT NULL,
  contact_phone text,
  expected_monthly_codes bigint NOT NULL DEFAULT 0 CHECK (expected_monthly_codes >= 0),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  review_reason text,
  reviewed_by text,
  reviewed_at timestamptz,
  tenant_id uuid REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tenant_applications_pending_email_uq
  ON tenant_applications(lower(contact_email)) WHERE status='PENDING';

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  passkey_required_for_admins boolean NOT NULL DEFAULT true,
  password_login_for_operators boolean NOT NULL DEFAULT true,
  max_members integer NOT NULL DEFAULT 10 CHECK (max_members > 0),
  max_monthly_codes bigint NOT NULL DEFAULT 10000 CHECK (max_monthly_codes > 0),
  max_monthly_events bigint NOT NULL DEFAULT 50000 CHECK (max_monthly_events > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supply_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_tenant_id uuid NOT NULL REFERENCES tenants(id),
  target_tenant_id uuid REFERENCES tenants(id),
  target_email text,
  relationship_type text NOT NULL CHECK (relationship_type IN ('MANUFACTURER','DISTRIBUTOR','RETAILER','LOGISTICS','SERVICE_PROVIDER')),
  scopes text[] NOT NULL DEFAULT ARRAY['TRACE_READ']::text[],
  status text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED','ACTIVE','PAUSED','REVOKED','REJECTED')),
  invitation_token_hash text UNIQUE,
  invited_by text NOT NULL,
  accepted_by text,
  accepted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (target_tenant_id IS NULL OR target_tenant_id <> source_tenant_id),
  CHECK (target_tenant_id IS NOT NULL OR target_email IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS supply_relationships_source_idx ON supply_relationships(source_tenant_id,status);
CREATE INDEX IF NOT EXISTS supply_relationships_target_idx ON supply_relationships(target_tenant_id,status);

CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL,
  gln text,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('FACTORY','WAREHOUSE','DISTRIBUTOR','STORE','OFFICE')),
  city text,
  region text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,code),
  UNIQUE NULLS NOT DISTINCT (tenant_id,gln)
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  name text NOT NULL,
  public_key text,
  allowed_event_types text[] NOT NULL DEFAULT '{}'::text[],
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','SUSPENDED')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_tenant_location_idx ON devices(tenant_id,location_id,status);

CREATE TABLE IF NOT EXISTS business_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_type text NOT NULL CHECK (document_type IN ('PRODUCTION_ORDER','PACKING_ORDER','SHIPMENT','RECEIPT','SALE','RETURN','DESTRUCTION')),
  reference text NOT NULL,
  from_organization_id uuid REFERENCES organizations(id),
  to_organization_id uuid REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','IN_PROGRESS','COMPLETED','CANCELLED')),
  version bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,document_type,reference)
);

CREATE TABLE IF NOT EXISTS code_generation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  code_batch_id uuid REFERENCES code_batches(id),
  requested_by text NOT NULL,
  approved_by text,
  level text NOT NULL CHECK (level IN ('ITEM','CASE','PALLET')),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  serial_rule text NOT NULL CHECK (serial_rule IN ('RANDOM','SEQUENTIAL')),
  lot text,
  status text NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  generated_count integer NOT NULL DEFAULT 0 CHECK (generated_count >= 0),
  output_object_key text,
  last_error text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS code_generation_jobs_queue_idx ON code_generation_jobs(status,created_at);

-- Tenant-bearing composite keys make accidental cross-tenant references impossible
-- even when an application query omits its tenant predicate.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_tenant_id_id_uq ON organizations(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS products_tenant_id_id_uq ON products(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS locations_tenant_id_id_uq ON locations(tenant_id,id);
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_tenant_organization_fk;
ALTER TABLE locations ADD CONSTRAINT locations_tenant_organization_fk
  FOREIGN KEY (tenant_id,organization_id) REFERENCES organizations(tenant_id,id);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_tenant_organization_fk;
ALTER TABLE devices ADD CONSTRAINT devices_tenant_organization_fk
  FOREIGN KEY (tenant_id,organization_id) REFERENCES organizations(tenant_id,id);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_tenant_location_fk;
ALTER TABLE devices ADD CONSTRAINT devices_tenant_location_fk
  FOREIGN KEY (tenant_id,location_id) REFERENCES locations(tenant_id,id);
ALTER TABLE code_generation_jobs DROP CONSTRAINT IF EXISTS code_generation_jobs_tenant_product_fk;
ALTER TABLE code_generation_jobs ADD CONSTRAINT code_generation_jobs_tenant_product_fk
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id);

CREATE TABLE IF NOT EXISTS package_relationship_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  parent_object_id uuid NOT NULL REFERENCES serialized_objects(id),
  child_object_id uuid NOT NULL REFERENCES serialized_objects(id),
  action text NOT NULL CHECK (action IN ('ADD','DELETE')),
  business_document_id uuid REFERENCES business_documents(id),
  trace_event_id uuid REFERENCES trace_events(id),
  actor_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_object_id <> child_object_id)
);
CREATE INDEX IF NOT EXISTS package_relationship_events_child_idx ON package_relationship_events(tenant_id,child_object_id,occurred_at DESC);
DROP TRIGGER IF EXISTS package_relationship_events_append_only ON package_relationship_events;
CREATE TRIGGER package_relationship_events_append_only BEFORE UPDATE OR DELETE ON package_relationship_events
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();

ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS business_document_id uuid REFERENCES business_documents(id);

CREATE TABLE IF NOT EXISTS recalls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  reference text NOT NULL,
  title text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','CLOSED','CANCELLED')),
  scope jsonb NOT NULL,
  created_by text NOT NULL,
  activated_by text,
  activated_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,reference)
);

CREATE TABLE IF NOT EXISTS recall_objects (
  recall_id uuid NOT NULL REFERENCES recalls(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  object_id uuid NOT NULL REFERENCES serialized_objects(id),
  latest_status text NOT NULL,
  latest_organization_id uuid REFERENCES organizations(id),
  acknowledged_at timestamptz,
  PRIMARY KEY (recall_id,object_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS business_documents_tenant_id_id_uq ON business_documents(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS serialized_objects_tenant_id_id_uq ON serialized_objects(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS recalls_tenant_id_id_uq ON recalls(tenant_id,id);
ALTER TABLE trace_events DROP CONSTRAINT IF EXISTS trace_events_business_document_id_fkey;
ALTER TABLE trace_events DROP CONSTRAINT IF EXISTS trace_events_tenant_business_document_fk;
ALTER TABLE trace_events ADD CONSTRAINT trace_events_tenant_business_document_fk
  FOREIGN KEY (tenant_id,business_document_id) REFERENCES business_documents(tenant_id,id);
ALTER TABLE recall_objects DROP CONSTRAINT IF EXISTS recall_objects_tenant_object_fk;
ALTER TABLE recall_objects ADD CONSTRAINT recall_objects_tenant_object_fk
  FOREIGN KEY (tenant_id,object_id) REFERENCES serialized_objects(tenant_id,id);
ALTER TABLE package_relationship_events DROP CONSTRAINT IF EXISTS package_relationship_events_tenant_parent_fk;
ALTER TABLE package_relationship_events ADD CONSTRAINT package_relationship_events_tenant_parent_fk
  FOREIGN KEY (tenant_id,parent_object_id) REFERENCES serialized_objects(tenant_id,id);
ALTER TABLE package_relationship_events DROP CONSTRAINT IF EXISTS package_relationship_events_tenant_child_fk;
ALTER TABLE package_relationship_events ADD CONSTRAINT package_relationship_events_tenant_child_fk
  FOREIGN KEY (tenant_id,child_object_id) REFERENCES serialized_objects(tenant_id,id);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}'::text[],
  device_type text,
  backed_up boolean NOT NULL DEFAULT false,
  name text NOT NULL DEFAULT 'Passkey',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_user_idx ON webauthn_credentials(user_id);

ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS admin_sessions_id_uq ON admin_sessions(id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_hash text PRIMARY KEY,
  user_id uuid REFERENCES local_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('REGISTRATION','AUTHENTICATION','STEP_UP')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS account_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  url text NOT NULL,
  secret_hash text NOT NULL,
  encrypted_secret text NOT NULL,
  event_types text[] NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id),
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','DELIVERED','FAILED','DEAD_LETTER')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_queue_idx ON webhook_deliveries(status,available_at);

CREATE TABLE IF NOT EXISTS platform_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  reason text NOT NULL,
  request_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS platform_audit_log_append_only ON platform_audit_log;
CREATE TRIGGER platform_audit_log_append_only BEFORE UPDATE OR DELETE ON platform_audit_log
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();

CREATE TABLE IF NOT EXISTS platform_idempotency_records (
  idempotency_key text PRIMARY KEY,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

ALTER TABLE local_memberships DROP CONSTRAINT IF EXISTS local_memberships_role_check;
ALTER TABLE local_memberships ADD CONSTRAINT local_memberships_role_check CHECK (role IN (
  'PLATFORM_OPERATOR','TENANT_OWNER','BRAND_ADMIN','BRAND_AUDITOR','FACTORY_OPERATOR',
  'DISTRIBUTOR_RECEIVER','STORE_RECEIVER','FINANCE','READ_ONLY_AUDITOR'
));
ALTER TABLE local_users DROP CONSTRAINT IF EXISTS local_users_role_check;
ALTER TABLE local_users ADD CONSTRAINT local_users_role_check CHECK (role IN (
  'PLATFORM_OPERATOR','TENANT_OWNER','BRAND_ADMIN','BRAND_AUDITOR','FACTORY_OPERATOR',
  'DISTRIBUTOR_RECEIVER','STORE_RECEIVER','FINANCE','READ_ONLY_AUDITOR'
));

-- Promote existing application accounts into the normalized production tenant model.
INSERT INTO tenants(id,name,status,plan,approved_at)
SELECT DISTINCT lo.tenant_id,lo.name,'ACTIVE','free',lo.created_at
FROM local_organizations lo ON CONFLICT (id) DO NOTHING;
INSERT INTO organizations(id,tenant_id,type,name,status,created_at)
SELECT lo.id,lo.tenant_id,'BRAND',lo.name,
  CASE WHEN lo.status='ACTIVE' THEN 'ACTIVE' ELSE 'SUSPENDED' END,lo.created_at
FROM local_organizations lo ON CONFLICT (id) DO NOTHING;
INSERT INTO tenant_settings(tenant_id)
SELECT DISTINCT tenant_id FROM local_organizations ON CONFLICT (tenant_id) DO NOTHING;

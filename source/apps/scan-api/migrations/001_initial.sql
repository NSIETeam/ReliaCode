CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL CHECK (type IN ('BRAND','FACTORY','DISTRIBUTOR','STORE','FINANCE')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sku text NOT NULL,
  gtin text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  UNIQUE NULLS NOT DISTINCT (tenant_id, gtin)
);

CREATE TABLE IF NOT EXISTS code_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  level text NOT NULL CHECK (level IN ('ITEM','CASE','PALLET')),
  quantity integer NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  serial_rule text NOT NULL CHECK (serial_rule IN ('RANDOM','SEQUENTIAL')),
  status text NOT NULL DEFAULT 'GENERATED' CHECK (status IN ('GENERATED','EXPORTED','COMMISSIONED','CANCELLED')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS serialized_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  code_batch_id uuid REFERENCES code_batches(id),
  code text NOT NULL,
  level text NOT NULL CHECK (level IN ('ITEM','CASE','PALLET')),
  lot text,
  parent_id uuid REFERENCES serialized_objects(id),
  status text NOT NULL DEFAULT 'COMMISSIONED' CHECK (status IN ('COMMISSIONED','PACKED','IN_TRANSIT','RECEIVED','SOLD','RETURNED','DESTROYED')),
  current_organization_id uuid REFERENCES organizations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX IF NOT EXISTS serialized_objects_parent_idx ON serialized_objects(parent_id);
CREATE INDEX IF NOT EXISTS serialized_objects_tenant_status_idx ON serialized_objects(tenant_id, status);

CREATE TABLE IF NOT EXISTS shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  reference text NOT NULL,
  from_organization_id uuid NOT NULL REFERENCES organizations(id),
  to_organization_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DISPATCHED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, reference)
);

CREATE TABLE IF NOT EXISTS shipment_objects (
  shipment_id uuid NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  object_id uuid NOT NULL REFERENCES serialized_objects(id),
  expected boolean NOT NULL DEFAULT true,
  PRIMARY KEY (shipment_id, object_id)
);

CREATE TABLE IF NOT EXISTS trace_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  event_type text NOT NULL,
  object_id uuid NOT NULL REFERENCES serialized_objects(id),
  shipment_id uuid REFERENCES shipments(id),
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  event_time timestamptz NOT NULL,
  record_time timestamptz NOT NULL DEFAULT now(),
  read_point text NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('VERIFIED','PENDING_REVIEW','REJECTED')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS trace_events_object_time_idx ON trace_events(object_id, event_time DESC);
CREATE INDEX IF NOT EXISTS trace_events_tenant_record_idx ON trace_events(tenant_id, record_time DESC);

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ENDED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  budget_points bigint NOT NULL CHECK (budget_points >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code),
  CHECK (ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS campaign_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id),
  version integer NOT NULL CHECK (version > 0),
  trigger_type text NOT NULL,
  reward_points integer NOT NULL CHECK (reward_points > 0),
  hold_days integer NOT NULL DEFAULT 7 CHECK (hold_days BETWEEN 0 AND 365),
  monthly_cap_points integer NOT NULL CHECK (monthly_cap_points >= reward_points),
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  published_by text,
  UNIQUE (campaign_id, version)
);

CREATE TABLE IF NOT EXISTS reward_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  trace_event_id uuid NOT NULL REFERENCES trace_events(id),
  campaign_version_id uuid NOT NULL REFERENCES campaign_versions(id),
  beneficiary_organization_id uuid NOT NULL REFERENCES organizations(id),
  amount_points integer NOT NULL CHECK (amount_points > 0),
  status text NOT NULL CHECK (status IN ('PENDING_REVIEW','HELD','AVAILABLE','REJECTED','SETTLED','REVERSED')),
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trace_event_id, campaign_version_id, beneficiary_organization_id)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  claim_id uuid NOT NULL REFERENCES reward_claims(id),
  beneficiary_organization_id uuid NOT NULL REFERENCES organizations(id),
  entry_type text NOT NULL CHECK (entry_type IN ('ACCRUAL','RELEASE','SETTLEMENT','REVERSAL','ADJUSTMENT')),
  amount_points integer NOT NULL CHECK (amount_points <> 0),
  available_at timestamptz,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS risk_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  trace_event_id uuid REFERENCES trace_events(id),
  claim_id uuid REFERENCES reward_claims(id),
  risk_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HELD','APPROVED','REJECTED','CLOSED')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text
);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  request_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_tenant_created_idx ON audit_log(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION reject_update_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trace_events_append_only ON trace_events;
CREATE TRIGGER trace_events_append_only BEFORE UPDATE OR DELETE ON trace_events
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();

DROP TRIGGER IF EXISTS ledger_entries_append_only ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();

DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();

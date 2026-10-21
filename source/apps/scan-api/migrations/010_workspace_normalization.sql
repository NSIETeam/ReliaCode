-- Bridge local JSONB workspaces without guessing cross-tenant identity.
CREATE TABLE IF NOT EXISTS local_core_organization_mappings (
  local_organization_id uuid PRIMARY KEY REFERENCES local_organizations(id) ON DELETE CASCADE,
  local_tenant_id uuid NOT NULL,
  core_tenant_id uuid REFERENCES tenants(id),
  core_organization_id uuid REFERENCES organizations(id),
  status text NOT NULL CHECK (status IN ('PENDING','MAPPED','REJECTED')) DEFAULT 'PENDING',
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'MAPPED' AND core_tenant_id IS NOT NULL AND core_organization_id IS NOT NULL) OR status <> 'MAPPED'),
  UNIQUE (core_organization_id),
  UNIQUE (core_tenant_id, local_organization_id)
);
CREATE INDEX IF NOT EXISTS local_core_org_mappings_tenant_idx
  ON local_core_organization_mappings(local_tenant_id, status);

CREATE TABLE IF NOT EXISTS workspace_normalization_state (
  local_organization_id uuid PRIMARY KEY REFERENCES local_organizations(id) ON DELETE CASCADE,
  workspace_version bigint NOT NULL CHECK (workspace_version >= 0),
  status text NOT NULL CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  products_seen integer NOT NULL DEFAULT 0,
  products_written integer NOT NULL DEFAULT 0,
  objects_seen integer NOT NULL DEFAULT 0,
  objects_written integer NOT NULL DEFAULT 0,
  events_seen integer NOT NULL DEFAULT 0,
  events_written integer NOT NULL DEFAULT 0,
  skipped_invalid integer NOT NULL DEFAULT 0,
  skipped_unmapped integer NOT NULL DEFAULT 0,
  last_error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO local_core_organization_mappings(local_organization_id, local_tenant_id, status, reason)
SELECT id, tenant_id, 'PENDING', 'Explicit core organization mapping required'
FROM local_organizations
ON CONFLICT (local_organization_id) DO NOTHING;

UPDATE local_core_organization_mappings m
SET core_tenant_id = t.id, core_organization_id = o.id, status = 'MAPPED', reason = 'Exact pre-existing organization and tenant identifiers', updated_at = now()
FROM tenants t JOIN organizations o ON o.tenant_id = t.id
WHERE m.local_organization_id = o.id AND m.local_tenant_id = t.id AND m.status = 'PENDING';

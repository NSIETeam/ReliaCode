CREATE TABLE IF NOT EXISTS local_organizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  owner_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS local_organizations_tenant_idx ON local_organizations(tenant_id);

CREATE TABLE IF NOT EXISTS local_memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES local_organizations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('BRAND_ADMIN','BRAND_AUDITOR','FACTORY_OPERATOR','DISTRIBUTOR_RECEIVER','STORE_RECEIVER','FINANCE')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS local_memberships_org_idx ON local_memberships(organization_id,status);
CREATE INDEX IF NOT EXISTS local_memberships_user_idx ON local_memberships(user_id,status);

CREATE TABLE IF NOT EXISTS local_organization_workspaces (
  organization_id uuid PRIMARY KEY REFERENCES local_organizations(id) ON DELETE CASCADE,
  workspace jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS local_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES local_organizations(id) ON DELETE CASCADE,
  invited_by_user_id uuid NOT NULL REFERENCES local_users(id) ON DELETE RESTRICT,
  email text,
  role text NOT NULL CHECK (role IN ('BRAND_ADMIN','BRAND_AUDITOR','FACTORY_OPERATOR','DISTRIBUTOR_RECEIVER','STORE_RECEIVER','FINANCE')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS local_invitations_org_idx ON local_invitations(organization_id,created_at DESC);
CREATE INDEX IF NOT EXISTS local_invitations_active_idx ON local_invitations(token_hash,expires_at) WHERE accepted_at IS NULL AND revoked_at IS NULL;

ALTER TABLE local_users DROP CONSTRAINT IF EXISTS local_users_role_check;
ALTER TABLE local_users ADD CONSTRAINT local_users_role_check
  CHECK (role IN ('BRAND_ADMIN','BRAND_AUDITOR','FACTORY_OPERATOR','DISTRIBUTOR_RECEIVER','STORE_RECEIVER','FINANCE'));

-- Existing local users were already isolated by organization_id. Promote that
-- identity field into an explicit organization and membership relation without
-- changing their role or workspace data.
INSERT INTO local_organizations(id,tenant_id,name,owner_user_id)
SELECT DISTINCT u.organization_id,u.tenant_id,'ReliaCode',u.id
FROM local_users u
ON CONFLICT (id) DO NOTHING;

INSERT INTO local_memberships(id,user_id,organization_id,role)
SELECT u.id,u.id,u.organization_id,u.role
FROM local_users u
ON CONFLICT (user_id,organization_id) DO UPDATE SET role=EXCLUDED.role,status='ACTIVE',updated_at=now();

INSERT INTO local_organization_workspaces(organization_id,workspace,version,updated_at)
SELECT u.organization_id,w.workspace,w.version,w.updated_at
FROM local_user_workspaces w JOIN local_users u ON u.id=w.user_id
ON CONFLICT (organization_id) DO NOTHING;

ALTER TABLE local_organizations
  ADD CONSTRAINT local_organizations_owner_fk FOREIGN KEY (owner_user_id) REFERENCES local_users(id) ON DELETE SET NULL;

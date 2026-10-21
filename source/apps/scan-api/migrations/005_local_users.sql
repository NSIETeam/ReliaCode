CREATE TABLE IF NOT EXISTS local_users (
  id uuid PRIMARY KEY,
  username text NOT NULL,
  normalized_username text NOT NULL UNIQUE,
  email text NOT NULL,
  normalized_email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'BRAND_ADMIN' CHECK (role IN ('BRAND_ADMIN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES local_users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions(user_id);

CREATE TABLE IF NOT EXISTS local_user_workspaces (
  user_id uuid PRIMARY KEY REFERENCES local_users(id) ON DELETE CASCADE,
  workspace jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_public_objects ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES local_users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS admin_public_objects_owner_idx ON admin_public_objects(owner_user_id);

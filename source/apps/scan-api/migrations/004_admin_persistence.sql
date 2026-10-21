CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  csrf_token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_workspaces (
  id integer PRIMARY KEY CHECK (id = 1),
  workspace jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_public_objects (
  public_id uuid PRIMARY KEY,
  code text NOT NULL,
  level text NOT NULL,
  lot text,
  status text NOT NULL,
  commissioned_at timestamptz NOT NULL,
  product_name text NOT NULL,
  gtin text,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_public_objects_code_idx ON admin_public_objects(code);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_platform boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS tenants_single_platform_uq ON tenants(is_platform) WHERE is_platform;

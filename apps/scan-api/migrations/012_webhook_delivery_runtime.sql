ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

CREATE INDEX IF NOT EXISTS webhook_deliveries_dead_letter_idx
  ON webhook_deliveries(tenant_id,dead_lettered_at DESC)
  WHERE status='DEAD_LETTER';

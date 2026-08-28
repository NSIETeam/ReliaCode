CREATE UNIQUE INDEX IF NOT EXISTS webhook_endpoints_tenant_id_id_uq
  ON webhook_endpoints(tenant_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_tenant_id_id_uq
  ON webhook_deliveries(tenant_id,id);

ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_endpoint_id_fkey;
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_tenant_endpoint_fk
  FOREIGN KEY (tenant_id,endpoint_id) REFERENCES webhook_endpoints(tenant_id,id);

CREATE TABLE IF NOT EXISTS webhook_replay_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  delivery_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  reason text NOT NULL,
  requested_by text NOT NULL,
  reviewed_by text,
  review_reason text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_replay_requests_tenant_delivery_fk
    FOREIGN KEY (tenant_id,delivery_id) REFERENCES webhook_deliveries(tenant_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_replay_requests_pending_uq
  ON webhook_replay_requests(delivery_id) WHERE status='PENDING';

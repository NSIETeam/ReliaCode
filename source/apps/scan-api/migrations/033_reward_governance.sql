ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION protect_published_campaign_version() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' AND OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published campaign version is immutable';
  END IF;
  IF TG_OP='UPDATE' AND OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'published campaign version is immutable';
  END IF;
  IF TG_OP='UPDATE' AND NEW.published_at IS NOT NULL AND (
    NEW.campaign_id<>OLD.campaign_id OR NEW.version<>OLD.version OR
    NEW.trigger_type<>OLD.trigger_type OR NEW.reward_points<>OLD.reward_points OR
    NEW.hold_days<>OLD.hold_days OR NEW.monthly_cap_points<>OLD.monthly_cap_points OR
    NEW.scope<>OLD.scope OR NEW.published_by IS NULL
  ) THEN
    RAISE EXCEPTION 'campaign publication cannot alter rule fields';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS campaign_versions_publish_once ON campaign_versions;
CREATE TRIGGER campaign_versions_publish_once BEFORE UPDATE OR DELETE ON campaign_versions
FOR EACH ROW EXECUTE FUNCTION protect_published_campaign_version();

CREATE UNIQUE INDEX IF NOT EXISTS reward_claims_tenant_id_id_uq ON reward_claims(tenant_id,id);

CREATE TABLE reward_claim_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  claim_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('RELEASE','REJECT','SETTLE','REVERSE')),
  status_before text NOT NULL,
  status_after text NOT NULL,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  reason text NOT NULL,
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,claim_id) REFERENCES reward_claims(tenant_id,id)
);
CREATE INDEX reward_claim_decisions_tenant_created_idx ON reward_claim_decisions(tenant_id,created_at DESC,id DESC);
DROP TRIGGER IF EXISTS reward_claim_decisions_append_only ON reward_claim_decisions;
CREATE TRIGGER reward_claim_decisions_append_only BEFORE UPDATE OR DELETE ON reward_claim_decisions
FOR EACH ROW EXECUTE FUNCTION reject_update_delete();
ALTER TABLE reward_claim_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_claim_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reward_claim_decisions
USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context())
WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context());

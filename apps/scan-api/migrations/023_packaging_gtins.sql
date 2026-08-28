CREATE TABLE IF NOT EXISTS product_trade_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  product_id uuid NOT NULL,
  level text NOT NULL CHECK (level IN ('ITEM','CASE')),
  gtin text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,product_id,level),
  UNIQUE (tenant_id,gtin),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id),
  CHECK (gs1_mod10_valid(gtin,ARRAY[8,12,13,14]))
);
INSERT INTO product_trade_items(tenant_id,product_id,level,gtin)
SELECT tenant_id,id,'ITEM',gtin FROM products WHERE gtin IS NOT NULL AND gs1_mod10_valid(gtin,ARRAY[8,12,13,14])
ON CONFLICT (tenant_id,product_id,level) DO NOTHING;

ALTER TABLE product_trade_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_trade_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON product_trade_items;
CREATE POLICY tenant_isolation ON product_trade_items
  USING (reliacode_system_access() OR tenant_id=reliacode_tenant_context())
  WITH CHECK (reliacode_system_access() OR tenant_id=reliacode_tenant_context());

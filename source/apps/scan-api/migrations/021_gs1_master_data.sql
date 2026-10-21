CREATE OR REPLACE FUNCTION gs1_mod10_valid(value text,allowed_lengths integer[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE total integer:=0; position integer; digit integer; data_length integer;
BEGIN
  IF value!~'^[0-9]+$' OR NOT length(value)=ANY(allowed_lengths) THEN RETURN false; END IF;
  data_length:=length(value)-1;
  FOR position IN 1..data_length LOOP
    digit:=substr(value,position,1)::integer;
    total:=total+digit*CASE WHEN (data_length-position)%2=0 THEN 3 ELSE 1 END;
  END LOOP;
  RETURN ((10-(total%10))%10)=substr(value,length(value),1)::integer;
END $$;

UPDATE products SET status='INACTIVE' WHERE status='ACTIVE' AND gtin IS NOT NULL AND NOT gs1_mod10_valid(gtin,ARRAY[8,12,13,14]);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_active_gtin_check;
ALTER TABLE products ADD CONSTRAINT products_active_gtin_check CHECK (status<>'ACTIVE' OR gtin IS NULL OR gs1_mod10_valid(gtin,ARRAY[8,12,13,14]));

UPDATE locations SET status='SUSPENDED' WHERE status='ACTIVE' AND gln IS NOT NULL AND NOT gs1_mod10_valid(gln,ARRAY[13]);
ALTER TABLE locations DROP CONSTRAINT IF EXISTS locations_active_gln_check;
ALTER TABLE locations ADD CONSTRAINT locations_active_gln_check CHECK (status<>'ACTIVE' OR gln IS NULL OR gs1_mod10_valid(gln,ARRAY[13]));

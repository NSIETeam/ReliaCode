ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS gs1_company_prefix text;
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS sscc_next_reference bigint NOT NULL DEFAULT 0;
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_gs1_company_prefix_check;
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_gs1_company_prefix_check
  CHECK (gs1_company_prefix IS NULL OR (gs1_company_prefix~'^[0-9]{4,12}$'));
ALTER TABLE tenant_settings DROP CONSTRAINT IF EXISTS tenant_settings_sscc_next_reference_check;
ALTER TABLE tenant_settings ADD CONSTRAINT tenant_settings_sscc_next_reference_check CHECK (sscc_next_reference>=0);

ALTER TABLE code_generation_jobs ADD COLUMN IF NOT EXISTS identifier_scheme text NOT NULL DEFAULT 'SGTIN';
ALTER TABLE code_generation_jobs ADD COLUMN IF NOT EXISTS gs1_company_prefix_snapshot text;
ALTER TABLE code_generation_jobs ADD COLUMN IF NOT EXISTS sscc_extension_digit integer;
ALTER TABLE code_generation_jobs ADD COLUMN IF NOT EXISTS sscc_start_reference bigint;
UPDATE code_generation_jobs SET identifier_scheme='LEGACY_NONCONFORMING' WHERE level='PALLET' AND identifier_scheme='SGTIN';
ALTER TABLE code_generation_jobs DROP CONSTRAINT IF EXISTS code_generation_jobs_identifier_scheme_check;
ALTER TABLE code_generation_jobs ADD CONSTRAINT code_generation_jobs_identifier_scheme_check
  CHECK (identifier_scheme IN ('SGTIN','SSCC','LEGACY_NONCONFORMING'));
ALTER TABLE code_generation_jobs DROP CONSTRAINT IF EXISTS code_generation_jobs_identifier_level_check;
ALTER TABLE code_generation_jobs ADD CONSTRAINT code_generation_jobs_identifier_level_check CHECK (
  (level IN ('ITEM','CASE') AND identifier_scheme='SGTIN') OR
  (level='PALLET' AND identifier_scheme IN ('SSCC','LEGACY_NONCONFORMING'))
);
ALTER TABLE code_generation_jobs DROP CONSTRAINT IF EXISTS code_generation_jobs_sscc_snapshot_check;
ALTER TABLE code_generation_jobs ADD CONSTRAINT code_generation_jobs_sscc_snapshot_check CHECK (
  identifier_scheme<>'SSCC' OR status IN ('PENDING_APPROVAL','CANCELLED','FAILED') OR
  (gs1_company_prefix_snapshot~'^[0-9]{4,12}$' AND sscc_extension_digit BETWEEN 0 AND 9 AND sscc_start_reference>=0)
);

CREATE OR REPLACE FUNCTION gs1_mod10_check_digit(value text) RETURNS integer
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE total integer:=0; position integer; digit integer; data_length integer;
BEGIN
  IF value!~'^[0-9]+$' THEN RAISE EXCEPTION 'GS1 input must contain only digits'; END IF;
  data_length:=length(value);
  FOR position IN 1..data_length LOOP
    digit:=substr(value,position,1)::integer;
    total:=total+digit*CASE WHEN (data_length-position)%2=0 THEN 3 ELSE 1 END;
  END LOOP;
  RETURN (10-(total%10))%10;
END $$;

CREATE OR REPLACE FUNCTION gs1_sscc(company_prefix text,extension_digit integer,serial_reference bigint) RETURNS text
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE reference_width integer; body text;
BEGIN
  IF company_prefix!~'^[0-9]{4,12}$' OR extension_digit NOT BETWEEN 0 AND 9 OR serial_reference<0 THEN
    RAISE EXCEPTION 'Invalid SSCC allocation input';
  END IF;
  reference_width:=16-length(company_prefix);
  IF length(serial_reference::text)>reference_width THEN RAISE EXCEPTION 'SSCC serial reference exhausted'; END IF;
  body:=extension_digit::text||company_prefix||lpad(serial_reference::text,reference_width,'0');
  RETURN body||gs1_mod10_check_digit(body)::text;
END $$;

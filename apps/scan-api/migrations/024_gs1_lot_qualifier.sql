CREATE OR REPLACE FUNCTION gs1_xchar_valid(value text,max_length integer) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT length(value) BETWEEN 1 AND max_length AND value~'^[0-9A-Za-z!"%&''()*+,\-./_:;<=>?]+$'
$$;

ALTER TABLE code_generation_jobs DROP CONSTRAINT IF EXISTS code_generation_jobs_gs1_lot_check;
ALTER TABLE code_generation_jobs ADD CONSTRAINT code_generation_jobs_gs1_lot_check
  CHECK (lot IS NULL OR gs1_xchar_valid(lot,20)) NOT VALID;
ALTER TABLE serialized_objects DROP CONSTRAINT IF EXISTS serialized_objects_gs1_lot_check;
ALTER TABLE serialized_objects ADD CONSTRAINT serialized_objects_gs1_lot_check
  CHECK (lot IS NULL OR gs1_xchar_valid(lot,20)) NOT VALID;

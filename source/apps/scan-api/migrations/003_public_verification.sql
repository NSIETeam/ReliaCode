ALTER TABLE serialized_objects
  ADD COLUMN IF NOT EXISTS public_id uuid DEFAULT gen_random_uuid();

UPDATE serialized_objects SET public_id=gen_random_uuid() WHERE public_id IS NULL;

ALTER TABLE serialized_objects
  ALTER COLUMN public_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN public_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS serialized_objects_public_id_uq
  ON serialized_objects(public_id);

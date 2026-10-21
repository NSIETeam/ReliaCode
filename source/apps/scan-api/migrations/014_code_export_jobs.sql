ALTER TABLE code_generation_jobs
  ADD COLUMN IF NOT EXISTS export_status text,
  ADD COLUMN IF NOT EXISTS export_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS export_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS export_locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS export_last_error text,
  ADD COLUMN IF NOT EXISTS export_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS output_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS output_sha256 text;

ALTER TABLE code_generation_jobs DROP CONSTRAINT IF EXISTS code_generation_jobs_export_status_check;
ALTER TABLE code_generation_jobs ADD CONSTRAINT code_generation_jobs_export_status_check
  CHECK (export_status IS NULL OR export_status IN ('PENDING','EXPORTING','COMPLETED','FAILED','DEAD_LETTER'));

UPDATE code_generation_jobs
SET export_status='PENDING',export_available_at=now()
WHERE status='COMPLETED' AND output_object_key IS NULL AND export_status IS NULL;

CREATE INDEX IF NOT EXISTS code_generation_jobs_export_queue_idx
  ON code_generation_jobs(export_status,export_available_at,created_at)
  WHERE status='COMPLETED' AND export_status IN ('PENDING','EXPORTING','FAILED');

CREATE INDEX IF NOT EXISTS serialized_objects_tenant_batch_id_idx
  ON serialized_objects(tenant_id,code_batch_id,id);

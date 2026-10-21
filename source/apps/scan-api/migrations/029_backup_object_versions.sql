ALTER TABLE backup_runs
  ADD COLUMN IF NOT EXISTS archive_version_id text,
  ADD COLUMN IF NOT EXISTS manifest_version_id text;

ALTER TABLE backup_runs
  DROP CONSTRAINT IF EXISTS backup_runs_verified_versions_check;
ALTER TABLE backup_runs
  ADD CONSTRAINT backup_runs_verified_versions_check CHECK (
    status <> 'VERIFIED' OR (
      archive_version_id IS NOT NULL AND length(archive_version_id) > 0 AND
      manifest_version_id IS NOT NULL AND length(manifest_version_id) > 0
    )
  ) NOT VALID;

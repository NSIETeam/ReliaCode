[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BackupFile,
  [string]$ManifestFile
)

$ErrorActionPreference = 'Stop'
$backup = (Resolve-Path -LiteralPath $BackupFile).Path
if (-not $ManifestFile) { $ManifestFile = "$backup.sha256" }
if (-not (Test-Path -LiteralPath $ManifestFile)) { throw "Missing manifest: $ManifestFile" }
$expected = (Get-Content -LiteralPath $ManifestFile -Raw).Trim().Split([char[]]" ", [StringSplitOptions]::RemoveEmptyEntries)[0].ToLowerInvariant()
$actual = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expected -ne $actual) { throw "FAIL checksum mismatch for $backup" }

# This inspects the custom archive without connecting to PostgreSQL or changing data.
$restore = Get-Command pg_restore -ErrorAction SilentlyContinue
if (-not $restore) { throw 'Checksum passed, but pg_restore is required for archive inspection.' }
& $restore.Source --list $backup | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'FAIL pg_restore could not read the archive.' }
Write-Output "PASS checksum and pg_restore archive inspection: $backup"
Write-Output 'Acceptance: checksum matches and archive metadata is readable; perform full restore only in an isolated environment.'

[CmdletBinding()]
param(
  [string]$ComposeFile = 'compose.production.yaml',
  [string]$EnvFile = '.env',
  [string]$OutputDir = '.\backups'
)

$ErrorActionPreference = 'Stop'
$resolvedOutput = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmssZ'
$backup = Join-Path $resolvedOutput "reliacode-$stamp.dump"
$manifest = "$backup.sha256"

# pg_dump runs inside the postgres container, so no password or DATABASE_URL is
# placed in the process arguments or emitted to the console.
$arguments = @('--env-file', $EnvFile, '-f', $ComposeFile, 'exec', '-T', 'postgres',
  'pg_dump', '-U', 'reliacode', '-d', 'reliacode', '--format=custom', '--no-owner')
& docker compose @arguments > $backup
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
  throw 'pg_dump failed; no backup was retained.'
}
if ((Get-Item -LiteralPath $backup).Length -lt 1) { throw 'Backup is empty.' }
$hash = (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath $manifest -Value "$hash  $([IO.Path]::GetFileName($backup))" -Encoding ascii
Write-Output "Created $backup"
Write-Output "SHA256 manifest: $manifest"
Write-Output 'Acceptance: dump is non-empty and has a SHA256 sidecar; verify it before off-host transfer.'

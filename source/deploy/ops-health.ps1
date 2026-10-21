[CmdletBinding()]
param(
  [string]$BaseUrl = $env:RELIACODE_API_URL,
  [int]$TimeoutSec = 10
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw 'Set -BaseUrl or RELIACODE_API_URL (for example https://api.example.invalid).'
}
$BaseUrl = $BaseUrl.TrimEnd('/')

function Test-Endpoint([string]$Path) {
  $uri = "$BaseUrl$Path"
  try {
    $response = Invoke-WebRequest -Uri $uri -Method Get -TimeoutSec $TimeoutSec -UseBasicParsing
    if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
    Write-Output "PASS $Path HTTP 200"
  } catch {
    throw "FAIL $Path ($uri): $($_.Exception.Message)"
  }
}

Test-Endpoint '/health/live'
Test-Endpoint '/health/ready'
Write-Output 'Acceptance: live and ready endpoints both returned HTTP 200.'

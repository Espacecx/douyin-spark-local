$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot '.runtime\server.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'No running control panel was found.'
  exit 0
}

$serverPid = [int](Get-Content -Raw -LiteralPath $pidFile)
$process = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
$runtimeStatus = try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:4317/api/status' -TimeoutSec 2
} catch {
  $null
}

if ($process -and $process.ProcessName -eq 'node' -and $runtimeStatus.processId -eq $serverPid) {
  Stop-Process -Id $serverPid
  Write-Host 'The control panel has stopped.' -ForegroundColor Green
} else {
  Write-Host 'The saved process record is stale; no unrelated process was stopped.' -ForegroundColor Yellow
}
Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

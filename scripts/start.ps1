param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.runtime'
$pidFile = Join-Path $runtimeDir 'server.pid'
$logFile = Join-Path $runtimeDir 'server.log'
$errorLogFile = Join-Path $runtimeDir 'server-error.log'
$controlUrl = 'http://127.0.0.1:4317/'

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
  Write-Host 'Dependencies are missing. Run the first-time installer.' -ForegroundColor Red
  exit 1
}

try {
  Invoke-WebRequest -Uri ($controlUrl + 'api/status') -UseBasicParsing -TimeoutSec 1 | Out-Null
  if (-not $NoBrowser) { Start-Process $controlUrl }
  Write-Host 'The control panel is already running.' -ForegroundColor Green
  exit 0
} catch {}

New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$nodePath = (Get-Command node -ErrorAction Stop).Source
$tsxCli = Join-Path $projectRoot 'node_modules\tsx\dist\cli.mjs'
$process = Start-Process -FilePath $nodePath `
  -ArgumentList @($tsxCli, 'src/server.ts') `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError $errorLogFile `
  -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

$ready = $false
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 250
  try {
    Invoke-WebRequest -Uri ($controlUrl + 'api/status') -UseBasicParsing -TimeoutSec 1 | Out-Null
    $ready = $true
    break
  } catch {
    if ($process.HasExited) { break }
  }
}

if (-not $ready) {
  Write-Host "Startup failed. Check this log: $errorLogFile" -ForegroundColor Red
  exit 1
}

$runtimeStatus = Invoke-RestMethod -Uri ($controlUrl + 'api/status') -TimeoutSec 2
Set-Content -LiteralPath $pidFile -Value $runtimeStatus.processId -Encoding ascii

if (-not $NoBrowser) { Start-Process $controlUrl }
Write-Host 'The control panel is running. Closing this window will not stop it.' -ForegroundColor Green

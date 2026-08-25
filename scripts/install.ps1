$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install Node.js 22 or newer first.' -ForegroundColor Red
  exit 1
}

$major = [int]((node --version).TrimStart('v').Split('.')[0])
if ($major -lt 22) {
  Write-Host 'Node.js is too old. Upgrade to version 22 or newer.' -ForegroundColor Red
  exit 1
}

Write-Host 'Installing local dependencies...' -ForegroundColor Cyan
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host 'Installation completed. Starting the control panel.' -ForegroundColor Green
& (Join-Path $PSScriptRoot 'start.ps1')

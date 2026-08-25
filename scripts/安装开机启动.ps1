$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Douyin Spark Local.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -NoBrowser"
$shortcut.WorkingDirectory = $projectRoot
$shortcut.Description = 'Start Douyin Spark Local after Windows sign-in'
$shortcut.Save()
Write-Host "Startup shortcut installed: $shortcutPath" -ForegroundColor Green

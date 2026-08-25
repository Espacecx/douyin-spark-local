$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Douyin Spark Local.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
  Remove-Item -LiteralPath $shortcutPath -Force
  Write-Host 'Startup shortcut removed.' -ForegroundColor Green
} else {
  Write-Host 'Startup shortcut is not installed.'
}

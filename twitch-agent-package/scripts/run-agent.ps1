$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $root
$logFile = Join-Path $logDir "agent.log"

while ($true) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$ts] starting node agent.js"
  & node agent.js *>> $logFile
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$ts] agent.js exited, restarting in 5s"
  Start-Sleep -Seconds 5
}

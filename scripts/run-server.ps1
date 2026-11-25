$root = "C:\Users\Nimble_User\projects\streamer-tracker"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location $root

while ($true) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path (Join-Path $logDir "server.log") -Value "[$ts] starting node server.js"
  & node server.js *>> (Join-Path $logDir "server.log")
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path (Join-Path $logDir "server.log") -Value "[$ts] server.js exited, restarting in 5s"
  Start-Sleep -Seconds 5
}

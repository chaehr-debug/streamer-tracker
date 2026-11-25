$root = "C:\Users\Nimble_User\projects\streamer-tracker"
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$exe = Join-Path $root "bin\cloudflared.exe"
$logFile = Join-Path $logDir "tunnel.log"

while ($true) {
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$ts] starting cloudflared tunnel"
  & $exe tunnel --url http://localhost:4000 *>> $logFile
  $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$ts] tunnel exited, restarting in 5s"
  Start-Sleep -Seconds 5
}

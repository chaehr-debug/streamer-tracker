# 집계 에이전트 자동 실행 해제 및 중지
$StartupDir = [Environment]::GetFolderPath('Startup')
Remove-Item (Join-Path $StartupDir 'StreamerTracker-Agent.lnk') -ErrorAction SilentlyContinue

# start-agent.ps1 래퍼와 그 자식 node 프로세스만 종료 (다른 node 프로그램은 건드리지 않음)
$wrappers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'start-agent\.ps1' })
foreach ($w in $wrappers) {
  Get-CimInstance Win32_Process -Filter "ParentProcessId=$($w.ProcessId)" |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host '집계 에이전트를 중지하고 자동 실행을 해제했습니다. (수집용 Chrome 창은 직접 닫아도 됩니다)'

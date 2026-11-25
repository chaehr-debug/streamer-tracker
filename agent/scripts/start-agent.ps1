# 에이전트를 계속 실행하는 래퍼. node가 오류로 종료되면 10초 뒤 다시 실행한다.
# 로그는 agent.js가 logs\agent.log 에 직접 남긴다.
$ErrorActionPreference = 'Continue'
$AgentDir = Split-Path -Parent $PSScriptRoot
Set-Location $AgentDir

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

$logDir = Join-Path $AgentDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$wrapperLog = Join-Path $logDir 'wrapper.log'

while ($true) {
  $node = Find-Node
  if (-not $node) {
    Add-Content -Path $wrapperLog -Encoding UTF8 -Value "[$(Get-Date -Format s)] node.exe를 찾을 수 없습니다. Node.js 설치 후 setup.ps1을 다시 실행하세요."
    Start-Sleep -Seconds 60
    continue
  }
  & $node agent.js 2>&1 | Out-Null
  Add-Content -Path $wrapperLog -Encoding UTF8 -Value "[$(Get-Date -Format s)] agent.js 종료(코드 $LASTEXITCODE), 10초 뒤 재시작"
  Start-Sleep -Seconds 10
}

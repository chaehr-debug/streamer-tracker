# 스트리머 활동 관리 - 집계 에이전트 설치 스크립트
#
# 사용법 (이 폴더에서 PowerShell을 열고):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
#
# 하는 일:
#   1) Node.js 확인 (없으면 winget으로 설치 제안)
#   2) Chrome/Edge 확인
#   3) 필요한 패키지 설치 (npm install)
#   4) 접속 키(AGENT_SECRET) 입력받아 확인 후 .env 저장
#   5) 윈도우 로그인 시 자동 실행 등록 + 지금 바로 실행
param(
  [string]$Secret,
  [string]$WorkerUrl = 'https://streamer-tracker.coach-draft-game.workers.dev',
  [string]$Name,
  [switch]$NoAutoStart   # 설치/설정만 하고 자동 실행 등록·실행은 하지 않음
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$AgentDir = $PSScriptRoot
$StartupDir = [Environment]::GetFolderPath('Startup')
$ShortcutPath = Join-Path $StartupDir 'StreamerTracker-Agent.lnk'
$StartScript = Join-Path $AgentDir 'scripts\start-agent.ps1'

function Step($msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  [X] $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# 에이전트 래퍼(powershell)와 그 자식 node 프로세스만 종료한다 — 다른 프로젝트의 node는 건드리지 않는다.
function Stop-AgentProcesses($wrapperPattern) {
  $wrappers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match $wrapperPattern })
  foreach ($w in $wrappers) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($w.ProcessId)" |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $w.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

Write-Host '=== 스트리머 활동 관리 · 집계 에이전트 설치 ===' -ForegroundColor White

# ---------------------------------------------------------------- 1. Node.js
Step 'Node.js 확인'
$node = Find-Node
if (-not $node) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    $ans = Read-Host '  Node.js가 없습니다. 지금 설치할까요? (Y/n)'
    if ($ans -eq '' -or $ans -match '^[Yy]') {
      winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
      Refresh-Path
      $node = Find-Node
    }
  }
  if (-not $node) { Fail 'Node.js를 https://nodejs.org 에서 LTS 버전으로 설치한 뒤 이 스크립트를 다시 실행하세요.' }
}
$ver = (& $node --version).TrimStart('v')
if ([int]($ver.Split('.')[0]) -lt 18) { Fail "Node.js $ver 은(는) 너무 오래됐습니다. 18 이상(LTS)으로 업데이트하세요." }
Ok "Node.js $ver ($node)"

# ---------------------------------------------------------------- 2. 브라우저
Step 'Chrome / Edge 확인'
$roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
$candidates = @()
foreach ($r in $roots) { $candidates += (Join-Path $r 'Google\Chrome\Application\chrome.exe') }
foreach ($r in $roots) { $candidates += (Join-Path $r 'Microsoft\Edge\Application\msedge.exe') }
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Fail 'Chrome 또는 Edge를 찾지 못했습니다. Chrome을 설치한 뒤 다시 실행하세요.' }
Ok $browser

# ---------------------------------------------------------------- 3. npm install
Step '필요한 패키지 설치 (1~2분 걸릴 수 있어요)'
$npm = Join-Path (Split-Path $node) 'npm.cmd'
if (-not (Test-Path $npm)) { $npm = 'npm' }
Push-Location $AgentDir
try {
  & $npm install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm install 실패. 인터넷 연결(회사 프록시/방화벽)을 확인하세요.' }
} finally { Pop-Location }
Ok '설치 완료'

# ---------------------------------------------------------------- 4. 접속 키
Step '사이트 접속 키(AGENT_SECRET) 설정'
$envFile = Join-Path $AgentDir '.env'
$existing = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile -Encoding UTF8) {
    if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $existing[$Matches[1]] = $Matches[2].Trim() }
  }
}

function Test-Secret($url, $s) {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/agent/ping" -Headers @{ Authorization = "Bearer $s" } -TimeoutSec 15 | Out-Null
    return $true
  } catch {
    $resp = $_.Exception.Response
    if ($resp -and [int]$resp.StatusCode -eq 401) { return $false }
    if ($resp) { return $true } # 404 등: 인증은 통과(구버전 서버)
    throw "사이트($url)에 연결할 수 없습니다: $($_.Exception.Message)"
  }
}

if ($Secret) {
  if (Test-Secret $WorkerUrl $Secret) { Ok '접속 키 확인 완료' }
  else { Warn '입력한 접속 키가 올바르지 않습니다.'; $Secret = $null }
}
if (-not $Secret -and $existing['AGENT_SECRET']) {
  if (Test-Secret $WorkerUrl $existing['AGENT_SECRET']) {
    $Secret = $existing['AGENT_SECRET']
    Ok '기존 .env의 접속 키가 유효합니다.'
  } else {
    Warn '기존 .env의 접속 키가 맞지 않습니다. 새로 입력해주세요.'
  }
}
for ($i = 0; -not $Secret -and $i -lt 3; $i++) {
  $sec = Read-Host '  관리자에게 받은 AGENT_SECRET 을 붙여넣으세요' -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)).Trim()
  if (-not $plain) { continue }
  if (Test-Secret $WorkerUrl $plain) { $Secret = $plain; Ok '접속 키 확인 완료' }
  else { Warn '접속 키가 올바르지 않습니다.' }
}
if (-not $Secret) { Fail '올바른 접속 키 없이 진행할 수 없습니다.' }

if (-not $Name) { $Name = if ($existing['AGENT_NAME']) { $existing['AGENT_NAME'] } else { "$env:COMPUTERNAME ($env:USERNAME)" } }
$lines = @("WORKER_URL=$WorkerUrl", "AGENT_SECRET=$Secret", "AGENT_NAME=$Name")
foreach ($k in @('AGENT_PLATFORMS', 'CHROME_PATH', 'CDP_PORT', 'CHROME_PROFILE_DIR')) {
  if ($existing[$k]) { $lines += "$k=$($existing[$k])" }
}
# BOM 없는 UTF-8 (BOM이 있으면 첫 줄 키를 못 읽는다)
[IO.File]::WriteAllText($envFile, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding($false)))
Ok ".env 저장 (사이트에 표시될 이름: $Name)"

if ($NoAutoStart) {
  Write-Host "`n설정 완료 (자동 실행 등록은 건너뜀). 직접 실행: node agent.js" -ForegroundColor Green
  exit 0
}

# ---------------------------------------------------------------- 5. 자동 실행 등록
Step '자동 실행 등록 및 시작'

# 예전 방식(twitch-agent-package / StreamerTracker-Agent.vbs)이 같이 돌면 같은 크롬을 두고
# 서로 탭을 닫아 버리므로 정리한다.
$oldVbs = Join-Path $StartupDir 'StreamerTracker-Agent.vbs'
if (Test-Path $oldVbs) {
  Rename-Item $oldVbs "$oldVbs.disabled" -Force
  Warn '예전 자동 실행 항목(StreamerTracker-Agent.vbs)을 비활성화했습니다.'
}
Stop-AgentProcesses 'run-agent\.ps1|start-agent\.ps1'

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($ShortcutPath)
$lnk.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`""
$lnk.WorkingDirectory = $AgentDir
$lnk.WindowStyle = 7
$lnk.Description = '스트리머 활동 관리 집계 에이전트'
$lnk.Save()
Ok "윈도우 로그인 시 자동 실행: $ShortcutPath"

Start-Process -FilePath $lnk.TargetPath -ArgumentList $lnk.Arguments -WorkingDirectory $AgentDir -WindowStyle Hidden

# ---------------------------------------------------------------- 확인
$log = Join-Path $AgentDir 'logs\agent.log'
$startedAt = Get-Date
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  if ((Test-Path $log) -and (Get-Item $log).LastWriteTime -ge $startedAt) {
    $tail = Get-Content $log -Encoding UTF8 -Tail 5
    if ($tail -match '에이전트 시작') { $ok = $true }
    if ($tail -match '연결/재연결 시도' -and $i -gt 8) { break }
  }
}
if ($ok) {
  Write-Host "`n설치 완료! 사이트 상단에 '집계 PC: $Name' 이 초록색으로 보이면 정상입니다." -ForegroundColor Green
  Write-Host '수집용 Chrome 창이 하나 따로 뜹니다. 이 창은 닫지 말고 최소화해 두세요.'
  Write-Host "로그: $log"
} else {
  Warn "에이전트 시작을 확인하지 못했습니다. 로그를 확인하세요: $log"
}

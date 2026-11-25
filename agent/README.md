# 집계 에이전트 설치 안내

[스트리머 활동 관리](https://streamer-tracker.coach-draft-game.workers.dev/) 사이트의 **치지직·트위치 집계/검색**은
서버가 아니라, 이 에이전트가 설치돼 켜져 있는 PC 중 한 대가 처리합니다.
(치지직 통계 사이트 softc.one과 twitchtracker.com은 봇 차단이 있어서 실제 Chrome으로 가져와야 하기 때문입니다.)

사이트 오른쪽 위의 **집계 PC** 표시로 상태를 확인할 수 있습니다.

| 표시 | 뜻 |
|---|---|
| 🟢 집계 PC n대 연결됨 | 집계 실행 가능 |
| 🔴 켜진 집계 PC 없음 | 아무 PC도 켜져 있지 않아 치지직·트위치 집계가 실행되지 않음 (유튜브는 PC 없이 동작) |

본인 PC에 설치해 두면, 다른 PC가 꺼져 있어도 본인 PC에서 집계가 처리됩니다.

## 설치 (Windows, 약 3분)

준비물: **Chrome**(없으면 Edge 자동 사용), 관리자에게 받은 **접속 키(AGENT_SECRET)**

1. 이 저장소를 내려받습니다: [ZIP 다운로드](https://github.com/chaehr-debug/streamer-tracker/archive/refs/heads/main.zip) → 압축 해제
   (예: `C:\Users\<이름>\streamer-tracker`)
2. 압축을 푼 폴더 안의 `agent` 폴더를 열고, 주소창에 `powershell` 입력 후 Enter
3. 아래 명령을 붙여넣고 Enter

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
   ```

4. 안내에 따라 진행합니다.
   - Node.js가 없으면 설치할지 물어봅니다 → `Y`
   - 접속 키를 물어보면 관리자에게 받은 값을 붙여넣습니다 (입력값은 화면에 보이지 않습니다)
5. `설치 완료!`가 나오면 끝입니다. 사이트 새로고침 후 오른쪽 위에 본인 PC 이름이 보이면 정상입니다.

설치 후에는 **윈도우에 로그인할 때마다 자동으로 실행**됩니다.
수집용 Chrome 창이 따로 하나 뜨는데, **닫지 말고 최소화**해 두세요. (평소 쓰는 Chrome과는 별개의 창입니다.)

## 자주 묻는 문제

| 증상 | 해결 |
|---|---|
| 사이트에 계속 "켜진 집계 PC 없음" | `agent\logs\agent.log` 마지막 줄 확인. 접속 키 오류면 `setup.ps1` 다시 실행 |
| "Chrome 또는 Edge를 찾지 못했습니다" | Chrome 설치, 또는 `agent\.env`에 `CHROME_PATH=chrome.exe 전체 경로` 추가 |
| "포트 … 에 연결할 수 없습니다" | 다른 프로그램이 9222 포트 사용 중 → `agent\.env`에 `CDP_PORT=9333` 추가 후 PC 재로그인 |
| `npm install 실패` | 회사 네트워크(프록시/방화벽)에서 npm 접속이 막혔는지 확인 |
| 보안 확인(Vercel 체크포인트) 오류 | 수집용 Chrome 창에서 `viewership.softc.one`을 직접 한 번 열어 확인 후 다시 실행 |

설정을 바꾼 뒤에는 `setup.ps1`을 다시 실행하면 적용됩니다.

## 선택 설정 (`agent\.env`)

```ini
AGENT_NAME=사이트에 표시될 이름       # 기본: PC 이름 (사용자명)
AGENT_PLATFORMS=twitch               # 특정 플랫폼만 처리 (비우면 전부)
CHROME_PATH=C:\경로\chrome.exe        # 브라우저를 못 찾을 때만
CDP_PORT=9333                        # 포트가 겹칠 때만
```

## 제거

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

자동 실행이 해제되고 에이전트가 중지됩니다. 그 다음 폴더를 지우면 됩니다.

## 동작 방식 (관리자용)

- 사이트에서 집계 버튼을 누르면 Worker가 D1 `jobs` 테이블에 작업을 넣습니다.
- 켜져 있는 에이전트들이 3초마다 `/agent/next-job`으로 작업을 하나씩 가져갑니다. 한 작업은 한 PC만 가져갑니다.
- 에이전트는 대기 중에는 작업 조회, 작업 중에는 15초마다 `/agent/ping`으로 생존 신호를 보냅니다.
  Worker는 이 신호를 `agents` 테이블에 기록하고, 45초 안에 신호가 있으면 "켜짐"으로 표시합니다.
- 켜진 PC가 없으면 사이트가 몇 초 안에 작업을 취소하고 알려 줍니다(작업이 쌓였다가 나중에 뒤늦게 실행되지 않음).
- 40분 넘게 `running`인 작업은 PC가 도중에 꺼진 것으로 보고 실패 처리합니다.

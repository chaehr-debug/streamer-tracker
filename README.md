# 스트리머 활동 관리 (streamer-tracker)

이터널 리턴 스트리머들의 **치지직 · Twitch · 유튜브** 월간 활동(방송 시간, 시청자 수, 팔로워 증감, 영상 조회수)을
한곳에 모아 관리하는 사내 웹 도구입니다.

- 사이트: https://streamer-tracker.coach-draft-game.workers.dev/ (사내 비밀번호 필요)
- 사이트 안 사용 안내: 상단 **📖 사용 안내** (`/guide.html`)

---

## 1. 무엇을 할 수 있나

| 플랫폼 | 할 수 있는 일 | 데이터 출처 |
|---|---|---|
| **치지직** | 스트리머 검색·등록(1명 / 여러 명), 지난달 집계, 전체 집계, **스트리머 심사** | viewership.softc.one |
| **Twitch** | 지역별(NA/EU · SA/ASIA · JP · TW) 등록, 지난달 이터널 리턴 카테고리 집계 | twitchtracker.com |
| **유튜브** | 채널 등록, 지난달 업로드 영상 수·평균 조회수 집계 | YouTube Data API |

공통 기능
- **스트리머 관리**: 목록 드래그로 순서 변경, `관리` 모드에서 선택 삭제, 상태(크리에이터/파트너)·메모
- **지난달 전체 현황**: 플랫폼별 지난달 지표 표, 열 정렬, **CSV로 내보내기**
- **스트리머 심사**(치지직): 후보를 심사 명단에 올리고 `지난달 활동 집계` → 지난달 이터널 리턴 카테고리
  **방송 30시간 이상 + 평균 시청자 30명 이상**이면 자동으로 정식 스트리머(크리에이터)로 등록

## 2. 집계 PC(에이전트) — 꼭 알아야 할 것

치지직·Twitch 통계 사이트는 봇 차단이 있어서 서버가 직접 가져올 수 없습니다.
그래서 **에이전트가 설치돼 켜져 있는 PC**가 실제 Chrome으로 데이터를 가져옵니다. (유튜브는 서버가 직접 처리)

- 사이트 오른쪽 위 표시
  - 🟢 **집계 PC n대 연결됨** → 집계 가능
  - 🔴 **켜진 집계 PC 없음** → 치지직·Twitch 집계/검색 불가. 요청하면 몇 초 안에 취소되고 안내가 뜹니다.
- 여러 PC에 설치해 두면 그중 켜져 있는 한 대가 처리합니다. 한 작업을 두 PC가 중복 처리하지 않습니다.

### 내 PC에 설치하기 (Windows, 약 3분)

1. 사이트 오른쪽 위 **⬇ 내 PC에 에이전트 설치** 클릭 → `StreamerTracker-Agent-Setup.cmd` 다운로드
   (브라우저가 "위험할 수 있는 파일"이라고 하면 **계속/보관**)
2. 받은 파일 실행 → "Windows의 PC 보호" 창이 뜨면 **추가 정보 → 실행**
3. 자동 설치 진행. Node.js가 없으면 설치 여부를 물어봄 → `Y`
4. "설치 완료"가 나오면 사이트 새로고침 → 내 PC 이름이 🟢로 보이면 끝

- 윈도우 로그인 때마다 자동 실행됩니다. 따로 뜨는 **수집용 Chrome 창은 닫지 말고 최소화**하세요.
- 같은 파일을 다시 실행하면 최신 버전으로 업데이트됩니다.
- 제거: `%LOCALAPPDATA%\StreamerTrackerAgent\uninstall.ps1` 실행
- 수동 설치·문제 해결·설정: [agent/README.md](agent/README.md)

## 3. 구조

```
[브라우저] ──(비밀번호)──▶ [Cloudflare Worker + D1]  ◀──(접속 키, 3초마다 작업 조회)── [집계 PC 에이전트 × n]
   버튼 클릭 → jobs 테이블에 작업 등록                     작업 가져감 → Chrome으로 수집 → 결과 보고
```

| 폴더 | 내용 |
|---|---|
| `worker/` | Cloudflare Worker(API + 화면). `src/index.js`, 화면 `public/`, DB 스키마 `schema.sql`, 마이그레이션 `migrations/` |
| `agent/` | 집계 PC 에이전트(Node.js + Playwright). 설치 `setup.ps1`, 제거 `uninstall.ps1` |
| 루트의 `agent.js`, `lib/`, `server.js` 등 | 초기 버전 / 개발 중 실험 스크립트 (운영에는 `agent/` 사용) |

D1 테이블: `streamers`, `monthly_records`, `jobs`, `screening_candidates`, `agents`(집계 PC 접속 상태)

## 4. 관리자용

### 배포

```powershell
cd worker
npx wrangler deploy
```

### DB 마이그레이션 (스키마 변경 시)

```powershell
cd worker
npx wrangler d1 execute streamer-tracker-db --remote --file migrations/0001_agents.sql
```

### Secret (Cloudflare에 저장, 저장소에는 없음)

| 이름 | 용도 |
|---|---|
| `ADMIN_PASSWORD` | 사이트 로그인 비밀번호 |
| `AGENT_SECRET` | 에이전트 접속 키 (설치 파일에 자동 포함) |
| `YOUTUBE_API_KEY` | 유튜브 집계 |

변경: `npx wrangler secret put <이름>`
`AGENT_SECRET`을 바꾸면 기존에 설치된 PC들은 설치 파일을 다시 받아 실행해야 합니다.

### 작업 처리 규칙

- 에이전트는 대기 중엔 3초마다 작업 조회, 작업 중엔 15초마다 생존 신호 → 45초 안에 신호가 있으면 "켜짐"
- 켜진 PC가 없으면 화면이 작업을 바로 취소 (나중에 뒤늦게 실행되지 않음)
- 40분 넘게 `running`인 작업은 PC가 도중에 꺼진 것으로 보고 자동 실패 처리
- 작업별 제한 시간: 검색 150초, 단건 집계 90초, 전체 집계·심사 30분

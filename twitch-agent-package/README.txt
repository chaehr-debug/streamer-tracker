Twitch 전용 집계 에이전트 - 다른 PC 설치 가이드
================================================

이 폴더는 두 번째 PC에서 Twitch(twitchtracker.com) 집계만 처리하는
에이전트를 돌리기 위한 최소 구성입니다. 로그인이 필요 없는 사이트라
어느 PC에서든 그대로 실행할 수 있습니다.

준비물
------
1. Node.js 설치 (https://nodejs.org, LTS 버전)
2. Google Chrome 설치 (일반적인 위치: C:\Program Files\Google\Chrome\Application\chrome.exe)

설치 순서
---------
1. 이 폴더(twitch-agent-package) 전체를 두 번째 PC의 아무 위치에 복사합니다.
   예: C:\Users\<사용자명>\twitch-agent\

2. 복사한 폴더에서 PowerShell을 열고 아래 명령을 실행합니다.

     npm install

3. .env 파일은 이미 채워져 있습니다 (WORKER_URL, AGENT_SECRET,
   AGENT_PLATFORMS=twitch). 수정할 필요 없습니다.

4. 아래 명령으로 에이전트를 상시 실행합니다 (창을 숨기고 뒤에서 계속 돌립니다).

     powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-agent.ps1

   이 창을 그대로 열어두거나, 백그라운드로 띄우려면:

     Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','.\scripts\run-agent.ps1' -WindowStyle Hidden

5. 정상 동작 확인: logs\agent.log 파일에
   "에이전트 시작. WORKER_URL = ... / 처리 플랫폼 = twitch" 가 찍히면 성공입니다.

동작 방식
---------
- 이 에이전트는 Twitch job만 골라서 처리하고, 치지직(CHZZK) job은
  건드리지 않습니다. 기존 PC의 에이전트와 동시에 켜둬도 서로 충돌하지
  않습니다.
- 사이트 웹페이지에서 Twitch 탭 → 원하는 지역 탭 → "Twitch [지역] 집계
  실행" 버튼을 누르면, 이 PC의 에이전트가 그 job을 받아서 처리합니다.
- Chrome은 최초 실행 시 자동으로 디버그 모드로 하나 띄워집니다
  (C:\Users\<사용자명>\chrome-debug-profile 폴더를 새로 만들어 사용).
  이 창은 계속 떠 있어야 하며, 사람이 직접 쓰는 크롬과는 별도입니다.

문제가 있다면
-------------
- Chrome 경로가 다르면 .env에 CHROME_PATH=경로 를 한 줄 추가하세요.
- 방화벽에서 node.exe / chrome.exe의 인터넷 접근을 허용해야 합니다.

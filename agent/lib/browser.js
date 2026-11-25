const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 에이전트 전용 크롬은 디버그 포트(CDP)를 열고 띄운 "일반" 크롬에 Playwright로 붙는 방식이다.
// Playwright가 직접 띄운 크롬은 자동화 브라우저로 감지돼 softc.one(Vercel 체크포인트)에서
// 막히지만, 이렇게 띄운 크롬은 로그인 없이도 정상 통과한다.
const CDP_PORT = Number(process.env.CDP_PORT) || 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
const PROFILE_DIR = process.env.CHROME_PROFILE_DIR || path.join(os.homedir(), 'chrome-debug-profile');

// PC마다 크롬 설치 위치가 다르다(전체 사용자 설치 / 32비트 / 사용자 계정에만 설치).
// 크롬이 없으면 윈도우에 기본으로 깔려 있는 Edge(같은 Chromium 기반)로 대신 돌린다.
function browserCandidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    return [
      ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

function findBrowserPath() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) {
      throw new Error(`.env의 CHROME_PATH 경로에 파일이 없습니다: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const found = browserCandidates().find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      'Chrome 또는 Edge를 찾지 못했습니다. Chrome을 설치하거나, .env에 CHROME_PATH=실행파일경로 를 추가해주세요.'
    );
  }
  return found;
}

async function tryConnect() {
  try {
    return await chromium.connectOverCDP(CDP_URL, { timeout: 3000 });
  } catch (e) {
    return null;
  }
}

async function ensureBrowser() {
  let browser = await tryConnect();
  if (browser) return browser;

  const exe = findBrowserPath();
  console.log(`[${new Date().toISOString()}] 수집용 브라우저 실행: ${exe} (포트 ${CDP_PORT})`);
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.on('error', (err) => console.error('브라우저 실행 실패:', err.message));
  child.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    browser = await tryConnect();
    if (browser) return browser;
  }
  throw new Error(
    `수집용 브라우저(포트 ${CDP_PORT})에 연결할 수 없습니다. 다른 프로그램이 이 포트를 쓰고 있다면 ` +
      '.env에 CDP_PORT=9333 처럼 다른 포트를 지정해주세요.'
  );
}

// 수집 작업 전용 탭. 사용자가 이 창에서 보고 있는 다른 탭은 건드리지 않고,
// 재시작을 반복해도 탭이 쌓이지 않게 예전 자동화 탭(softc.one / twitchtracker.com)만 정리한다.
async function getWorkingPage(browser) {
  const context = browser.contexts()[0] || (await browser.newContext());
  for (const p of context.pages()) {
    const u = p.url();
    if (u.includes('softc.one') || u.includes('twitchtracker.com')) {
      await p.close().catch(() => {});
    }
  }
  return context.newPage();
}

module.exports = { ensureBrowser, getWorkingPage, findBrowserPath, PROFILE_DIR, CDP_PORT };

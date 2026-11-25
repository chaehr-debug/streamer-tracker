const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const DEFAULT_CHROME_PATH_BY_PLATFORM = {
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: 'google-chrome',
};

const CDP_URL = 'http://localhost:9222';
// 다른 PC(맥/리눅스 등)에서 돌릴 때는 .env에 CHROME_PATH를 직접 지정하면 된다.
const CHROME_PATH = process.env.CHROME_PATH || DEFAULT_CHROME_PATH_BY_PLATFORM[process.platform] || 'google-chrome';
const PROFILE_DIR = path.join(require('os').homedir(), 'chrome-debug-profile');

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

  spawn(CHROME_PATH, [`--remote-debugging-port=9222`, `--user-data-dir=${PROFILE_DIR}`, 'about:blank'], {
    detached: true,
    stdio: 'ignore',
  }).unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    browser = await tryConnect();
    if (browser) return browser;
  }
  throw new Error(
    'Chrome 디버그 인스턴스에 연결할 수 없습니다. 로그인이 필요할 수 있습니다 (직접 프로필로 한 번 로그인해주세요).'
  );
}

async function getSoftcPage(browser) {
  const context = browser.contexts()[0];
  const pages = context.pages();
  let page = pages.find((p) => p.url().includes('softc.one'));
  if (!page) {
    page = pages[0] || (await context.newPage());
  }
  return page;
}

// CHZZK(softc.one)와 Twitch(twitchtracker.com) 수집에 공용으로 쓰는 작업용 탭.
// 이 크롬 프로필은 사람이 직접 브라우징할 때도 쓰이므로, 기존 탭(pages[0])을 재사용하면
// 사용자가 보고 있는 탭을 가로챌 위험이 있다. 항상 새 탭을 만들어 자동화 전용으로 쓰고,
// 에이전트가 재시작을 반복해도 탭이 계속 쌓이지 않도록 이전에 남은 자동화 탭(softc.one /
// twitchtracker.com)만 골라서 정리한다 — 사용자의 다른 탭은 절대 건드리지 않는다.
async function getWorkingPage(browser) {
  const context = browser.contexts()[0];
  for (const p of context.pages()) {
    const u = p.url();
    if (u.includes('softc.one') || u.includes('twitchtracker.com')) {
      await p.close().catch(() => {});
    }
  }
  return context.newPage();
}

module.exports = { ensureBrowser, getSoftcPage, getWorkingPage, PROFILE_DIR, CHROME_PATH };

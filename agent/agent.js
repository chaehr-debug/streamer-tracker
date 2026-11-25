const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

// ---- 로그: logs/agent.log 에 UTF-8로 직접 기록 (PowerShell 리다이렉트는 한글이 깨진다) ----
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'agent.log');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
fs.mkdirSync(LOG_DIR, { recursive: true });
function writeLog(line) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) {
    // 로그 실패로 에이전트가 멈추면 안 된다.
  }
}
for (const level of ['log', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    writeLog(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack : JSON.stringify(a))).join(' '));
  };
}

// ---- 한 PC에서 에이전트가 두 개 뜨면 같은 크롬 탭을 서로 닫아 버리므로 하나만 실행 ----
const LOCK_FILE = path.join(__dirname, 'agent.lock');
function acquireLock() {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // 살아있으면 예외 없음
      console.log(`이미 이 PC에서 에이전트가 실행 중입니다 (pid ${pid}). 종료합니다.`);
      process.exit(0);
    }
  } catch (e) {
    // 락 파일이 없거나 이전 프로세스가 죽었음
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid));
  const release = () => {
    try {
      if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch (e) {}
  };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

const { ensureBrowser, getWorkingPage } = require('./lib/browser');
const { searchChannel, fetchMonthlyStats, fetchCategoryBreakdown, lastMonthYearMonth } = require('./lib/crawler');
const twitchCrawler = require('./lib/twitchCrawler');

const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');
const AGENT_SECRET = process.env.AGENT_SECRET;
if (!WORKER_URL || !AGENT_SECRET) {
  console.error('.env 파일에 WORKER_URL, AGENT_SECRET이 없습니다. setup.ps1을 다시 실행해주세요.');
  process.exit(1);
}
// 사이트 상단의 "집계 PC" 표시에 나오는 이름. 기본값은 PC 이름.
const AGENT_NAME = (process.env.AGENT_NAME || os.hostname()).slice(0, 60);

// 이 에이전트가 처리할 플랫폼 (예: "twitch" 또는 "naverchzzk,twitch"). 비워두면 전부 처리.
const AGENT_PLATFORMS = (process.env.AGENT_PLATFORMS || '').trim();
const NEXT_JOB_PATH = AGENT_PLATFORMS
  ? `/agent/next-job?platform=${encodeURIComponent(AGENT_PLATFORMS)}`
  : '/agent/next-job';

const POLL_INTERVAL_MS = 3000;

// 작업 하나가 응답 없이 멈추면(예: 크롬 CDP 연결이 끊긴 채로 page.goto가 영영 안 끝나는 경우)
// 이 에이전트는 job을 순서대로 하나씩만 처리하므로, 뒤에 쌓인 다른(다른 플랫폼 포함) job이
// 전부 막혀버린다. 그래서 job 타입별로 최대 대기 시간을 두고, 넘기면 해당 job만 실패
// 처리하고 다음 job으로 넘어간다.
const JOB_TIMEOUT_MS = {
  search: 150 * 1000,
  collect: 90 * 1000,
  // 지역별 스트리머 수 차이가 커서(예: JP 60명대 vs TW/NA-EU 20명대) 가장 많은 지역 기준으로
  // 여유 있게 잡는다 — streamer당 평균 15~20초 소요 기준 60명이면 15~20분 걸릴 수 있다.
  collect_all: 30 * 60 * 1000,
  screening_collect_all: 30 * 60 * 1000,
};

// page/context/browser가 (사람이 실수로 닫거나, 다른 스크립트가 같은 탭을 건드리는 등의
// 이유로) 중간에 닫히면 Playwright는 이런 메시지로 던진다. 한 번 이게 뜨면 같은 page로는
// 이후 어떤 동작도 똑같이 실패하므로, 배치 작업이라면 나머지를 전부 똑같은 이유로 실패시키며
// 낭비하지 않고 즉시 중단하고, 호출한 쪽에 page를 새로 열어야 한다고 알린다.
function isDeadPageError(err) {
  return /Target (page|context|browser)[^.]*(has been closed|closed)/i.test((err && err.message) || '');
}

async function agentFetch(path, opts) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AGENT_SECRET}`,
      'X-Agent-Name': encodeURIComponent(AGENT_NAME),
      ...(opts && opts.headers),
    },
  });
  if (res.status === 401) {
    throw new Error('AGENT_SECRET이 올바르지 않습니다. 관리자에게 받은 값으로 setup.ps1을 다시 실행해주세요.');
  }
  return res.json();
}

async function completeJob(jobId, status, result) {
  await agentFetch(`/agent/jobs/${jobId}/complete`, {
    method: 'POST',
    body: JSON.stringify({ status, result }),
  });
}

async function handleSearch(page, payload) {
  return searchChannel(page, payload.name);
}

async function collectStats(page, streamer, dateParam) {
  if (streamer.platform === 'twitch') {
    const yearMonth = dateParam && dateParam !== 'lastmonth' ? dateParam : twitchCrawler.lastMonthYearMonth();
    const stats = await twitchCrawler.fetchMonthlyGameStats(page, streamer.channel_id, yearMonth);
    return { ...stats, yearMonth };
  }
  const stats = await fetchMonthlyStats(page, streamer.channel_href, dateParam || 'lastmonth');
  return { ...stats, yearMonth: lastMonthYearMonth() };
}

async function handleCollect(page, payload) {
  return collectStats(page, payload.streamer, payload.dateParam);
}

async function handleCollectAll(page, payload) {
  const results = [];
  for (const s of payload.streamers) {
    try {
      const stats = await collectStats(page, s, 'lastmonth');
      results.push({ streamerId: s.id, name: s.name, ok: true, ...stats });
    } catch (err) {
      results.push({ streamerId: s.id, name: s.name, ok: false, error: err.message });
      if (isDeadPageError(err)) {
        results.pageDied = true;
        break;
      }
    }
    // 연속 요청이 몰리면 사이트의 봇 차단이 걸리기 쉬워 스트리머 사이에 텀을 둔다.
    await new Promise((r) => setTimeout(r, 2000));
  }
  return results;
}

// 치지직 "스트리머 심사" 명단 전용: 채널별 지난달 카테고리 breakdown에서 이터널 리턴
// 항목만 뽑아 온다. 지난달에 이터널 리턴을 아예 안 했으면(카테고리 목록에 없음) 0으로 처리 —
// 심사 기준 미달로 자연스럽게 이어진다.
async function handleScreeningCollectAll(page, payload) {
  const results = [];
  for (const c of payload.candidates) {
    try {
      const rows = await fetchCategoryBreakdown(page, c.channel_href, 'lastmonth');
      const er = rows.find((r) => r.category === '이터널 리턴') || { broadcastHours: 0, avgViewers: 0, maxViewers: 0 };
      results.push({
        candidateId: c.id,
        name: c.name,
        ok: true,
        broadcastHours: er.broadcastHours,
        avgViewers: er.avgViewers,
        maxViewers: er.maxViewers,
        yearMonth: lastMonthYearMonth(),
      });
    } catch (err) {
      results.push({ candidateId: c.id, name: c.name, ok: false, error: err.message });
      if (isDeadPageError(err)) {
        results.pageDied = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return results;
}

// 반환값: 이 작업을 처리한 page가 계속 재사용해도 괜찮은 상태인지(true) 여부.
// 시간 초과로 중단된 경우, 백그라운드에서 원래 작업이 여전히 page를 건드리고 있을 수
// 있어 false를 반환하고, 호출한 쪽에서 page를 새로 열게 한다.
async function processJob(page, job) {
  console.log(`[${new Date().toISOString()}] job #${job.id} (${job.type}) 처리 시작`);
  const timeoutMs = JOB_TIMEOUT_MS[job.type] || 60 * 1000;
  let timedOut = false;
  // 긴 작업(전체 집계 등) 중에도 사이트에 "이 PC가 작업 중"이라고 계속 알린다.
  const pingPath = `/agent/ping?job=${job.id}&platform=${encodeURIComponent(AGENT_PLATFORMS)}`;
  const heartbeat = setInterval(() => agentFetch(pingPath).catch(() => {}), 15 * 1000);
  try {
    const run = (async () => {
      if (job.type === 'search') return handleSearch(page, job.payload);
      if (job.type === 'collect') return handleCollect(page, job.payload);
      if (job.type === 'collect_all') return handleCollectAll(page, job.payload);
      if (job.type === 'screening_collect_all') return handleScreeningCollectAll(page, job.payload);
      throw new Error(`알 수 없는 job 타입: ${job.type}`);
    })();
    let timer;
    const result = await Promise.race([
      run,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`시간 초과(${timeoutMs / 1000}초): 응답이 없어 이 작업을 건너뜁니다.`));
        }, timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));

    await completeJob(job.id, 'done', result);
    console.log(`[${new Date().toISOString()}] job #${job.id} 완료`);
    return !(result && result.pageDied);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] job #${job.id} 실패:`, err.message);
    await completeJob(job.id, 'error', { error: err.message });
    return !timedOut && !isDeadPageError(err);
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  acquireLock();
  console.log(
    `[${new Date().toISOString()}] 에이전트 시작. 이름 = ${AGENT_NAME} / WORKER_URL = ${WORKER_URL} / 처리 플랫폼 = ${AGENT_PLATFORMS || '전체'}`
  );
  let browser = null;
  let page = null;

  // 크롬 창이 도중에 닫히거나(사용자가 실수로 닫거나, 재부팅 등) 최초 연결 자체가
  // 실패하는 경우 모두 여기서 처리한다. 이 함수가 던지는 오류는 항상 while 루프의
  // try/catch가 잡으므로, 브라우저 연결 문제로 프로세스 전체가 죽는 일은 없다
  // (예전에는 초기 연결 실패 시 process가 죽고 PowerShell 래퍼가 5초마다 재시작하며
  // 크롬 창을 계속 새로 띄우는 문제가 있었다).
  async function ensureConnected() {
    if (browser && browser.isConnected()) return;
    console.log(`[${new Date().toISOString()}] 브라우저에 연결/재연결 시도...`);
    browser = await ensureBrowser();
    page = await getWorkingPage(browser);
  }

  while (true) {
    try {
      await ensureConnected();
      const { job } = await agentFetch(NEXT_JOB_PATH);
      if (job) {
        const pageStillHealthy = await processJob(page, job);
        if (!pageStillHealthy) {
          console.log(`[${new Date().toISOString()}] 응답 없던 작업 탭을 정리하고 새로 엽니다.`);
          await page.close().catch(() => {});
          page = await getWorkingPage(browser);
        }
        continue;
      }
    } catch (err) {
      console.error('폴링 오류:', err.message);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] 치명적 오류, 프로세스를 종료합니다:`, err.message);
  process.exit(1);
});

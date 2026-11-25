require('dotenv').config();
const { ensureBrowser, getWorkingPage } = require('./lib/browser');
const { searchChannel, fetchMonthlyStats, lastMonthYearMonth } = require('./lib/crawler');
const twitchCrawler = require('./lib/twitchCrawler');

const WORKER_URL = process.env.WORKER_URL;
const AGENT_SECRET = process.env.AGENT_SECRET;
if (!WORKER_URL || !AGENT_SECRET) {
  throw new Error('.env 파일에 WORKER_URL, AGENT_SECRET을 설정해주세요.');
}

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
  search: 60 * 1000,
  collect: 90 * 1000,
  // 지역별 스트리머 수 차이가 커서(예: JP 60명대 vs TW/NA-EU 20명대) 가장 많은 지역 기준으로
  // 여유 있게 잡는다 — streamer당 평균 15~20초 소요 기준 60명이면 15~20분 걸릴 수 있다.
  collect_all: 30 * 60 * 1000,
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_SECRET}`, ...(opts && opts.headers) },
  });
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

// 반환값: 이 작업을 처리한 page가 계속 재사용해도 괜찮은 상태인지(true) 여부.
// 시간 초과로 중단된 경우, 백그라운드에서 원래 작업이 여전히 page를 건드리고 있을 수
// 있어 false를 반환하고, 호출한 쪽에서 page를 새로 열게 한다.
async function processJob(page, job) {
  console.log(`[${new Date().toISOString()}] job #${job.id} (${job.type}) 처리 시작`);
  const timeoutMs = JOB_TIMEOUT_MS[job.type] || 60 * 1000;
  let timedOut = false;
  try {
    const run = (async () => {
      if (job.type === 'search') return handleSearch(page, job.payload);
      if (job.type === 'collect') return handleCollect(page, job.payload);
      if (job.type === 'collect_all') return handleCollectAll(page, job.payload);
      throw new Error(`알 수 없는 job 타입: ${job.type}`);
    })();
    const result = await Promise.race([
      run,
      new Promise((_, reject) =>
        setTimeout(() => {
          timedOut = true;
          reject(new Error(`시간 초과(${timeoutMs / 1000}초): 응답이 없어 이 작업을 건너뜁니다.`));
        }, timeoutMs)
      ),
    ]);

    await completeJob(job.id, 'done', result);
    console.log(`[${new Date().toISOString()}] job #${job.id} 완료`);
    return !(result && result.pageDied);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] job #${job.id} 실패:`, err.message);
    await completeJob(job.id, 'error', { error: err.message });
    return !timedOut && !isDeadPageError(err);
  }
}

async function main() {
  console.log('에이전트 시작. WORKER_URL =', WORKER_URL, '/ 처리 플랫폼 =', AGENT_PLATFORMS || '전체');
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

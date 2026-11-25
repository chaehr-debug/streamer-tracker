const BASE = 'https://viewership.softc.one';

function extractStat(html, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped + '</div><div class="leading-none text-xl font-bold">([\\d.]+)');
  const m = html.match(re);
  return m ? Number(m[1]) : null;
}

function assertNotCheckpoint(html, context) {
  if (html.includes('Vercel Security Checkpoint')) {
    throw new Error(
      `[${context}] softc.one 보안 확인(Vercel 체크포인트)을 통과하지 못했습니다. 잠시 후 다시 시도해주세요. ` +
        `계속 반복되면 수집용 브라우저 창에서 viewership.softc.one 을 한 번 직접 열어 확인해주세요.`
    );
  }
}

// 체크포인트는 실제 브라우저에서 몇 초 기다리면 자동으로 풀리는 경우가 많아,
// 곧바로 에러를 던지지 않고 몇 번 재확인한다 (특히 크롬 프로필이 막 새로 뜬 직후 잘 걸린다).
async function waitOutCheckpoint(page, context) {
  let html = await page.content();
  for (let i = 0; i < 5 && html.includes('Vercel Security Checkpoint'); i++) {
    await page.waitForTimeout(1500);
    html = await page.content();
  }
  assertNotCheckpoint(html, context);
  return html;
}

// softc.one은 요청 "간격"이 아니라 짧은 시간 창(window) 안의 "총 횟수"로 막는 것으로
// 보인다 — 실측해보니 간격을 3초씩 띄워도 다섯 번째 전후로 "429: Too Many Requests"
// 타이틀이 뜨기 시작했다. 이걸 그냥 지나치면 검색 결과가 0개로 보여서 실제로 존재하는
// 스트리머인데도 "결과 없음"으로 오판한다. 그래서
// 1) 이 모듈을 통한 요청을 일정 개수(BURST_SIZE)마다 한 번씩 미리 쉬어가고,
// 2) 그래도 429가 뜨면 window가 다 풀릴 만큼 충분히 기다렸다가 같은 URL로 재시도한다.
const BURST_SIZE = 5;
const BURST_COOLDOWN_MS = 10000;
const MIN_REQUEST_GAP_MS = 1200;
let requestCount = 0;
let lastRequestAt = 0;

async function gotoSoftc(page, url, { timeout = 30000, retries = 3 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    requestCount++;
    if (requestCount % BURST_SIZE === 0) {
      await page.waitForTimeout(BURST_COOLDOWN_MS);
    } else {
      const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
    }
    lastRequestAt = Date.now();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const title = await page.title();
    if (!title.includes('429')) return;
    if (attempt === retries) {
      throw new Error(`softc.one 요청이 많아 일시적으로 차단(429)되었습니다. 잠시 후 다시 시도해주세요. (url: ${url})`);
    }
    await page.waitForTimeout(15000 * (attempt + 1));
  }
}

async function searchChannel(page, streamerName) {
  const url = `${BASE}/search?q=${encodeURIComponent(streamerName)}`;
  await gotoSoftc(page, url);
  await waitOutCheckpoint(page, 'search');

  const links = await page.$$eval('a[href*="/channel/"]', (els) =>
    els.map((e) => ({ href: e.getAttribute('href'), text: e.textContent.trim() }))
  );
  if (links.length === 0) {
    throw new Error(`"${streamerName}" 검색 결과가 없습니다.`);
  }

  const exact = links.find((l) => l.text.startsWith(streamerName));
  const chosen = exact || links[0];
  const match = chosen.href.match(/\/channel\/([^/]+)\/([^/?]+)/);
  return {
    platform: match[1],
    channelId: match[2],
    href: chosen.href,
    matchedText: chosen.text,
    allCandidates: links,
  };
}

// dateParam: 'lastmonth' | 'thismonth' | 'thisweek' | 'recent7days' | ...
async function fetchMonthlyStats(page, href, dateParam = 'lastmonth') {
  const url = `${BASE}${href}?date=${dateParam}`;
  await gotoSoftc(page, url);
  await page.waitForTimeout(1000);
  const html = await waitOutCheckpoint(page, 'stats');

  const broadcastHours = extractStat(html, '방송 시간');
  const avgViewers = extractStat(html, '평균 시청자');
  const maxViewers = extractStat(html, '동시 최고 시청자');

  if (broadcastHours === null && avgViewers === null && maxViewers === null) {
    throw new Error(`통계를 찾을 수 없습니다. 페이지 구조가 바뀌었을 수 있습니다. (url: ${url})`);
  }

  return { broadcastHours, avgViewers, maxViewers, sourceUrl: url };
}

function lastMonthYearMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// 채널의 /categories 페이지는 카테고리(게임)별 방송시간/시청자 요약을 보여준다.
// React 앱이라 <table> 태그가 아니라 각 행이 <a> 하나에 "카테고리...방송시간...h6분
// 최고채팅...6분 평균채팅...최고시청자...평균시청자...뷰어십..." 형태의 라벨+값이 붙어있는
// 텍스트로 렌더링되어, 정규식으로 파싱한다(데스크톱/모바일 두 레이아웃이 같은 <a> 안에
// 중복 렌더링되지만 한 번에 매칭되므로 카테고리당 결과는 하나만 나온다).
async function fetchCategoryBreakdown(page, href, dateParam = 'lastmonth') {
  const url = `${BASE}${href}/categories?date=${dateParam}`;
  await gotoSoftc(page, url);
  await page.waitForTimeout(1000);
  await waitOutCheckpoint(page, 'categories');
  await page.waitForTimeout(1500);

  const rows = await page.$$eval('a', (as) => {
    const results = [];
    const re =
      /카테고리(.+?)방송시간([\d.]+)\s*h6분\s*최고채팅(\d+)6분\s*평균채팅(\d+)최고시청자([\d,]+)평균시청자([\d,]+)뷰어십([\d,]+)/;
    for (const a of as) {
      const m = (a.textContent || '').match(re);
      if (!m) continue;
      results.push({
        category: m[1].trim(),
        broadcastHours: Number(m[2]),
        maxViewers: Number(m[5].replace(/,/g, '')),
        avgViewers: Number(m[6].replace(/,/g, '')),
      });
    }
    return results;
  });

  const seen = new Map();
  for (const r of rows) if (!seen.has(r.category)) seen.set(r.category, r);
  return [...seen.values()];
}

module.exports = { searchChannel, fetchMonthlyStats, fetchCategoryBreakdown, lastMonthYearMonth };

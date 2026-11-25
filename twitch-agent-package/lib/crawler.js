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
      `[${context}] Vercel 보안 체크포인트에 막혔습니다. Chrome 디버그 프로필(${require('./browser').PROFILE_DIR})에서 ` +
        `직접 로그인 세션을 다시 확인해주세요.`
    );
  }
}

async function searchChannel(page, streamerName) {
  const url = `${BASE}/search?q=${encodeURIComponent(streamerName)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const html = await page.content();
  assertNotCheckpoint(html, 'search');

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
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1000);
  const html = await page.content();
  assertNotCheckpoint(html, 'stats');

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

module.exports = { searchChannel, fetchMonthlyStats, lastMonthYearMonth };

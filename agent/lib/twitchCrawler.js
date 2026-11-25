const BASE = 'https://twitchtracker.com';

// tbody row td order: [date, avgViewers, gain, %gain, peakViewers, hoursStreamed, gain, %gain, followersTotal, followerGain, %gain, perHour]
const COL = {
  date: 0,
  avgViewers: 1,
  peakViewers: 4,
  hoursStreamed: 5,
  followerGain: 9,
};

function isChallengeTitle(title) {
  return title.includes('기다리십시오') || title.includes('Just a moment');
}

async function waitForChallenge(page) {
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1500);
    if (!isChallengeTitle(await page.title())) {
      // 챌린지 통과 직후 페이지가 한 번 더 리다이렉트/리로드되는 경우가 있어,
      // 로드가 완전히 안정될 때까지 한 박자 더 기다린다.
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }
  throw new Error('Cloudflare 확인 페이지를 통과하지 못했습니다. 잠시 후 다시 시도해주세요.');
}

// 챌린지 통과 후 리다이렉트가 늦게 걸리면 DOM 쿼리 중 "Execution context was
// destroyed" 가 날 수 있어, 그 경우 한 번 더 재시도한다.
async function withNavRetry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries || !/[Ee]xecution context was destroyed/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function lastMonthYearMonth() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function channelUrl(twitchLogin) {
  return `${BASE}/${twitchLogin}/statistics`;
}

// yearMonth: 'YYYY-MM' (기본: 지난달)
async function fetchMonthlyStats(page, twitchLogin, yearMonth) {
  const targetYearMonth = yearMonth || lastMonthYearMonth();
  const url = channelUrl(twitchLogin);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForChallenge(page);

  if ((await page.title()).toLowerCase().includes('not found')) {
    throw new Error(`twitchtracker에서 "${twitchLogin}" 채널을 찾을 수 없습니다. 핸들을 확인해주세요.`);
  }

  await withNavRetry(async () => {
    const sbm = await page.$('#sbm');
    if (!sbm) throw new Error(`통계를 찾을 수 없습니다. 페이지 구조가 바뀌었을 수 있습니다. (url: ${url})`);
    await sbm.scrollIntoViewIfNeeded();
  });

  let rows = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    rows = await withNavRetry(() =>
      page.$$eval('#sbm tbody tr', (trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => td.getAttribute('data-order')))
      )
    );
    if (rows.length > 0) break;
  }
  if (rows.length === 0) {
    throw new Error(`월별 통계 표를 불러오지 못했습니다. (url: ${url})`);
  }

  const targetDate = `${targetYearMonth}-01`;
  const row = rows.find((r) => r[COL.date] === targetDate);
  if (!row) {
    throw new Error(`${targetYearMonth} 기록이 없습니다 (해당 월에 방송 이력이 없을 수 있습니다).`);
  }

  return {
    broadcastHours: row[COL.hoursStreamed] !== null ? Number(row[COL.hoursStreamed]) : null,
    avgViewers: row[COL.avgViewers] !== null ? Number(row[COL.avgViewers]) : null,
    maxViewers: row[COL.peakViewers] !== null ? Number(row[COL.peakViewers]) : null,
    followerGain: row[COL.followerGain] !== null ? Number(row[COL.followerGain]) : null,
    sourceUrl: url,
  };
}

// twitchtracker의 "Played Games" 목록에서 정확히 이 이름과 일치하는 게임의 카테고리
// ID(들)를 찾는다. Twitch 쪽 카테고리 개편으로 같은 이름이 여러 ID로 남아있는 경우가
// 있어(예: 리브랜딩 전/후), 이름이 일치하는 ID를 전부 모아서 합산한다.
const TARGET_GAME_NAME = 'eternal return';

async function findGameIds(page, twitchLogin) {
  const url = `${BASE}/${twitchLogin}/games`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForChallenge(page);

  if ((await page.title()).toLowerCase().includes('not found')) {
    throw new Error(`twitchtracker에서 "${twitchLogin}" 채널을 찾을 수 없습니다. 핸들을 확인해주세요.`);
  }

  const links = await withNavRetry(() =>
    page.$$eval('a[href*="/games/"]', (els) =>
      els.map((e) => ({ href: e.getAttribute('href'), text: e.textContent.trim() }))
    )
  );
  const ids = links
    .filter((l) => l.text.trim().toLowerCase() === TARGET_GAME_NAME)
    .map((l) => (l.href.match(/\/games\/(\d+)/) || [])[1])
    .filter(Boolean);
  return [...new Set(ids)];
}

function parseSpanNumber(html) {
  if (!html) return null;
  const m = String(html).match(/<span[^>]*>(-?[\d,]+)<\/span>/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// 채널의 특정 게임 카테고리 방송 목록(/{login}/games/{gameId})은 DataTables로 렌더링되며,
// 전체 스트림 데이터가 이미 클라이언트에 로드되어 있다(페이지네이션은 화면 표시만 나눔).
// 그래서 페이지를 넘기지 않고 DataTables API로 전체 rows를 한 번에 가져온다.
async function fetchGameStreamRows(page, twitchLogin, gameId) {
  const url = `${BASE}/${twitchLogin}/games/${gameId}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForChallenge(page);

  await withNavRetry(async () => {
    const table = await page.$('#streams');
    if (!table) throw new Error(`스트림 목록을 찾을 수 없습니다. 페이지 구조가 바뀌었을 수 있습니다. (url: ${url})`);
  });

  let raw = null;
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    raw = await withNavRetry(() =>
      page.evaluate(() => {
        if (!window.jQuery || !window.jQuery.fn.DataTable || !window.jQuery.fn.DataTable.isDataTable('#streams')) {
          return null;
        }
        return window.jQuery('#streams').DataTable().rows().data().toArray();
      })
    );
    if (raw && raw.length > 0) break;
  }
  if (!raw) {
    throw new Error(`스트림 목록 표를 불러오지 못했습니다. (url: ${url})`);
  }

  return raw
    .map((r) => {
      const dateOrder = r[0] && r[0]['@data-order'];
      const durationMin = r[1] && Number(r[1]['@data-order']);
      return {
        date: dateOrder ? dateOrder.slice(0, 10) : null,
        durationMin: Number.isFinite(durationMin) ? durationMin : 0,
        avgViewers: parseSpanNumber(r[2]),
        maxViewers: parseSpanNumber(r[3]),
        followerGain: parseSpanNumber(r[4]),
      };
    })
    .filter((r) => r.date);
}

// yearMonth: 'YYYY-MM' (기본: 지난달). 방송 시간/시청자 지표는 Eternal Return 카테고리로
// 방송한 스트림만 모아서 집계한다. 팔로워 증감만은 채널 전체 기준(월별 통계 페이지)을
// 그대로 쓰는데, 팔로우는 "어떤 게임을 보고 눌렀는지"로 나눌 수 있는 지표가 아니기 때문이다.
async function fetchMonthlyGameStats(page, twitchLogin, yearMonth) {
  const targetYearMonth = yearMonth || lastMonthYearMonth();

  let overallFollowerGain = null;
  try {
    overallFollowerGain = (await fetchMonthlyStats(page, twitchLogin, targetYearMonth)).followerGain;
  } catch (err) {
    // 지난달에 방송을 아예 안 했으면 월별 통계 표에 해당 월 자체가 없을 수 있다 — null 유지.
  }

  const gameIds = await findGameIds(page, twitchLogin);
  const base = {
    broadcastHours: 0,
    avgViewers: null,
    maxViewers: null,
    followerGain: overallFollowerGain,
    streamCount: 0,
    sourceUrl: `${BASE}/${twitchLogin}/games`,
  };
  if (gameIds.length === 0) return base;

  let streams = [];
  for (const gameId of gameIds) {
    streams = streams.concat(await fetchGameStreamRows(page, twitchLogin, gameId));
  }
  const filtered = streams.filter((s) => s.date.slice(0, 7) === targetYearMonth);
  if (filtered.length === 0) return { ...base, sourceUrl: `${BASE}/${twitchLogin}/games/${gameIds[0]}` };

  const totalMin = filtered.reduce((sum, r) => sum + r.durationMin, 0);
  const weightedAvgSum = filtered.reduce((sum, r) => sum + (r.avgViewers || 0) * r.durationMin, 0);

  return {
    broadcastHours: Math.round((totalMin / 60) * 10) / 10,
    avgViewers: totalMin > 0 ? Math.round(weightedAvgSum / totalMin) : null,
    maxViewers: Math.max(...filtered.map((r) => r.maxViewers || 0)),
    followerGain: overallFollowerGain,
    streamCount: filtered.length,
    sourceUrl: `${BASE}/${twitchLogin}/games/${gameIds[0]}`,
  };
}

module.exports = { fetchMonthlyStats, fetchMonthlyGameStats, lastMonthYearMonth, channelUrl };

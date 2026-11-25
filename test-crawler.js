const { ensureBrowser, getSoftcPage } = require('./lib/browser');
const { searchChannel, fetchMonthlyStats, lastMonthYearMonth } = require('./lib/crawler');

const name = process.argv[2] || '네브짱';

(async () => {
  const browser = await ensureBrowser();
  const page = await getSoftcPage(browser);

  const found = await searchChannel(page, name);
  console.log('FOUND CHANNEL:', found.platform, found.channelId, '|', found.matchedText);

  const stats = await fetchMonthlyStats(page, found.href, 'lastmonth');
  console.log('YEAR_MONTH (lastmonth):', lastMonthYearMonth());
  console.log('STATS:', stats);

  await browser.close();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});

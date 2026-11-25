const { chromium } = require('playwright');
const fs = require('fs');

const QUERY = process.argv[2] || '네브짱';

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => p.url().includes('softc.one'));

  const url = `https://viewership.softc.one/search?q=${encodeURIComponent(QUERY)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  await page.screenshot({ path: 'search-results.png', fullPage: true });
  const html = await page.content();
  fs.writeFileSync('search-results.html', html);

  const links = await page.$$eval('a[href*="/channel/"]', (els) =>
    els.map((e) => ({ href: e.getAttribute('href'), text: e.textContent.trim() }))
  );
  fs.writeFileSync('search-result-links.json', JSON.stringify(links, null, 2));
  console.log('LINKS:', JSON.stringify(links, null, 2));

  await browser.close();
})().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});

const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = pages.find((p) => p.url().includes('softc.one')) || pages[0];
  const url = page.url();
  console.log('PAGE:', url);

  const captured = [];
  page.on('response', async (res) => {
    const req = res.request();
    const reqUrl = req.url();
    if (!reqUrl.includes('softc.one')) return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    let body = null;
    try {
      body = await res.text();
    } catch (e) {
      body = `<error reading body: ${e.message}>`;
    }
    captured.push({
      method: req.method(),
      url: reqUrl,
      requestHeaders: req.headers(),
      status: res.status(),
      bodyPreview: body ? body.slice(0, 3000) : null,
    });
  });

  console.log('Reloading page to capture data-fetch requests...');
  await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  fs.writeFileSync('captured-network.json', JSON.stringify(captured, null, 2));
  console.log('CAPTURED', captured.length, 'JSON responses. Saved to captured-network.json');
  captured.forEach((c, i) => console.log(i, c.method, c.url, c.status));

  await browser.close();
})().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});

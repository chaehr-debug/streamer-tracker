const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  console.log('CONTEXTS:', contexts.length);
  const context = contexts[0];
  const pages = context.pages();
  console.log('PAGES:', pages.length, pages.map((p) => p.url()));

  const page = pages.find((p) => p.url().includes('softc.one')) || pages[0];
  console.log('USING PAGE:', page.url());

  await page.screenshot({ path: 'connected-current-state.png', fullPage: true });
  const html = await page.content();
  fs.writeFileSync('connected-current-state.html', html);

  const inputs = await page.$$eval('input', (els) =>
    els.map((e) => ({
      type: e.type,
      name: e.name,
      id: e.id,
      placeholder: e.placeholder,
      value: e.value,
    }))
  );
  fs.writeFileSync('connected-inputs.json', JSON.stringify(inputs, null, 2));
  console.log('INPUTS:', JSON.stringify(inputs, null, 2));

  await browser.close();
})().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});

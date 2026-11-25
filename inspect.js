const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));
  try {
    const resp = await page.goto('https://viewership.softc.one/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    console.log('STATUS:', resp.status());
    console.log('URL AFTER LOAD:', page.url());
    await page.waitForTimeout(10000);
    console.log('URL AFTER WAIT:', page.url());
    console.log('TITLE:', await page.title());
    await page.screenshot({ path: 'inspect-initial.png', fullPage: true });

    const html = await page.content();
    require('fs').writeFileSync('inspect-initial.html', html);

    const inputs = await page.$$eval('input', (els) =>
      els.map((e) => ({
        type: e.type,
        name: e.name,
        id: e.id,
        placeholder: e.placeholder,
      }))
    );
    console.log('INPUTS:', JSON.stringify(inputs, null, 2));

    const buttons = await page.$$eval('button, input[type=submit]', (els) =>
      els.map((e) => ({ text: e.textContent && e.textContent.trim(), id: e.id }))
    );
    console.log('BUTTONS:', JSON.stringify(buttons, null, 2));

    const forms = await page.$$eval('form', (els) =>
      els.map((e) => ({ action: e.action, method: e.method, id: e.id }))
    );
    console.log('FORMS:', JSON.stringify(forms, null, 2));
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    await browser.close();
  }
})();

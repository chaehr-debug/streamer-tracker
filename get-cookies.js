const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const context = browser.contexts()[0];
  const cookies = await context.cookies('https://viewership.softc.one');
  fs.writeFileSync('auth-cookies.json', JSON.stringify(cookies, null, 2));
  console.log('Saved', cookies.length, 'cookies to auth-cookies.json');
  console.log('Cookie names:', cookies.map((c) => c.name).join(', '));
  await browser.close();
})().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});

const { ensureBrowser, getSoftcPage } = require('./browser');

let browserPromise = null;
let pagePromise = null;
let queue = Promise.resolve();

async function getPage() {
  if (!browserPromise) browserPromise = ensureBrowser();
  const browser = await browserPromise;
  if (!pagePromise) pagePromise = getSoftcPage(browser);
  return pagePromise;
}

function runExclusive(fn) {
  const result = queue.then(async () => {
    const page = await getPage();
    return fn(page);
  });
  queue = result.then(
    () => {},
    () => {}
  );
  return result;
}

module.exports = { runExclusive };

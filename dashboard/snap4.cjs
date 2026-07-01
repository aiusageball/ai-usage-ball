const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));
  
  // Click settings button
  await page.click('.settings-icon-btn');
  await new Promise(r => setTimeout(r, 1000));
  
  await page.screenshot({ path: '/tmp/settings.png' });
  
  await browser.close();
  process.exit(0);
})();

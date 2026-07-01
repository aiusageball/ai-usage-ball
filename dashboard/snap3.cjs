const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));
  
  const element = await page.$('.spheres-grid > .orb-wrapper:nth-child(1) > .orb-glass-breather');
  const box = await element.boundingBox();
  console.log("Bounding box:", box);
  
  await element.screenshot({ 
    path: '/tmp/claude_orb_perfect.png', 
    omitBackground: true
  });
  
  await browser.close();
})();

const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));
  
  await page.evaluate(() => {
    document.querySelectorAll('.orb-label-container').forEach(e => e.style.display = 'none');
  });
  
  const element = await page.$('.spheres-grid > .orb-wrapper:nth-child(2)');
  const box = await element.boundingBox();
  
  // Create a square clip based on the width
  const size = Math.min(box.width, box.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  
  await page.screenshot({ 
    path: '/tmp/claude_orb_square.png', 
    omitBackground: true,
    clip: {
      x: cx - size / 2,
      y: cy - size / 2,
      width: size,
      height: size
    }
  });
  
  await browser.close();
})();

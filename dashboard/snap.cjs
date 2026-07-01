const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  // Set viewport large enough
  await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 2 });
  
  // Wait for the app to load
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });
  
  // Wait for the video to load a frame
  await new Promise(r => setTimeout(r, 4000));
  
  // Hide the labels
  await page.evaluate(() => {
    document.querySelectorAll('.orb-label-container').forEach(e => e.style.display = 'none');
  });
  
  // Get the Claude orb wrapper (it's the second one in the grid)
  const element = await page.$('.spheres-grid > .orb-wrapper:nth-child(2)');
  
  // Take screenshot with transparent background
  await element.screenshot({ path: '/tmp/claude_orb.png', omitBackground: true });
  
  await browser.close();
})();

const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto('http://localhost:1420');
  await page.waitForSelector('.popover-header-section');
  
  const header = await page.$('.popover-header-section');
  const titleGroup = await page.$('.popover-title-group');
  
  const headerBox = await header.boundingBox();
  const titleBox = await titleGroup.boundingBox();
  
  console.log("Header Box:", headerBox);
  console.log("Title Box:", titleBox);
  
  await browser.close();
})();

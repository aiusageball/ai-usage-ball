import puppeteer from 'puppeteer';
import { execSync } from 'child_process';
import fs from 'fs';

(async () => {
  // Check if Vite is running, if not start it
  try {
    execSync('curl -s http://localhost:5173');
  } catch (e) {
    console.log('Vite not running, starting it...');
    execSync('npm run dev &', { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 3000));
  }

  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 860, height: 580, deviceScaleFactor: 2 });
  
  await page.goto('http://localhost:5173');
  
  // Wait for settings icon and click it
  await page.waitForSelector('.settings-icon-btn');
  await page.click('.settings-icon-btn');
  await page.waitForSelector('.settings-modal-content');
  
  // 1. Take Free state screenshot
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'screenshot-1-free.png' });
  console.log('Saved screenshot-1-free.png');
  
  // 2. Click Plus Buy button to open checkout modal
  await page.click('.upgrade-card.plus');
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'screenshot-2-checkout.png' });
  console.log('Saved screenshot-2-checkout.png');
  
  // 3. Click "Pay with Apple Pay" in the mock modal
  // The button has text "Pay with Apple Pay"
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await page.evaluate(el => el.textContent, btn);
    if (text === 'Pay with Apple Pay') {
      await btn.click();
      break;
    }
  }
  
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'screenshot-3-plus-state.png' });
  console.log('Saved screenshot-3-plus-state.png');
  
  // 4. Upgrade to Pro
  // Click "Pro Buy"
  await page.click('.upgrade-card.pro');
  await new Promise(r => setTimeout(r, 500));
  
  // Click pay again
  const buttons2 = await page.$$('button');
  for (const btn of buttons2) {
    const text = await page.evaluate(el => el.textContent, btn);
    if (text === 'Pay with Apple Pay') {
      await btn.click();
      break;
    }
  }
  
  await new Promise(r => setTimeout(r, 1000));
  await page.screenshot({ path: 'screenshot-4-pro-state.png' });
  console.log('Saved screenshot-4-pro-state.png');
  
  await browser.close();
  
  // Clear local storage for next time
  // (We do this by just leaving it, it's fine)
})();

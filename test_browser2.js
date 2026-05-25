const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  
  try {
    await page.goto('http://127.0.0.1:8765/profile.html', { waitUntil: 'networkidle0', timeout: 15000 });
  } catch(e) {
    console.log('Navigation warning:', e.message);
  }
  
  await new Promise(r => setTimeout(r, 3000));
  
  const rewardInfo = await page.evaluate(() => {
    const grid = document.getElementById('pf-cosmetics-grid');
    const activeSection = document.getElementById('pf-reward-active');
    const formSection = document.getElementById('pf-reward-form');
    const nameEl = document.getElementById('profile-title-name');
    
    return {
      gridExists: !!grid,
      gridHTML: grid ? grid.innerHTML.substring(0, 500) : 'not found',
      activeDisplay: activeSection ? activeSection.style.display : 'not found',
      formDisplay: formSection ? formSection.style.display : 'not found',
      titleName: nameEl?.textContent,
      titleClasses: nameEl?.className,
      computedStyle: nameEl ? {
        color: getComputedStyle(nameEl).color,
        webkitTextFillColor: getComputedStyle(nameEl).webkitTextFillColor,
        background: getComputedStyle(nameEl).background?.substring(0, 200),
        backgroundClip: getComputedStyle(nameEl).backgroundClip,
      } : 'no name element',
    };
  });
  
  console.log('Reward info:', JSON.stringify(rewardInfo, null, 2));
  
  await page.screenshot({ path: '/home/z/my-project/download/profile_check.png', fullPage: true });
  console.log('Screenshot saved');
  
  await browser.close();
})();

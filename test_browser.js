const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  
  // Go to profile page
  await page.goto('http://localhost:8765/profile.html', { waitUntil: 'networkidle0', timeout: 15000 });
  
  // Wait a bit for auth to load
  await new Promise(r => setTimeout(r, 3000));
  
  // Take screenshot
  await page.screenshot({ path: '/home/z/my-project/download/profile_check.png', fullPage: true });
  
  // Check the console for any reward data
  const rewardInfo = await page.evaluate(() => {
    // Check if the cosmetics grid exists
    const grid = document.getElementById('pf-cosmetics-grid');
    const activeSection = document.getElementById('pf-reward-active');
    const formSection = document.getElementById('pf-reward-form');
    
    return {
      gridExists: !!grid,
      gridHTML: grid ? grid.innerHTML : 'not found',
      activeDisplay: activeSection ? activeSection.style.display : 'not found',
      formDisplay: formSection ? formSection.style.display : 'not found',
      titleName: document.getElementById('profile-title-name')?.textContent,
      titleClasses: document.getElementById('profile-title-name')?.className,
    };
  });
  
  console.log('Reward info:', JSON.stringify(rewardInfo, null, 2));
  
  await browser.close();
})();

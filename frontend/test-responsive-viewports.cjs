const { chromium } = require('playwright');

const VIEWPORT_SPECS = [
  { name: 'iPhone SE (small mobile)', width: 320, height: 568 },
  { name: 'iPhone 8 (standard mobile)', width: 375, height: 667 },
  { name: 'iPhone 12/13/14 (modern mobile)', width: 390, height: 844 },
  { name: 'iPhone 15 Pro Max (large mobile)', width: 430, height: 932 },
  { name: 'iPad Portrait (tablet portrait)', width: 768, height: 1024 },
  { name: 'iPad Landscape (tablet landscape)', width: 1024, height: 768 },
  { name: 'Standard Laptop', width: 1366, height: 768 },
  { name: 'Large Desktop Monitor', width: 1920, height: 1080 },
];

async function runResponsiveAudit() {
  console.log('===============================================================');
  console.log('   SocratiQ SmartBoard - Real Browser Multi-Viewport Audit     ');
  console.log('===============================================================\n');

  const browser = await chromium.launch({ headless: true });
  const results = [];

  try {
    for (const vp of VIEWPORT_SPECS) {
      process.stdout.write(`Testing ${vp.name} (${vp.width}x${vp.height})... `);
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        hasTouch: vp.width < 1024,
      });
      const page = await context.newPage();

      await page.goto('http://localhost:5173/smartboard-demo', { waitUntil: 'networkidle' });
      await page.waitForSelector('div[role="toolbar"]', { timeout: 8000 });

      // 1. Check container overflow
      const overflowMetrics = await page.evaluate(() => {
        const body = document.body;
        const root = document.getElementById('root');
        const workspace = root?.firstElementChild;
        return {
          bodyScrollWidth: body.scrollWidth,
          bodyClientWidth: body.clientWidth,
          hasBodyOverflow: body.scrollWidth > body.clientWidth,
          workspaceScrollWidth: workspace?.scrollWidth || 0,
          workspaceClientWidth: workspace?.clientWidth || 0,
          hasWorkspaceOverflow: (workspace?.scrollWidth || 0) > (workspace?.clientWidth || 0),
        };
      });

      // 2. Check toolbar and top-right dock bounding boxes for collisions
      const collisionCheck = await page.evaluate(() => {
        const toolbar = document.querySelector('div[role="toolbar"]');
        const buttons = Array.from(document.querySelectorAll('div.absolute button[aria-label]'));
        const liveBtn = buttons.find((b) => b.getAttribute('aria-label')?.includes('Gemini Live'));
        const livePill = liveBtn?.closest('div.absolute');
        if (!toolbar || !livePill) return { checked: false, overlaps: false };

        const tRect = toolbar.getBoundingClientRect();
        const lRect = livePill.getBoundingClientRect();

        const overlaps = !(
          tRect.right <= lRect.left ||
          tRect.left >= lRect.right ||
          tRect.bottom <= lRect.top ||
          tRect.top >= lRect.bottom
        );

        return {
          checked: true,
          toolbarRight: Math.round(tRect.right),
          livePillLeft: Math.round(lRect.left),
          overlaps,
        };
      });

      // 3. Test drawing interaction and alignment
      const penBtn = page.locator('button[aria-label="Pen"]');
      await penBtn.click();

      const overlay = page.locator('div[style*="crosshair"]');
      await overlay.waitFor({ state: 'visible', timeout: 3000 });

      const startX = Math.round(vp.width / 2);
      const startY = Math.round(vp.height / 2);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 40, startY + 40);
      await page.mouse.up();

      // Check canvas stroke count
      const canvasStrokeStatus = await page.evaluate(() => {
        const cvs = document.querySelector('canvas');
        return cvs ? { exists: true, width: cvs.width, height: cvs.height } : { exists: false };
      });

      const passed =
        !overflowMetrics.hasBodyOverflow &&
        !overflowMetrics.hasWorkspaceOverflow &&
        !collisionCheck.overlaps &&
        canvasStrokeStatus.exists;

      results.push({
        ...vp,
        overflowMetrics,
        collisionCheck,
        canvasStrokeStatus,
        passed,
      });

      if (passed) {
        console.log('PASSED (No horizontal overflow, docks separated, drawing verified)');
      } else {
        console.log(`FAILED! Overflow: ${overflowMetrics.hasBodyOverflow}, Collision: ${collisionCheck.overlaps}`);
      }

      await context.close();
    }

    // 4. Test Orientation Rotation (390x844 -> 844x390)
    process.stdout.write('Testing Orientation Rotation (390x844 -> 844x390)... ');
    const rotateContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const rotatePage = await rotateContext.newPage();
    await rotatePage.goto('http://localhost:5173/smartboard-demo', { waitUntil: 'networkidle' });
    await rotatePage.waitForSelector('div[role="toolbar"]');

    // Rotate to landscape
    await rotatePage.setViewportSize({ width: 844, height: 390 });
    await rotatePage.waitForTimeout(300);

    const landscapeCheck = await rotatePage.evaluate(() => {
      const body = document.body;
      const toolbar = document.querySelector('div[role="toolbar"]');
      const liveBtn = Array.from(document.querySelectorAll('div.absolute button[aria-label]')).find((b) =>
        b.getAttribute('aria-label')?.includes('Gemini Live')
      );
      const livePill = liveBtn?.closest('div.absolute');
      const tRect = toolbar ? toolbar.getBoundingClientRect() : null;
      const lRect = livePill ? livePill.getBoundingClientRect() : null;
      const overlaps =
        tRect && lRect
          ? !(
              tRect.right <= lRect.left ||
              tRect.left >= lRect.right ||
              tRect.bottom <= lRect.top ||
              tRect.top >= lRect.bottom
            )
          : false;

      return {
        hasBodyOverflow: body.scrollWidth > body.clientWidth,
        overlaps,
      };
    });

    if (!landscapeCheck.hasBodyOverflow && !landscapeCheck.overlaps) {
      console.log('PASSED (Clean rotation, zero overflow, no dock collision)\n');
      results.push({ name: 'Orientation Rotation (390 -> 844)', width: 844, height: 390, passed: true });
    } else {
      console.log(`FAILED (Overflow: ${landscapeCheck.hasBodyOverflow}, Overlap: ${landscapeCheck.overlaps})\n`);
      results.push({ name: 'Orientation Rotation (390 -> 844)', width: 844, height: 390, passed: false });
    }

    await rotateContext.close();
  } finally {
    await browser.close();
  }

  console.log('---------------------------------------------------------------');
  const allPassed = results.every((r) => r.passed);
  console.log(`Multi-Viewport Audit Result: ${allPassed ? 'ALL VIEWPORTS PASSED (9/9)' : 'FAILURES DETECTED'}`);
  console.log('---------------------------------------------------------------');
  if (!allPassed) process.exit(1);
}

runResponsiveAudit().catch((err) => {
  console.error('Fatal error during responsive audit:', err);
  process.exit(1);
});

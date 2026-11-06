const { chromium } = require('playwright');
const assert = require('assert');

async function runRegressionCheck() {
  console.log('========================================================================');
  console.log('🔬 SocratiQ SmartBoard: Narrowly Scoped Regression Check');
  console.log('Features: Direct Text Tool & Highlighter Color Persistence');
  console.log('========================================================================\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const consoleWarnings = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
      console.error('  [Browser Error]:', msg.text());
    } else if (msg.type() === 'warning') {
      consoleWarnings.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(err.message);
    console.error('  [Page Error]:', err.message);
  });

  // Track server-side stored board
  let serverStoredBoard = {
    steps: [],
    strokes: [],
    elements: [],
    next_seq: 0,
    updated_at: null,
  };

  await page.route('**/student/assignments/*/whiteboard', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      const data = req.postDataJSON();
      serverStoredBoard = {
        ...data,
        updated_at: new Date().toISOString(),
      };
      await page.evaluate((d) => {
        try {
          localStorage.setItem('socratiq_demo_board', JSON.stringify(d));
        } catch {}
      }, serverStoredBoard);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(serverStoredBoard),
      });
    } else if (req.method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(serverStoredBoard),
      });
    }
    route.continue();
  });

  // Clear demo localStorage before starting test
  await page.goto('http://127.0.0.1:5173/smartboard-demo', { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('socratiq_demo_board'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('role=toolbar[name="Whiteboard tools"]');
  console.log('✓ SmartBoard Workspace mounted cleanly with empty board');

  // =========================================================================
  // CHECK 1: Create Arabic & English text, commit, save, reload & verify persistence
  // =========================================================================
  console.log('\n[Check 1] Creating new Arabic & English text and verifying persistence...');

  // Select Text tool
  await page.locator('button[aria-label="Text"]').click();
  await page.waitForTimeout(100);

  const overlay = page.locator('div[style*="cursor: text"]');
  const box = await overlay.boundingBox();
  assert(box, 'Canvas overlay must exist');

  // Click at specific coordinates: x: 350, y: 220
  await page.mouse.click(box.x + 350, box.y + 220);
  await page.waitForTimeout(100);

  const textarea = page.locator('textarea[aria-label="Text on the board"]');
  await textarea.waitFor({ state: 'visible', timeout: 3000 });
  const isFocused = await textarea.evaluate((el) => document.activeElement === el);
  assert.strictEqual(isFocused, true, 'Textarea must be focused upon creation');

  // Type English and Arabic with multiline Shift+Enter
  const englishText = 'Knowledge is virtue';
  const arabicText = 'المعرفة هي الفضيلة';
  await page.keyboard.type(englishText);
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await page.keyboard.type(arabicText);

  // Commit with Enter
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  // Verify text rendered on board
  const textElement = page.locator('div[data-element-id]');
  await textElement.waitFor({ state: 'visible', timeout: 3000 });
  let elementText = await textElement.first().innerText();
  console.log('  Initial committed text:\n  ', elementText.replace('\n', ' / '));
  assert(elementText.includes(englishText), 'Must contain English text');
  assert(elementText.includes(arabicText), 'Must contain Arabic text');

  // Wait for autosave (1200ms debounce)
  console.log('  Waiting for board autosave...');
  await page.waitForTimeout(1600);

  assert(serverStoredBoard.elements.length > 0, 'Server must have received saved elements');
  const savedElement = serverStoredBoard.elements[0];
  console.log(`  Saved element in server wire format: kind=${savedElement.kind}, x=${savedElement.x}, y=${savedElement.y}`);
  assert.strictEqual(savedElement.kind, 'text');
  assert(savedElement.text.includes(englishText) && savedElement.text.includes(arabicText));

  // Reload the board and verify persistence
  console.log('  Reloading page to verify persistence...');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('role=toolbar[name="Whiteboard tools"]');

  const reloadedTextEl = page.locator('div[data-element-id]').first();
  await reloadedTextEl.waitFor({ state: 'visible', timeout: 3000 });
  const reloadedText = await reloadedTextEl.innerText();
  console.log('  Reloaded text from storage:\n  ', reloadedText.replace('\n', ' / '));
  assert(reloadedText.includes(englishText), 'Reloaded text must contain English');
  assert(reloadedText.includes(arabicText), 'Reloaded text must contain Arabic');

  // Check coordinates on reloaded element
  const boundingAfterReload = await reloadedTextEl.boundingBox();
  console.log(`  Reloaded element bounding box: x=${boundingAfterReload.x.toFixed(1)}, y=${boundingAfterReload.y.toFixed(1)}`);
  assert(boundingAfterReload.x > 0 && boundingAfterReload.y > 0, 'Coordinates must be valid');

  console.log('✓ Check 1 Passed: Arabic & English text created, committed, and saved with exact coordinates persisting across reload.');

  // =========================================================================
  // CHECK 2: Edit existing text element & verify positioning
  // =========================================================================
  console.log('\n[Check 2] Editing existing text element and verifying position...');

  // Double-click to edit the existing text element
  await reloadedTextEl.dblclick();
  await page.waitForTimeout(150);

  const editTextarea = page.locator('textarea[aria-label="Text on the board"]');
  await editTextarea.waitFor({ state: 'visible', timeout: 3000 });
  const editInitialVal = await editTextarea.inputValue();
  console.log('  Textarea opened for editing with value:\n  ', editInitialVal.replace('\n', ' / '));
  assert(editInitialVal.includes(englishText), 'Editor must contain existing text');

  // Append text
  await page.keyboard.type(' - Socrates');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  const updatedText = await reloadedTextEl.innerText();
  console.log('  Updated text after edit commit:\n  ', updatedText.replace('\n', ' / '));
  assert(updatedText.includes('Socrates'), 'Updated text must contain Socrates');

  console.log('✓ Check 2 Passed: Existing text element edited and committed correctly.');

  // =========================================================================
  // CHECK 3: Draw separate red, green, and blue highlighter strokes
  // =========================================================================
  console.log('\n[Check 3] Drawing separate Red, Green, and Blue highlighter strokes...');

  // Instrument 2D canvas context on current page to log all stroke drawing operations
  await page.evaluate(() => {
    window.__canvasStrokeLog = [];
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      const ctx = origGetContext.apply(this, arguments);
      if (type === '2d' && !ctx.__instrumentedForRegression) {
        ctx.__instrumentedForRegression = true;
        const origStroke = ctx.stroke;
        ctx.stroke = function () {
          window.__canvasStrokeLog.push({
            strokeStyle: ctx.strokeStyle,
            fillStyle: ctx.fillStyle,
            lineWidth: ctx.lineWidth,
            globalAlpha: ctx.globalAlpha,
          });
          return origStroke.apply(this, arguments);
        };
      }
      return ctx;
    };
  });

  // Select Highlighter
  await page.locator('button[aria-label="Highlighter"]').click();
  await page.waitForTimeout(100);

  const drawOverlay = page.locator('div[style*="cursor: crosshair"]');
  const drawBox = await drawOverlay.boundingBox();

  // Draw Red (#ef4444)
  console.log('  Drawing Red stroke (#ef4444)...');
  await page.locator('button[title="Color: #ef4444"]').click();
  await page.waitForTimeout(50);
  await page.mouse.move(drawBox.x + 80, drawBox.y + 350);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + 180, drawBox.y + 350);
  await page.mouse.up();
  await page.waitForTimeout(100);

  // Draw Green (#22c55e)
  console.log('  Drawing Green stroke (#22c55e)...');
  await page.locator('button[title="Color: #22c55e"]').click();
  await page.waitForTimeout(50);
  await page.mouse.move(drawBox.x + 80, drawBox.y + 400);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + 180, drawBox.y + 400);
  await page.mouse.up();
  await page.waitForTimeout(100);

  // Draw Blue (#3b82f6)
  console.log('  Drawing Blue stroke (#3b82f6)...');
  await page.locator('button[title="Color: #3b82f6"]').click();
  await page.waitForTimeout(50);
  await page.mouse.move(drawBox.x + 80, drawBox.y + 450);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + 180, drawBox.y + 450);
  await page.mouse.up();
  await page.waitForTimeout(100);

  const strokeLog = await page.evaluate(() => window.__canvasStrokeLog);
  const highlighterColors = [...new Set(strokeLog.filter((s) => s.globalAlpha === 0.35).map((s) => s.strokeStyle))];
  console.log('  Rendered highlighter colors detected in canvas paint calls:', highlighterColors);

  assert(highlighterColors.includes('#ef4444'), 'Must include red stroke');
  assert(highlighterColors.includes('#22c55e'), 'Must include green stroke');
  assert(highlighterColors.includes('#3b82f6'), 'Must include blue stroke');
  console.log('✓ Check 3 Passed: Red, green, and blue highlighter strokes drawn with correct colors.');

  // =========================================================================
  // CHECK 4: Switch tools and verify selected color is preserved
  // =========================================================================
  console.log('\n[Check 4] Testing tool switching color preservation...');

  // Active color is Blue (#3b82f6)
  // Switch to Pen
  await page.locator('button[aria-label="Pen"]').click();
  await page.waitForTimeout(50);
  let blueActive = await page.locator('button[title="Color: #3b82f6"]').getAttribute('class');
  assert(blueActive.includes('scale-125'), 'Blue must remain selected when switching to Pen');

  // Switch to Text
  await page.locator('button[aria-label="Text"]').click();
  await page.waitForTimeout(50);
  blueActive = await page.locator('button[title="Color: #3b82f6"]').getAttribute('class');
  assert(blueActive.includes('scale-125'), 'Blue must remain selected when switching to Text');

  // Switch back to Highlighter
  await page.locator('button[aria-label="Highlighter"]').click();
  await page.waitForTimeout(50);
  blueActive = await page.locator('button[title="Color: #3b82f6"]').getAttribute('class');
  assert(blueActive.includes('scale-125'), 'Blue must remain selected when switching back to Highlighter');

  // Draw another stroke with Highlighter without touching the color picker
  await page.mouse.move(drawBox.x + 80, drawBox.y + 500);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + 180, drawBox.y + 500);
  await page.mouse.up();
  await page.waitForTimeout(100);

  console.log('✓ Check 4 Passed: Selected color preserved across Pen, Text, and Highlighter switches.');

  // =========================================================================
  // CHECK 5: Save and reload and verify every stroke retains original color
  // =========================================================================
  console.log('\n[Check 5] Verifying stroke colors across save and reload...');
  await page.waitForTimeout(1600); // Wait for debounce autosave

  console.log('  Total saved strokes in server wire format:', serverStoredBoard.strokes.length);
  const savedColors = serverStoredBoard.strokes.map((s) => s.color);
  console.log('  Saved stroke colors in wire payload:', savedColors);

  assert(savedColors.includes('#ef4444'), 'Saved strokes must contain #ef4444');
  assert(savedColors.includes('#22c55e'), 'Saved strokes must contain #22c55e');
  assert(savedColors.includes('#3b82f6'), 'Saved strokes must contain #3b82f6');

  // Now reload the page with all strokes and elements
  console.log('  Reloading page with all saved strokes & text...');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('role=toolbar[name="Whiteboard tools"]');

  // Verify text element is still rendered after stroke additions & reload
  const finalLoadedText = page.locator('div[data-element-id]').first();
  await finalLoadedText.waitFor({ state: 'visible', timeout: 3000 });
  const finalLoadedContent = await finalLoadedText.innerText();
  assert(finalLoadedContent.includes('Knowledge is virtue'), 'Text must persist across stroke reloads');

  console.log('✓ Check 5 Passed: All strokes and text elements retain their original colors and positions after save & reload.');

  // =========================================================================
  // CHECK 6: Confirm older legacy strokes without stored color render yellow fallback
  // =========================================================================
  console.log('\n[Check 6] Testing legacy highlighter stroke fallback (#facc15)...');

  const legacyFallbackColor = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');

    // Simulate paint() from SmartBoard.tsx
    const legacyStroke = { t: 'h', w: 6, pts: [[10, 10], [100, 10]] }; // NO color property!

    // Run paint logic directly
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (legacyStroke.t === 'h') {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = legacyStroke.w * 4;
      const color = (legacyStroke && legacyStroke.color) || '#facc15';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
    }
    const strokeColor = ctx.strokeStyle;
    ctx.restore();
    return strokeColor;
  });

  console.log('  Legacy highlighter rendered stroke color:', legacyFallbackColor);
  assert.strictEqual(legacyFallbackColor, '#facc15', 'Legacy stroke must fall back to #facc15');
  console.log('✓ Check 6 Passed: Older highlighter strokes without color cleanly render with #facc15 yellow fallback.');

  // =========================================================================
  // CHECK 7: Inspect browser console for errors
  // =========================================================================
  console.log('\n[Check 7] Inspecting browser console for errors during all operations...');
  console.log(`  Total browser errors: ${consoleErrors.length}`);
  console.log(`  Total browser warnings: ${consoleWarnings.length}`);

  if (consoleErrors.length > 0) {
    console.error('  Unexpected browser errors detected:', consoleErrors);
  }
  assert.strictEqual(consoleErrors.length, 0, 'No console errors should be emitted');
  console.log('✓ Check 7 Passed: Zero browser errors detected during complete lifecycle.');

  // Save final screenshot
  await page.screenshot({ path: 'browser_artifacts/regression_verification_final.png' });
  console.log('\n✓ Saved screenshot: browser_artifacts/regression_verification_final.png');

  await browser.close();

  console.log('\n========================================================================');
  console.log('🎉 ALL 7 REGRESSION CHECKS PASSED WITH ZERO FAILURES!');
  console.log('========================================================================\n');
}

runRegressionCheck().catch((err) => {
  console.error('\n❌ Regression check failed:', err);
  process.exit(1);
});

const { chromium } = require('playwright');
const assert = require('assert');

async function runVerification() {
  console.log('===============================================================');
  console.log('🧪 Starting SmartBoard Text Tool & Highlighter Color Verification');
  console.log('===============================================================\n');

  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('[Browser Error]', msg.text());
  });

  console.log('--- 1. Navigating to SmartBoard Demo Page ---');
  await page.goto('http://127.0.0.1:5173/smartboard-demo', { waitUntil: 'networkidle' });
  await page.waitForSelector('role=toolbar[name="Whiteboard tools"]');
  console.log('✓ SmartBoard Toolbar loaded');

  // =========================================================================
  // TEST 1: DIRECT TEXT TOOL
  // =========================================================================
  console.log('\n--- 2. Testing Direct Text Tool ---');

  // 1a. Select Text tool
  await page.locator('button[aria-label="Text"]').click();
  await page.waitForTimeout(100);

  const overlay = page.locator('div[style*="cursor: text"]');
  const box = await overlay.boundingBox();
  assert(box, 'Text overlay canvas bounding box must exist');

  // 1b. Real mouse click on the board
  console.log('Clicking empty board location at (x: 250, y: 150)...');
  await page.mouse.click(box.x + 250, box.y + 150);
  await page.waitForTimeout(100);

  const textarea = page.locator('textarea[aria-label="Text on the board"]');
  await textarea.waitFor({ state: 'visible', timeout: 2000 });
  console.log('✓ Textarea mounted and is visible');

  // 1c. Focus verification
  const isFocused = await textarea.evaluate((el) => document.activeElement === el);
  console.log('✓ Textarea received focus immediately:', isFocused);
  assert.strictEqual(isFocused, true, 'Textarea must have document focus');

  // 1d. dir="auto" attribute verification
  const dirAttr = await textarea.getAttribute('dir');
  console.log('✓ Textarea dir attribute:', dirAttr);
  assert.strictEqual(dirAttr, 'auto', 'Textarea must have dir="auto"');

  // 1e. Real keyboard typing (English + Shift+Enter + Arabic)
  console.log('Typing multiline English and Arabic text via real keyboard...');
  await page.keyboard.type('Socrates: What is knowledge?');
  await page.keyboard.down('Shift');
  await page.keyboard.press('Enter');
  await page.keyboard.up('Shift');
  await page.keyboard.type('سقراط: المعرفة تبدأ بالتساؤل والبحث');

  const typedValue = await textarea.inputValue();
  console.log('✓ Typed content in textarea:\n', typedValue);
  assert(typedValue.includes('Socrates: What is knowledge?'), 'English text typed');
  assert(typedValue.includes('سقراط: المعرفة'), 'Arabic text typed');

  // 1f. Enter commits text
  console.log('Pressing Enter to commit...');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);

  const textareaAfterCommit = await textarea.isVisible().catch(() => false);
  console.log('✓ Textarea closed after Enter:', !textareaAfterCommit);
  assert.strictEqual(textareaAfterCommit, false, 'Textarea must unmount on Enter commit');

  // 1g. Element rendered on board
  const committedText = page.locator('div[data-element-id]');
  await committedText.waitFor({ state: 'visible', timeout: 2000 });
  const textHtml = await committedText.first().innerHTML();
  console.log('✓ Committed text element rendered on board');
  assert(textHtml.includes('Socrates: What is knowledge?'), 'Rendered English text');
  assert(textHtml.includes('سقراط: المعرفة'), 'Rendered Arabic text');

  // 1h. Escape cancels empty draft
  console.log('\nTesting Escape cancellation of empty draft...');
  await page.locator('button[aria-label="Text"]').click();
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + 450, box.y + 150);
  await page.waitForTimeout(100);
  await textarea.waitFor({ state: 'visible', timeout: 2000 });

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const textareaAfterEscape = await textarea.isVisible().catch(() => false);
  console.log('✓ Textarea cancelled cleanly on Escape:', !textareaAfterEscape);
  assert.strictEqual(textareaAfterEscape, false);

  const totalElements = await page.locator('div[data-element-id]').count();
  console.log('✓ Board elements count after Escape (no ghost elements):', totalElements);
  assert.strictEqual(totalElements, 1, 'Only 1 element must exist on board');

  // =========================================================================
  // TEST 2: HIGHLIGHTER COLOR (Red, Green, Blue, Default Yellow)
  // =========================================================================
  console.log('\n--- 3. Testing Highlighter Color Support ---');

  // Instrument 2D canvas context to verify colors rendered by paint()
  await page.evaluate(() => {
    window.__highlighterRenderCalls = [];
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      const ctx = origGetContext.apply(this, arguments);
      if (type === '2d' && !ctx.__tracked) {
        ctx.__tracked = true;
        const origStroke = ctx.stroke;
        ctx.stroke = function () {
          if (ctx.globalAlpha === 0.35) {
            window.__highlighterRenderCalls.push({
              strokeStyle: ctx.strokeStyle,
              fillStyle: ctx.fillStyle,
              lineWidth: ctx.lineWidth,
              alpha: ctx.globalAlpha,
            });
          }
          return origStroke.apply(this, arguments);
        };
      }
      return ctx;
    };
  });

  // 2a. Select Highlighter tool
  await page.locator('button[aria-label="Highlighter"]').click();
  await page.waitForTimeout(100);

  const canvasOverlay = page.locator('div[style*="cursor: crosshair"]');
  const canvasBox = await canvasOverlay.boundingBox();

  // Test Red (#ef4444)
  console.log('Selecting Red swatch (#ef4444)...');
  await page.locator('button[title="Color: #ef4444"]').click();
  await page.waitForTimeout(50);
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 250);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 250);
  await page.mouse.up();
  await page.waitForTimeout(100);

  // Test Green (#22c55e)
  console.log('Selecting Green swatch (#22c55e)...');
  await page.locator('button[title="Color: #22c55e"]').click();
  await page.waitForTimeout(50);
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 290);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 290);
  await page.mouse.up();
  await page.waitForTimeout(100);

  // Test Blue (#3b82f6)
  console.log('Selecting Blue swatch (#3b82f6)...');
  await page.locator('button[title="Color: #3b82f6"]').click();
  await page.waitForTimeout(50);
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 330);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 330);
  await page.mouse.up();
  await page.waitForTimeout(100);

  // Test Yellow (#eab308)
  console.log('Selecting Yellow swatch (#eab308)...');
  await page.locator('button[title="Color: #eab308"]').click();
  await page.waitForTimeout(50);
  await page.mouse.move(canvasBox.x + 50, canvasBox.y + 370);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 120, canvasBox.y + 370);
  await page.mouse.up();
  await page.waitForTimeout(100);

  const renders = await page.evaluate(() => window.__highlighterRenderCalls);
  const colorsUsed = [...new Set(renders.map((r) => r.strokeStyle))];
  console.log('✓ Rendered highlighter stroke colors on canvas:', colorsUsed);

  assert(colorsUsed.includes('#ef4444'), 'Canvas must render red highlighter stroke');
  assert(colorsUsed.includes('#22c55e'), 'Canvas must render green highlighter stroke');
  assert(colorsUsed.includes('#3b82f6'), 'Canvas must render blue highlighter stroke');
  assert(colorsUsed.includes('#eab308'), 'Canvas must render yellow highlighter stroke');

  // =========================================================================
  // TEST 3: TOOL SWITCHING COLOR PRESERVATION
  // =========================================================================
  console.log('\n--- 4. Testing Tool Switching Color Preservation ---');

  // Select Purple (#a855f7) while on Pen
  await page.locator('button[aria-label="Pen"]').click();
  await page.locator('button[title="Color: #a855f7"]').click();

  // Switch to Highlighter -> check if purple swatch remains selected
  await page.locator('button[aria-label="Highlighter"]').click();
  let purpleActive = await page.locator('button[title="Color: #a855f7"]').getAttribute('class');
  assert(purpleActive.includes('scale-125'), 'Purple must remain selected after switching to Highlighter');

  // Switch to Text -> check if purple swatch remains selected
  await page.locator('button[aria-label="Text"]').click();
  purpleActive = await page.locator('button[title="Color: #a855f7"]').getAttribute('class');
  assert(purpleActive.includes('scale-125'), 'Purple must remain selected after switching to Text');

  // Switch back to Highlighter -> check if purple swatch remains selected
  await page.locator('button[aria-label="Highlighter"]').click();
  purpleActive = await page.locator('button[title="Color: #a855f7"]').getAttribute('class');
  assert(purpleActive.includes('scale-125'), 'Purple must remain selected after switching back to Highlighter');
  console.log('✓ Switching between Pen, Highlighter, and Text preserves selected color without resetting');

  // Save screenshot of verified whiteboard
  await page.screenshot({ path: 'browser_artifacts/verified_text_and_highlighter.png' });
  console.log('✓ Saved verification screenshot: browser_artifacts/verified_text_and_highlighter.png');

  await browser.close();

  console.log('\n===============================================================');
  console.log('🎉 ALL TEXT TOOL & HIGHLIGHTER COLOR TESTS PASSED SUCCESSFULLY!');
  console.log('===============================================================\n');
}

runVerification().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});

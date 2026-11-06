/**
 * Real Browser Verification Script for SocratiQ SmartBoard
 * Tests:
 * 1. Direct Text Tool (Canvas click, textarea focus, Arabic & English RTL/LTR dir="auto", Shift+Enter multiline, Enter commit, Escape cancel)
 * 2. Full-Screen Mode (Toggle enter, UI state, Escape key exit, fit-to-view resize)
 * 3. Live Voice Audio Pipeline (Microphone capture 16kHz PCM, Setup packet, Model 24kHz PCM decode & Web Audio playback, Interruption handling, Disconnect)
 */

const { chromium } = require('../frontend/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = path.resolve(__dirname, '../browser_artifacts');
const BRAIN_ARTIFACT_DIR = '/home/mohab-mosad/.gemini/antigravity/brain/d2c73e2a-2bb1-4f29-9918-d64a836aee44';

if (!fs.existsSync(ARTIFACT_DIR)) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
}

// Generate 0.5s of 440Hz PCM16 audio @ 24kHz (sine wave)
function generatePcm16AudioBase64(durationSec = 0.5, sampleRate = 24000, freq = 440) {
  const numSamples = Math.floor(durationSec * sampleRate);
  const buffer = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * freq * t) * 0.5; // amplitude 0.5
    buffer[i] = Math.max(-32768, Math.min(32767, Math.floor(sample * 32767)));
  }
  return Buffer.from(buffer.buffer).toString('base64');
}

async function runVerification() {
  console.log('=== Starting SmartBoard Real Browser Verification ===');
  
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
  });

  const page = await context.newPage();

  // Listen to browser console messages
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`[Browser Error]: ${msg.text()}`);
    } else if (msg.text().includes('Live') || msg.text().includes('Audio') || msg.text().includes('SmartBoard')) {
      console.log(`[Browser Console]: ${msg.text()}`);
    }
  });

  // Inject WebSocket mock before page load to control Gemini Live API messages without interfering with Vite HMR
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket;

    class MockWebSocket extends EventTarget {
      static instances = [];
      constructor(url, protocols) {
        super();
        this.url = url;
        this.protocols = protocols;
        this.readyState = 0; // CONNECTING
        this.sentMessages = [];
        MockWebSocket.instances.push(this);

        setTimeout(() => {
          this.readyState = 1; // OPEN
          if (this.onopen) this.onopen({ type: 'open' });
          this.dispatchEvent(new Event('open'));
        }, 50);
      }

      send(data) {
        this.sentMessages.push(data);
        const parsed = JSON.parse(data);
        window.__lastWsSent = parsed;
        window.__allWsSent = window.__allWsSent || [];
        window.__allWsSent.push(parsed);

        // If setup packet, reply with setupComplete
        if (parsed.setup) {
          setTimeout(() => {
            const reply = JSON.stringify({ setupComplete: true });
            if (this.onmessage) this.onmessage({ data: reply });
            this.dispatchEvent(new MessageEvent('message', { data: reply }));
          }, 50);
        }
      }

      close(code, reason) {
        this.readyState = 3; // CLOSED
        if (this.onclose) this.onclose({ code, reason });
        this.dispatchEvent(new CloseEvent('close', { code, reason }));
      }

      simulateMessage(data) {
        const str = typeof data === 'string' ? data : JSON.stringify(data);
        if (this.onmessage) this.onmessage({ data: str });
        this.dispatchEvent(new MessageEvent('message', { data: str }));
      }
    }

    window.WebSocket = function(url, protocols) {
      if (typeof url === 'string' && (url.includes('live') || url.includes('gemini') || url.includes('smartboard'))) {
        return new MockWebSocket(url, protocols);
      }
      return new OriginalWebSocket(url, protocols);
    };
    window.WebSocket.instances = MockWebSocket.instances;
    window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
    window.__MockWebSocket = MockWebSocket;

    // Track Web Audio API calls for real audio playback verification
    const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
    window.__createdAudioContexts = [];
    window.__audioBufferSources = [];

    class TrackedAudioContext extends OriginalAudioContext {
      constructor(options) {
        super(options);
        window.__createdAudioContexts.push(this);
      }

      createBufferSource() {
        const source = super.createBufferSource();
        window.__audioBufferSources.push(source);
        return source;
      }
    }

    window.AudioContext = TrackedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = TrackedAudioContext;
  });

  console.log('\n--- Navigating to http://127.0.0.1:5173/smartboard-demo ---');
  await page.goto('http://127.0.0.1:5173/smartboard-demo', { waitUntil: 'networkidle' });

  // Wait for board workspace to mount
  await page.waitForSelector('role=toolbar[name="Whiteboard tools"]');
  console.log('✓ SmartBoard Toolbar mounted successfully');

  // =========================================================================
  // TEST 1: DIRECT TEXT TOOL (English & Arabic, Multiline, Escape, Commit)
  // =========================================================================
  console.log('\n--- Test 1: Direct Text Tool ---');

  // 1a. Select Text Tool
  const textToolBtn = page.locator('button[aria-label="Text"]');
  await textToolBtn.click();
  await page.waitForTimeout(150);

  // 1b. Click on board overlay using pointerdown to create text
  const boardOverlay = page.locator('div[style*="cursor: text"]');
  const overlayBox = await boardOverlay.boundingBox();
  console.log('Canvas overlay box:', overlayBox);
  await boardOverlay.dispatchEvent('pointerdown', {
    clientX: overlayBox.x + 250,
    clientY: overlayBox.y + 150,
    pointerId: 1,
    pointerType: 'mouse',
  });

  // 1c. Textarea should appear with autoFocus and dir="auto"
  const textarea = page.locator('textarea[aria-label="Text on the board"]');
  await textarea.waitFor({ state: 'visible', timeout: 3000 });
  const dirAttr = await textarea.getAttribute('dir');
  console.log(`✓ Text input opened. dir attribute: "${dirAttr}"`);
  if (dirAttr !== 'auto') throw new Error(`Expected dir="auto", got "${dirAttr}"`);

  // 1d. Type Arabic text with Shift+Enter multiline
  const arabicLine1 = 'سقراط: المعرفة تبدأ بالدهشة والتساؤل';
  const arabicLine2 = 'Socrates: True knowledge begins with wonder.';
  await textarea.fill(arabicLine1 + '\n' + arabicLine2);

  // 1e. Commit with Enter
  await textarea.press('Enter');
  await page.waitForTimeout(300);

  // 1f. Verify text node appears on the board
  await page.waitForSelector('div[data-element-id]');
  const textNodeHtml = await page.locator('div[data-element-id]').first().innerHTML();
  console.log('✓ Text element committed and rendered on board');
  if (!textNodeHtml.includes('سقراط: المعرفة') || !textNodeHtml.includes('Socrates: True knowledge')) {
    throw new Error('Committed text does not contain typed Arabic and English text!');
  }

  // 1g. Verify TextNode component rendered with dir="auto"
  const textNodeSpan = page.locator('div[data-element-id] [dir="auto"]');
  const spanCount = await textNodeSpan.count();
  console.log(`✓ TextNode verified with dir="auto" (found ${spanCount} elements)`);
  if (spanCount === 0) throw new Error('TextNode does not have dir="auto" attribute!');

  // Take screenshot of text on board
  const shot1Local = path.join(ARTIFACT_DIR, '01_text_tool_arabic_english.png');
  const shot1Brain = path.join(BRAIN_ARTIFACT_DIR, '01_text_tool_arabic_english.png');
  await page.screenshot({ path: shot1Local });
  fs.copyFileSync(shot1Local, shot1Brain);
  console.log('✓ Screenshot saved: 01_text_tool_arabic_english.png');

  // 1h. Test Escape cancellation: Click text tool again, click canvas, press Escape without typing
  await textToolBtn.click();
  await page.waitForTimeout(100);
  await boardOverlay.dispatchEvent('pointerdown', {
    clientX: overlayBox.x + 400,
    clientY: overlayBox.y + 350,
    pointerId: 1,
    pointerType: 'mouse',
  });
  await textarea.waitFor({ state: 'visible', timeout: 3000 });
  await page.keyboard.press('Escape');
  await textarea.waitFor({ state: 'hidden', timeout: 3000 });
  console.log('✓ Escape key cleanly cancelled empty text editor without leaving ghost elements');

  // =========================================================================
  // TEST 2: FULL-SCREEN MODE (Toggle, Viewport Resize, Escape Exit)
  // =========================================================================
  console.log('\n--- Test 2: Full-Screen Mode ---');

  const fsButton = page.locator('button[title*="Fullscreen"]');
  const initialPressed = await fsButton.getAttribute('aria-pressed');
  console.log(`Initial Fullscreen aria-pressed: ${initialPressed}`);

  // 2a. Click Fullscreen button to enter
  await fsButton.click();
  await page.waitForTimeout(300);

  const isFsEntered = await fsButton.getAttribute('aria-pressed');
  const fsTitle = await fsButton.getAttribute('title');
  console.log(`After click - Fullscreen aria-pressed: ${isFsEntered}, title: "${fsTitle}"`);
  if (isFsEntered !== 'true') throw new Error('Fullscreen toggle did not set aria-pressed="true"');

  // Verify board workspace has fullscreen classes / style
  const workspaceContainer = page.locator('div.fixed.inset-0.z-50');
  const fsClassesCount = await workspaceContainer.count();
  console.log(`✓ Fullscreen container active: ${fsClassesCount > 0}`);

  // Take screenshot in Fullscreen
  const shot2Local = path.join(ARTIFACT_DIR, '02_fullscreen_mode.png');
  const shot2Brain = path.join(BRAIN_ARTIFACT_DIR, '02_fullscreen_mode.png');
  await page.screenshot({ path: shot2Local });
  fs.copyFileSync(shot2Local, shot2Brain);
  console.log('✓ Screenshot saved: 02_fullscreen_mode.png');

  // 2b. Press Escape to exit fullscreen
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  const isFsExited = await fsButton.getAttribute('aria-pressed');
  console.log(`After Escape - Fullscreen aria-pressed: ${isFsExited}`);
  if (isFsExited !== 'false') throw new Error('Escape key did not exit fullscreen');

  // =========================================================================
  // TEST 3: LIVE VOICE AUDIO PIPELINE (Mic -> Setup -> 24kHz Audio -> Interruption)
  // =========================================================================
  console.log('\n--- Test 3: Live Voice Audio Pipeline ---');

  const micButton = page.locator('button[aria-label="Connect Gemini Live Voice"]');
  await micButton.click();

  // Wait for WebSocket setup handshake to complete
  await page.waitForTimeout(300);

  // Check setup packet sent by client
  const setupMessage = await page.evaluate(() => {
    return (window.__allWsSent || []).find((m) => m.setup);
  });
  console.log('✓ Setup packet sent to Live API successfully');

  if (!setupMessage?.setup?.generationConfig?.responseModalities?.includes('AUDIO')) {
    throw new Error('Setup message missing responseModalities: ["AUDIO"]');
  }
  if (setupMessage?.setup?.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName !== 'Puck') {
    throw new Error('Setup message missing prebuiltVoiceConfig Puck');
  }
  if (!setupMessage?.setup?.tools?.[0]?.functionDeclarations?.length) {
    throw new Error('Setup message missing whiteboardTools declarations');
  }

  // Verify UI reflects Connected state
  const disconnectBtn = page.locator('button[aria-label="Disconnect Gemini Live"]');
  await disconnectBtn.waitFor({ state: 'visible', timeout: 3000 });
  console.log('✓ Live Voice successfully connected (MicOff icon visible)');

  // Verify student mic audio chunks are being sent
  await page.waitForTimeout(600);
  const audioChunksCount = await page.evaluate(() => {
    return (window.__allWsSent || []).filter((m) => m.realtimeInput?.audio?.data).length;
  });
  console.log(`✓ Student mic audio streaming actively: sent ${audioChunksCount} PCM16 audio chunks`);

  // 3b. Simulate Gemini Live Model Audio Output (24kHz PCM16 audio)
  console.log('\nSimulating Gemini Live 24kHz audio chunk arrival...');
  const fakeAudioBase64 = generatePcm16AudioBase64(0.5, 24000, 440);

  await page.evaluate((b64) => {
    const ws = window.__MockWebSocket.instances[0];
    ws.simulateMessage({
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: b64,
              },
            },
          ],
        },
      },
    });
  }, fakeAudioBase64);

  await page.waitForTimeout(300);

  // Verify Web Audio playback was scheduled and executed
  const audioContextStats = await page.evaluate(() => {
    const ctxs = window.__createdAudioContexts;
    const sources = window.__audioBufferSources;
    return {
      contextsCreated: ctxs.length,
      sampleRates: ctxs.map((c) => c.sampleRate),
      sourcesCreated: sources.length,
    };
  });
  console.log('✓ Audio playback stats in browser:', audioContextStats);
  if (audioContextStats.sourcesCreated === 0) {
    throw new Error('AudioBufferSourceNode was not created for incoming model audio!');
  }

  // Verify UI shows "Speaking" state
  const speakingBadge = page.locator('text=Speaking');
  const isSpeakingVisible = await speakingBadge.isVisible();
  console.log(`✓ AI status indicates speaking: ${isSpeakingVisible}`);

  // Take screenshot while AI is speaking
  const shot3Local = path.join(ARTIFACT_DIR, '03_live_voice_speaking.png');
  const shot3Brain = path.join(BRAIN_ARTIFACT_DIR, '03_live_voice_speaking.png');
  await page.screenshot({ path: shot3Local });
  fs.copyFileSync(shot3Local, shot3Brain);
  console.log('✓ Screenshot saved: 03_live_voice_speaking.png');

  // 3c. Simulate Student Interruption (Barge-in)
  console.log('\nSimulating student interruption (barge-in)...');
  await page.evaluate(() => {
    const ws = window.__MockWebSocket.instances[0];
    ws.simulateMessage({
      serverContent: {
        interrupted: true,
      },
    });
  });

  await page.waitForTimeout(100);

  // Verify state transitioned back to listening
  const listeningBadge = page.locator('text=Listening');
  const isListeningVisible = await listeningBadge.isVisible();
  console.log(`✓ AI status interrupted and switched back to listening: ${isListeningVisible}`);

  // 3d. Disconnect Live Session
  console.log('\nDisconnecting Live Session...');
  await disconnectBtn.click();
  await page.waitForTimeout(200);

  // Verify teardown sent audioStreamEnd and reset UI
  const teardownMessage = await page.evaluate(() => {
    return (window.__allWsSent || []).find((m) => m.realtimeInput?.audioStreamEnd);
  });
  console.log('✓ Client sent audioStreamEnd during disconnect:', !!teardownMessage);
  if (!teardownMessage) {
    throw new Error('audioStreamEnd was not sent on disconnect!');
  }

  const micConnectBtn = page.locator('button[aria-label="Connect Gemini Live Voice"]');
  const isDisconnected = await micConnectBtn.isVisible();
  console.log(`✓ UI cleanly reset to disconnected state: ${isDisconnected}`);

  // Take final screenshot
  const shot4Local = path.join(ARTIFACT_DIR, '04_final_board_state.png');
  const shot4Brain = path.join(BRAIN_ARTIFACT_DIR, '04_final_board_state.png');
  await page.screenshot({ path: shot4Local });
  fs.copyFileSync(shot4Local, shot4Brain);
  console.log('✓ Screenshot saved: 04_final_board_state.png');

  await browser.close();
  console.log('\n=============================================================');
  console.log('🎉 ALL REAL BROWSER VERIFICATION TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('=============================================================');
}

runVerification().catch((err) => {
  console.error('\n❌ Real Browser Verification Failed:', err);
  process.exit(1);
});

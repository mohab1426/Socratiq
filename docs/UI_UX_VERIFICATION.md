# UI/UX Verification

Everything below was actually run. Counts come from the commands and JSON in this repo. Passed, failed and blocked are stated separately. Final code state: branch `ui-ux-improvements`.

## 1. Commands and results

Run from `frontend/`:

| Command | Baseline (before changes) | Final |
|---|---|---|
| `npm ci` | 305 packages | (unchanged; no dependency added) |
| `npx tsc -b` | n/a | clean, no output |
| `npm run lint` | 39 warnings, 0 errors | **39 warnings, 0 errors** (two I introduced were removed) |
| `npx vitest run` | 240 passed, 16 files | **247 passed, 18 files** (+3 `routeTitles`, +4 `RichText`; no existing test edited) |
| `npm run build` | passed | **passed** (chunk-size advisory exists in the baseline too) |
| `node scripts/ui-audit/interactions.mjs` | n/a | **15/15 passed** (`docs/ui-ux-evidence/interactions-results.json`) |

## 2. Test environment and its limits

- Playwright's own browser download is blocked in the sandbox. A real **Chromium 153** was supplied by the `@sparticuz/chromium` npm package, installed **outside** the project, so no dependency was added. To reproduce elsewhere, run `npx playwright install chromium` and omit `CHROMIUM_PATH`/`CHROMIUM_ARGS`.
- Dev server: `vite` with a dummy local `VITE_SUPABASE_URL`, so the app starts signed-out. No real Supabase project, credentials or backend were available.
- **Public routes** ran against the real frontend. The university list on `/signup/student` and `/signup/teacher` gets a proxy 502 (no backend); that is an environment limit, not a regression.
- **Authenticated routes** ran with intercepted network responses (`scripts/ui-audit/mocks.mjs`). This verifies layout, responsive behaviour, empty/error states and accessibility of the UI only. **It is not evidence that the real Supabase or API integration works.** The `error` scenario deliberately injects HTTP 500s; those console errors are expected.
- **Blocked / not run:** real login, coach replies, file upload and download, grading, Live Voice and microphone. The browser's speech APIs were not exercised.

## 3. Viewport sweep (before vs after)

`scripts/ui-audit/sweep.mjs public` and `mocked`: 9 public routes and 26 authenticated route/scenario entries, each at **all seven** viewports: 320×720, 375×812, 430×932, 768×1024, 1024×768, 1366×768, 1920×1080. Total **245 combinations** per run (0 failed to load). Compare with `python3 scripts/ui-audit/compare.py ../docs/ui-ux-evidence/before ../docs/ui-ux-evidence/after`.

| Metric (sum over 245 combinations) | Before | After |
|---|---|---|
| Combinations with horizontal page overflow | 7 | **0** |
| Combinations with an element past the right edge (outside a scroller) | 5 | **0** |
| Controls with no accessible name | 91 | **0** |
| Pages with no `h1` (at 1366×768) | 3 | **0** |
| Distinct document titles | 1 | **24** |
| Controls smaller than 24×24 px | 604 | **35** |

The remaining 35 are all the same two in-sentence links ("Log in" on `/signup`, "Sign up" on `/login`), which WCAG 2.2 SC 2.5.8 exempts because they sit inside a sentence.

Console errors were left out of the table on purpose: the public baseline ran before I filtered the font-CDN DNS failure (the sandbox has no internet), so the "before" count is inflated and the comparison would be unfair. In the final run the only errors are the expected 502 (no backend) and the injected 500s.

Routes covered (mocked): student home (default, `empty`, `error`), join, courses, course, material, assignment ×2 (in progress, submitted), coach (default, `empty`), verification, settings; teacher dashboard (default, `empty`, `error`), student detail, courses, create course, course, new assignment, upload material, assignment, submission review, material, settings.

Pages additionally verified by looking at screenshots: landing 320, coach 375 (twice, before and after the Send fix), SmartBoard demo 375, teacher dashboard 1024 (three times). The harness does not detect content clipped by an `overflow:hidden` ancestor, so the other pages are verified by measurement only.

## 4. Keyboard and interaction checks (real browser, 15/15)

Closed phone drawer is `visibility:hidden`; 14 Tab presses never land in it. Opening it moves focus to Close and exposes `dialog` / `aria-modal`; 16 Tab presses and Shift+Tab stay inside; Escape closes it and returns focus to the menu button. On desktop the sidebar is visible and not a dialog. Coach tabs: Chat is selected initially, the Whiteboard tab is out of the tab order, ArrowRight selects Whiteboard and moves focus, ArrowLeft returns. The chat panel is a labelled, keyboard-scrollable `tabpanel` with a polite live region. Inline and pasted code render with no literal backticks. The Send button lies fully inside a 375px viewport. Titles change with the route.

One real defect was found by this script and fixed before the final run: focus did not move into the drawer on open (it is `visibility:hidden` on its first transition frame).

## 5. Regressions found and fixed during the work

- A line-based edit briefly put `inline-block py-1` on a table `<td>` instead of its link; caught from a sweep finding and the diff, corrected.
- `LearningJourney` was first reported fixed when it was not (my earlier probe ran signed-out and measured the login page, and the rewrite had silently not been written). Re-probed with the mock session after the real write: student assignment pages measure 0 overflow at 320px.

## 6. Known issues and limitations

- Not covered: Arabic/RTL UI layout, dark mode, real screen-reader output (NVDA/VoiceOver), error boundaries, destructive-action confirmations.
- No performance measurements were taken; none are claimed.
- Teacher Create course, New assignment, Upload material, Material detail and Settings were swept (no overflow, no unnamed controls) but not reviewed visually.
- "Ask Gemini…" copy left unchanged because tests assert it (see audit, Open).
- The Live Voice code, the SmartBoard viewport/placement algorithms and all backend code are unmodified.

# SocratiQ UI/UX Audit

Scope: the React frontend in `frontend/` (Vite, React 19, Tailwind v4, React Router). Backend, schema, auth, RAG/LLM logic and the SmartBoard Live Voice pipeline were out of scope and untouched.

## How this audit was done (and its limits)

- **Real browser:** Chromium 153 driven by Playwright, at the seven required viewports (320×720, 375×812, 430×932, 768×1024, 1024×768, 1366×768, 1920×1080). Harness: `frontend/scripts/ui-audit/`.
- **Public routes** were tested against the real app (with no backend: the `/signup/*` university list returns a proxy 502, which is an environment limit).
- **Authenticated routes were tested with intercepted network responses** (`scripts/ui-audit/mocks.mjs`: layout-only fixtures, including deliberately long names, plus `empty` and `error` scenarios). They prove layout, responsive behaviour and accessibility of the UI. **They do not prove the real Supabase or API integration works.** No real credentials or backend were available.
- The harness measures horizontal overflow, elements past the right edge, controls under 24×24 CSS px (WCAG 2.2 SC 2.5.8), controls without an accessible name, console/page errors, headings, landmarks and titles. **It cannot see content clipped by an `overflow:hidden` ancestor** (the clipped Send button below was found by looking at a screenshot). Screenshots were reviewed for the pages named in this report, not for every page.
- Contrast ratios were computed from the token values, not eyeballed.

Baseline (before any change): `npm run build` passed; lint 39 warnings / 0 errors; 240 tests in 16 files passed.

## Inventory

Public: `/` (landing), `/signup`, `/signup/student`, `/signup/teacher`, `/login`, `/login/forgot`, `/complete-profile`, `/smartboard-demo`, 404.
Student: home, join course, courses, course, material, assignment, AI coach (chat + whiteboard), verification, settings.
Teacher: dashboard, student detail, courses, create course, course, new assignment, upload material, assignment, submission review, material, settings.
Shared: `AppShell` (sidebar + header), `PublicHeader/Footer`, `PageIntro`, `Panel`, `MetricCard`, `Field/Input/Button/Badge/States` primitives, `LearningJourney`, `AttentionCenter`, `StudentsTable`, `RiskPanel`, `BoardWorkspace` / `SmartBoard` / `SmartBoardToolbar`.

The design system was already coherent (tokens in `src/index.css`, one palette, reduced-motion rule, shared primitives). The work was refinement and defect-fixing, not a redesign, to preserve the SocratiQ identity.

## Findings

Status: **Fixed** (verified as described in `UI_UX_VERIFICATION.md`), or **Open**.

### High

| # | Finding | Evidence | Status |
|---|---|---|---|
| H1 | AI Coach: the **Send button was clipped off-screen on phones** (375px). The text input is `flex-1` without `min-w-0`, so its default minimum width pushed the speaker and Send buttons out of the card. Enter still submitted, but the primary action was invisible. | `pages/student/AiCoach.tsx` composer; screenshot `before/mocked__student_courses_c1_assignments_a1_coach__375x812.png` | Fixed |
| H2 | Landing page overflowed by 43px at 320px; the primary **"Sign up" CTA was clipped**. Causes: header padding + logo + buttons, and the product-preview grid had an implicit auto track forced wide by its content. | `PublicHeader.tsx`, `ProductPreviews.tsx`; `before/public__home__320x720.png` | Fixed |
| H3 | Student assignment pages overflowed at 320px (35–44px). `LearningJourney` forced four cramped columns ("Learning verification" wider than its column). | `components/socratiq/LearningJourney.tsx` | Fixed (container-query: stacked below 28rem) |
| H4 | **Inputs had no accessible name** in Settings, Create course and New assignment: `<label>` without `htmlFor`, placeholder-only. The shared `Field` component existed but was bypassed. 91 unnamed-control hits in the baseline sweep. | `pages/Settings.tsx`, `CreateCourse.tsx`, `NewAssignment.tsx`, `Verification.tsx` | Fixed (0 after) |
| H5 | **Mobile drawer was focusable while off-screen**; opening it did not move focus, Tab could leave it, closing did not restore focus. | `components/layout/Sidebar.tsx` | Fixed; browser-verified |
| H6 | **Text/placeholder contrast failures** (computed): `ink-soft` 3.9–4.1:1 on canvas/muted surfaces; `ink-faint` 2.47:1 on white and used for placeholders, helper text and "thinking" text; orange `link` variant 2.24:1. | `src/index.css` tokens | Fixed |

### Medium

| # | Finding | Evidence | Status |
|---|---|---|---|
| M1 | Every route had the same document title (WCAG 2.4.2). | `index.html`; 1 distinct title in 245 combos | Fixed (24 distinct) |
| M2 | Form control borders were `#babd8e`, 1.95:1 against white (WCAG 1.4.11 asks 3:1). | `Input.tsx`, textareas/selects | Fixed (new `--color-control-border`, ≥3.36:1) |
| M3 | Teacher dashboard review table overflowed by 23px at 1024px (the sidebar leaves ~736px). | `AttentionCenter.tsx` | Fixed (stacked list between `lg` and `xl`) |
| M4 | Teacher assignment (320px) and student detail (320/375px) overflowed: unbreakable email in `PageIntro` subtitle; attachment row with a non-shrinking action group. | `PageIntro.tsx`, `teacher/AssignmentDetail.tsx` | Fixed |
| M5 | Page titles (`h1`) were truncated with an ellipsis, hiding part of long course names. | `PageIntro.tsx` | Fixed (wraps) |
| M6 | AI Coach header: the Chat/Whiteboard control overlapped the title and due-date badge at 375px. | `AiCoach.tsx` header | Fixed |
| M7 | AI Coach messages showed literal backticks; pasted code was not monospace and could not scroll. | `AiCoach.tsx` `Bubble` | Fixed (`RichText`: React elements only, no HTML injection; unit-tested) |
| M8 | Chat/Whiteboard control used `role="tab"` with no tabpanel, no roving tabindex, no arrow keys; transcript was not announced to screen readers or keyboard-scrollable. | `AiCoach.tsx` | Fixed; browser-verified |
| M9 | SmartBoard empty-state hint is drawn in board units, so at the 18% fit-zoom on a phone it rendered at ~7px, in a 2.5:1 grey. | `SmartBoard.tsx` | Fixed (counter-scaled using the existing `effectiveScale`; viewport math untouched) |

### Low

| # | Finding | Status |
|---|---|---|
| L1 | Many standalone links/icon buttons were 14–20px tall (breadcrumbs, footer lists, download and "View student" icon buttons, "View all"). | Fixed. Remaining: in-sentence links such as "Already have an account? Log in", which WCAG 2.5.8 exempts. |
| L2 | Teacher dashboard rendered no `h1` while loading, on error, or with no course. | Fixed (visually hidden heading in those states) |
| L3 | SmartBoard demo had no landmark or heading; the ask input had no label; the zoom-percentage button was 20px tall. | Fixed |
| L4 | `MetricCard` label could collide with its icon in narrow cards; 5 cards in a 3-column grid left an empty cell. | Fixed |
| L5 | Course colour swatches and creation-mode buttons exposed no pressed state. | Fixed (`aria-pressed`) |

### Open / not changed

- **"Ask Gemini to draw, simulate, or explain…"** (SmartBoard ask input) shows a model name in the product UI. Existing tests assert this exact string, so the copy was left for a product decision.
- The dashboard shows eight metric cards. This was left as designed; consolidating them is a product/design choice that needs teacher feedback, and I did not invent evidence for it.
- `aria-live="polite"` is on the whole coach transcript panel; the history load may be announced once. Not tested with a screen reader.
- **Not examined:** Arabic/RTL layout of the UI (only the voice-language selector is Arabic), dark mode, destructive-action confirmations, error boundaries, and real screen-reader behaviour. **No performance measurements were taken, so no performance claims are made.**
- Real-backend flows (login against Supabase, coach replies, uploads, grading, Live Voice and microphone) were not exercised.
- Pages that were swept but not reviewed by eye: teacher Create course, New assignment, Upload material, Material detail, Settings. They have no overflow and no unnamed controls in the sweep.

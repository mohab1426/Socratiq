# UI/UX Changelog

All paths are under `frontend/`. 37 existing files modified, 9 files added. No backend, schema, auth, API-contract, LLM or Live Voice code was changed. No dependency was added to the project. No existing test was edited. Finding IDs refer to `docs/UI_UX_AUDIT.md`.

## Design tokens and shared primitives

| File | Change | Why |
|---|---|---|
| `src/index.css` | `--color-ink-soft` `#77756c` → `#68665c`; new `--color-control-border: #80834f`; `--color-ink-faint` documented as decorative only | H6, M2: AA contrast for text; ≥3:1 for control boundaries |
| `src/components/ui/Input.tsx`, `GradePanel.tsx`, `PageHeader.tsx` (search), `NewAssignment.tsx`, `Verification.tsx`, `AiCoach.tsx` | Form-control borders use `--color-control-border` | M2 |
| ~10 files (`States.tsx`, `AiCoach.tsx`, `MaterialDetail.tsx`, `Input.tsx`, …) | `text-/placeholder:text-[var(--color-ink-faint)]` → `ink-muted` | H6: placeholders and helper text were 2.47:1 |
| `ui/Button.tsx` | `link` variant is ink-coloured and underlined | H6: orange text was 2.24:1 |
| `ui/PageIntro.tsx` | Title wraps (`text-balance`, `overflow-wrap:anywhere`) instead of truncating; subtitle wraps | M4, M5 |
| `ui/Badge.tsx` | `max-w-full` + wrapping | M4: long course names |
| `ui/RichText.tsx` + `lib/richText.ts` (new, tested) | Safe chat renderer for ``` fences and `inline code`; builds React elements only | M7 |

## Navigation and shell

| File | Change | Why |
|---|---|---|
| `layout/Sidebar.tsx` | Closed phone drawer is `invisible`; on open, focus moves to Close (retried across frames, because the drawer is hidden on its first frame); Tab is trapped; Escape closes and focus returns to the opener; `role="dialog" aria-modal` only while open; larger Close button; `motion-reduce` | H5 |
| `layout/PageHeader.tsx` | Larger menu button; 24px breadcrumb line height with `inline-block` links | L1 |
| `layout/RouteTitle.tsx`, `routeTitles.ts` (+ test), `App.tsx` | One title per route, set centrally | M1 |
| `layout/PublicHeader.tsx`, `brand/Logo.tsx` | Tighter padding, smaller mark and wordmark below `sm`; buttons fit 320px | H2 |
| `layout/PublicFooter.tsx` | Footer and mailto links ≥24px tall | L1 |
| `pages/auth/{ChooseSignup,ForgotPassword,Login,SignupForm}.tsx` | Standalone links ≥32px tall (in-sentence links untouched) | L1 |

## Student experience

| File | Change | Why |
|---|---|---|
| `pages/student/AiCoach.tsx` | Header wraps (no overlap); composer wraps on phones with the input on its own row, so Send is visible; messages wrap and render code through `RichText` (pasted indented code becomes a scrollable monospace block); complete tab pattern (ids, `aria-controls`, roving tabindex, arrow/Home/End keys); transcript is a keyboard-focusable `tabpanel` with a polite live region | H1, M6, M7, M8 |
| `socratiq/LearningJourney.tsx` | Container query: stacked below 28rem, horizontal above; step names exposed to assistive tech | H3 |
| `pages/student/AssignmentDetail.tsx` | 32px download button, decorative icon hidden from assistive tech | L1 |
| `pages/student/Verification.tsx` | Textarea named ("Your response") and linked to the question | H4 |

## Teacher experience

| File | Change | Why |
|---|---|---|
| `pages/teacher/Dashboard.tsx` | Metric grid fills rows at every width (2+2+1 / 3+2 / 5); hidden `h1` while loading, on error and with no course; 24px "View all" | L2, L4 |
| `socratiq/AttentionCenter.tsx` | Table only where it fits (`md`, `xl`+); stacked list between `lg` and `xl` | M3 |
| `socratiq/MetricCard.tsx` | Label can shrink, icon cannot | L4 |
| `socratiq/StudentsTable.tsx`, `StudentSections.tsx`, `RiskPanel.tsx` | Icon and text links ≥24px | L1 |
| `pages/teacher/AssignmentDetail.tsx` | Header and attachment rows wrap; Download/Remove targets enlarged | M4, L1 |
| `pages/teacher/{CreateCourse,NewAssignment}.tsx`, `pages/Settings.tsx` | Use shared `Field` (label ↔ input), `aria-pressed` on toggle buttons, grouped labels | H4, L5 |

## SmartBoard (layout only)

| File | Change | Why |
|---|---|---|
| `socratiq/SmartBoard.tsx` | Empty-state hint counter-scaled by the existing `effectiveScale`; darker grey | M9. No viewport, placement or student-work code touched |
| `socratiq/BoardWorkspace.tsx` | `aria-label` on the ask input; darker placeholder | L3 |
| `socratiq/SmartBoardToolbar.tsx` | Zoom-percentage button 24px tall | L3 |
| `pages/SmartBoardDemo.tsx` | `<main>` landmark and hidden `h1` | L3 |

## Tooling and evidence (new)

- `scripts/ui-audit/sweep.mjs`, `mocks.mjs`, `interactions.mjs`, `compare.py`: reproducible multi-viewport sweep, layout-only fixtures, keyboard/focus checks, before/after comparison.
- `docs/ui-ux-evidence/before/`, `after/`: screenshots and result JSON from the sweeps. `interactions-results.json`: keyboard checks.
- Unit tests added: `routeTitles.test.ts` (3), `RichText.test.tsx` (4).

## SmartBoard canvas, tools and placement
See `docs/SMARTBOARD_CANVAS_NOTES.md` (changes, verification with its limits, limitations). Optional browser harness: `tools/smartboard-browser-harness/`.

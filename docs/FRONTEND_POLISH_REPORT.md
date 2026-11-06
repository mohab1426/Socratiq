# Teacher dashboard: frontend UI/UX polish pass

Labels: **VERIFIED** = actually executed here. **NOT VERIFIED** = needs installed npm packages or a browser, which the sandbox did not have (no network; `npm ci --offline` failed with ENOTCACHED).

## 1. UI changes
* One shared visual language for the three teacher pages: `Panel` (white, hairline border, radius-lg, one restrained shadow token `--shadow-panel`), `PageIntro` (same title block everywhere), consistent table header (muted band, semibold 12px), hover rows, `motion-reduce` on all animations. Existing palette and Tailwind theme kept.
* **Dashboard**: compact header (course, code, classrooms, teacher, status, freshness + Refresh with spinner), five counted metric cards with icons and visible helper text (the review card is tinted only when the count is above zero), **"Needs your review"** as the one accented panel with short explanation, then Recent activity | Course progress, the student roster, class analytics on demand.
* **Needs your review**: table on md+, stacked tappable cards on small screens; status badge (icon + text), main reason, evidence count, last activity, "View student" button; calm empty state. Learning support is labelled separately from review level.
* **Review overview (RiskPanel)**: large level tile (icon + text + tint), confidence as a percentage + label + bar, evidence count, last evidence time; "Why this needs review" list where each reason opens to its evidence ("View evidence") with links to the submission; for *Insufficient evidence* a progress bar of recorded activity vs the minimum. Disclaimer kept.
* **Student page**: header with avatar, course badges, last activity, quick actions (latest submission, course page); anchor chips for each section; Review overview, then a wide **timeline** (grouped by day, time column, icon dots per event type, connecting line, flagged events ringed and labelled, assignment link), Coach activity and Concept mastery (with bar + trend icon) in a narrower column, then Verification and Assignments.
* **Submission review**: same header/panel structure; submission, verification, review level in reading order.
* Loading skeletons shaped like each page; friendly error state ("Something went wrong ... Try again") with no raw server text; 404/403 say "not found or no access".
* Sidebar: Escape closes the mobile drawer; course items use a dot instead of repeating the icon.
* Accessibility: risk levels use icon + text + tint; hidden "Review level:" prefix for screen readers; helper text moved from the faint grey to the AA "muted" ink in teacher pages; `aria-expanded/controls` on the analytics toggle; `scope` on table headers; `role=alert/status` on states.

## 2. Files changed
Created: `components/ui/Panel.tsx`, `components/ui/PageIntro.tsx`, `components/socratiq/Skeletons.tsx`, `components/socratiq/StudentsTable.tsx`.
Rewritten: `pages/teacher/{Dashboard,StudentDetail,SubmissionReview}.tsx`, `components/socratiq/{RiskPanel,AttentionCenter,StudentSections,MetricCard}.tsx`.
Edited: `components/ui/States.tsx`, `components/layout/Sidebar.tsx`, `components/socratiq/{AttentionList,ActivityFeed}.tsx`, `lib/time.ts`, `index.css` (one token), `pages/auth/SignupForm.tsx` (removed an unused `role` parameter left by the earlier Teacher Code removal). Text-contrast class swap in 4 more `pages/teacher` / `components/socratiq` files.
Deleted: `components/socratiq/SignalList.tsx` (no longer used anywhere).

## 3. API changes
**None.** No backend file was touched in this pass; the frontend only reads fields the previous pass already returns (`types/index.ts` and `lib/queries.ts` unchanged). `averageGrade` stays in the API type for contract compatibility and is never displayed.

## 4. Validation
VERIFIED (executed): static resolution of every `@/` import and every named import in the whole `src/` tree (none unresolved); TypeScript 6.0.3 parse/check over all of `src/` with strict + noUnusedLocals: **no syntax errors and no unused locals/params in any file I changed**; backend still compiles.
The remaining ~2,000 tsc messages are all dependency noise (react, react-router, react-query, cva, lucide types are not installed), and appear the same way in files I never touched. They are not evidence of, or against, correctness.
NOT VERIFIED: `npm install`, `npm run build` (`tsc -b && vite build`), `npm run lint` (oxlint), any browser rendering, and the responsive checks at 1440/1280/1024/768/mobile. Responsiveness was designed (md table/card switch, `min-w-0`, `overflow-x-auto` for wide tables, no fixed widths on pages) but never looked at on a screen. Backend tests were not re-run (no Postgres/deps).

## 5. Artifact
`socratiq-frontend-updated.zip`: the complete `frontend/` directory (src, public, package.json, package-lock.json, vite/ts configs, Dockerfile, nginx.conf, vercel.json, README). No node_modules, .git, build output or .env files.

## 6. Remaining issues
* First `npm run build` may reveal small type/lint issues that only the real type packages can show. Fix before the demo.
* Look at each page in a browser at the five widths; the timeline, the two-column student layout and the mobile cards are the parts most worth checking.
* Recharts analytics (behind "Show class analytics") and the other teacher pages (courses, assignment detail, materials) were not restyled; they keep the old look and will differ slightly from the three polished pages.
* The teacher navigation still has Dashboard / Courses (+ each course) / Settings. There are no separate Students or Analytics routes, and none were invented.
* Timeline "flagged" marks and reasons depend on the backend's risk signals; a student with no signals simply shows no marks.

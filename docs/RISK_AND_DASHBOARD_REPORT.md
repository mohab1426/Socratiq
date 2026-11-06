# Risk Intelligence + Teacher Dashboard pass

Labels: **VERIFIED** = actually executed or statically checked here; **NOT VERIFIED** = needs Postgres / npm / a live stack that the sandbox did not have (no network).

## A. Changed / created files
Created: `backend/app/risk.py`, `backend/tests/test_risk_model.py`, `backend/tests/test_risk_api.py`, `frontend/src/lib/time.ts`,
`frontend/src/components/socratiq/{RiskPanel,AttentionCenter,StudentSections}.tsx`, this report.
Modified: `backend/app/analytics.py` (dashboard + student detail), `backend/app/records.py` (severity at write), `backend/app/routers/teacher.py`
(risk on submission review), `backend/tests/{test_api_core,test_frontend_contract}.py`, `frontend/src/types/index.ts`, `frontend/src/lib/queries.ts`,
`frontend/src/pages/teacher/{Dashboard,StudentDetail,SubmissionReview}.tsx`, `frontend/src/components/socratiq/AttentionList.tsx` (title prop).
`access.py` and the AI package were NOT touched in this pass.

## B. Database changes
**None.** `risk_signals.severity` already existed (LOW/MEDIUM/HIGH check). It is now filled at write time from the catalogue in `risk.py`.
`risk_signals.confidence` stays NULL deliberately: confidence belongs to a student's assessment (evidence quantity/quality), not to one row.
The assessment is computed on read from live rows, so it cannot go stale and no table was needed. Existing NULL-severity rows are handled
by the catalogue at read time; no backfill is required.

## C. Risk pipeline
```
raw evidence (rows that already exist)
  risk_signals (Coach structural patterns) | verification_runs/results | submissions+attempts (timing, draft)
  -> observations (each keeps the id of its source row)
  -> weighted points (catalogue weights; repeats +25% capped 2x; assignments later PASSED in verification x0.5)
  -> score = 1 - exp(-points/6)   in [0,1)
  -> level: insufficient (< 3 activity units) | low < .30 | moderate < .60 | high (also needs >= 3 observations AND Medium+ confidence)
  -> confidence (of the assessment) = .5*min(activity/10,1) + .5*(channels/3)
  -> reasons + disclaimer -> dashboard queue / student page / submission review
```
Signals: 3 Coach patterns (large jump, structure inconsistent with previous attempt, style shift), could-not-explain (Explain step needs-retry),
verification needs-retry, rapid large typed submission with no saved draft. Coach usage itself is never a signal; it only raises confidence.
Weights/thresholds are conservative policy defaults, NOT calibrated on labelled data (none exists). They live in one place and are pinned by tests.
Wording: "review level", "indicator for instructor review, not proof of external AI use".

## D. Data-utilization matrix (risk pass)
| Data | Stored | Retrieved | Used by AI | Used by verification | Used by risk | Used by dashboard | Status |
|---|---|---|---|---|---|---|---|
| risk_signals | Coach turn | risk.py, analytics | no | no | observations (+severity) | queue, student page, review | USED (was counted only) |
| verification_results/runs | verification | risk.py, analytics | feedback+mastery to Coach | source | could-not-explain, needs-retry, PASS mitigation | verification panel, queue | USED |
| submissions + attempts.started_at/draft_text | submit | risk.py | no | student work | rapid large submission | via risk | USED (new) |
| ai_interactions | Coach turn | risk.py, analytics | history | no | activity (confidence only) | AI-usage panel | USED |
| evidence_candidates | Coach/verification | risk.py, analytics | history | linked | balancing count (display only) | risk panel | PARTIALLY USED |
| learning_events | all flows | analytics | no | no | link signal -> event | timeline, last activity | USED (timeline was never shown before) |
| student_concept_state | verification | analytics | Coach (prev. pass) | computed | no | concept panel (now course-scoped) | USED |
| submissions.score | none writes it | analytics | no | no | no | not displayed | DEAD, hidden |
| ai_interaction_sources / assignment_versions | write-only | none | no | no | no | no | still DEAD |
| direct-answer requests, outside-tool use | not recorded | n/a | n/a | n/a | not a signal | UI says "not measured" | NOT AVAILABLE |

## E. Dashboard workflow
Dashboard: compact header (course, code, classrooms, teacher, freshness + Refresh) -> five counted metrics (students, active 14d, need review,
published assignments, verifications completed) -> **Needs your review** table (student, status, main reason, evidence count, last activity, link;
learning-support students are separate and labelled as such) -> roster with review level -> assignments/recent evidence -> class analytics
(loaded only on request). Student page: overview -> review level with expandable signals (each shows time, assignment, observation, link to the
submission) -> learning-process timeline (flagged events marked) -> Coach use (kept apart from risk) -> concept mastery with trend -> verification
runs with per-question feedback and links -> assignment progress. Average Grade is not shown anywhere (no grading flow exists; API still returns null for compatibility).

## F. Tests
VERIFIED (executed here): `python -m compileall` on backend/app, backend/tests, ai: OK. `backend/tests/test_risk_model.py`: 13/13 passed
(no evidence, insufficient, low/moderate/high, thin-record cap, duplicates, per-assignment grouping, mitigation, confidence, bounds, traceability, wording).
Static: every new TS interface field has a matching backend key; no unused imports in new TSX; teacher UI source has no accusatory/detection words.
NOT VERIFIED: `test_risk_api.py` (dashboard structure, insufficient with real DB, isolation S1/S2, P2/P3 denied, concept scoping, severity write),
the extended `test_frontend_contract.py`, the full existing pytest suite (Coach regression tests included), `tsc`/build/lint, browser rendering and responsiveness.
Reason: no network -> no fastapi/psycopg/langgraph/npm packages, and no Postgres. Nothing was exercised in a browser.

## G. Remaining limitations / findings
* Fixed cross-tenant leak: the old student-detail "struggling topics" read `student_concept_state` across ALL of a student's courses, exposing another instructor's concept names. Now restricted to concepts tied to this instructor's courses.
* Unknown Coach signal names default to LOW/1 point. The Coach's own signal names in `evidence.py` are covered by the catalogue.
* "Rapid large submission" cannot distinguish pasting from elsewhere from honest offline work: weight LOW by design.
* Concept "recent changes" are derived from verification score history; there is no mastery history table.
* Recharts was not needed: no chart beats the tables here. Existing analytics charts remain behind "Show class analytics".
* The frontend was never compiled; expect to fix small type/lint issues on the first `npm run build`.
* Grades and instructor feedback remain unimplemented; a grading flow needs a migration (score upper bound, max score, feedback).

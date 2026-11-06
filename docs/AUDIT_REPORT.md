# SocratiQ audit and fix pass

Evidence labels: **VERIFIED** (read in code / compiled / statically checked), **NOT VERIFIED** (could not be executed here).

## Environment limits (read first)
The audit sandbox had **no network**: `pip install` (fastapi, langgraph, psycopg, ...) and `npm install` failed and no Postgres exists.
So **no pytest, tsc, lint, build or live test could be run.** What was done: full source reading, `python -m py_compile` on every
Python file I changed (passed), and careful review of the TS edits. Every test below marked NOT RUN needs your CI.

## 1. Architecture findings (VERIFIED by reading)
Frontend (React/Vite) -> FastAPI routers -> `access.py` (authorisation) -> `ai_adapter.py` (only AI boundary) -> LangGraph Coach
(`understand_context -> [analyze_code] -> diagnose -> choose_intervention -> [retrieve_context] -> generate_response -> validate ->
emit_interaction`) -> Postgres persistence (`ai_interactions`, `messages`, `learning_events`, `evidence_candidates`, `risk_signals`,
`ai_interaction_sources`) -> `analytics.py` -> teacher/student pages. Backend connects as DB owner (bypasses RLS) and enforces access
in `access.py`; RLS (013) protects the Data API only (RLS policies themselves: NOT VERIFIED, not read in depth).

## 2. Issues found and fixed
| # | Problem | Root cause | Files | Fix | Verification |
|---|---|---|---|---|---|
| 1 | Coach was told "Course materials available (0): none uploaded yet" even when materials existed; course code/title, classroom, university, attachments were always empty | `student_assignment()` returns only `assignments.*`; the adapter read keys that were never populated | `access.py`, `routers/ai.py` | new `coach_application_context()` loads names, attachment list, classroom material catalogue (READY/STORED_ONLY only, classroom-scoped) | compiled; tests written (NOT RUN) |
| 2 | Verified concept mastery (`student_concept_state`) and verification feedback were written but never read by the Coach | only `analytics.py` read them | `ai_adapter.py` (`DbHistoryProvider`) | provider now also returns this student's mastery for the diagnosed concept and latest verification feedback, sanitised | compiled; tests written (NOT RUN) |
| 3 | Instructor-tagged assignment concepts never reached the AI | no field on `TaskContext` | `ai/agents/coach/state.py`, `context.py`, `ai_adapter.py` | optional `concepts` field, rendered only when present | compiled (NOT RUN) |
| 4 | Teacher Code mechanism, incl. on-screen hint "it is '123'" | signup form/API/config | `schemas.py`, `auth_users.py`, `config.py`, `SignupForm.tsx`, `CompleteProfile.tsx`, `auth.tsx`, `test_security.py` | removed input, field, env var, production start-up requirement. Teacher signup still works | grep shows no remaining reference |
| 5 | `auth_users._me` used `HTTPException` without importing it (NameError -> 500 for unsupported role) | missing import | `auth_users.py` | imported | compiled |
| 6 | History text derived from student answers went unsanitised into prompts | provider | `ai_adapter.py` | `sanitize_untrusted_text` applied | compiled |

## 3. Findings NOT fixed (by decision or limits)
* **Streaming: `POST /ai/coach/stream` DOES NOT EXIST.** No SSE/`StreamingResponse`/`astream` anywhere; the UI calls plain JSON `POST /ai/coach`. Every LLM node uses `with_structured_output(...).invoke`, so token streaming was never wired. I did not invent one without the ability to run it. Recommended: stream the final free-text reply, or emit SSE status events per graph node.
* **Grading does not exist.** No endpoint or UI writes `submissions.score`; `average_grade` is therefore always null and the frontend never renders it (dead API field). `score` has no upper bound and there is no max-score or feedback column, so a grading feature needs a migration. Grade and verification are already stored separately (`submissions.score` vs `verification_*`, 0-1), so they cannot be confused today.
* **Teacher signup is open by design now.** Role is chosen at signup, stored once (409 on repeat), `ADMIN` unreachable, and instructors only reach their own courses/classrooms, so a student cannot escalate an existing account and a self-declared instructor sees no one else's data. Residual risk: anyone can create an instructor account and course. If that matters, add email-domain allow-listing or admin approval (not implemented).
* `diagnose` receives `course_material` from state, but retrieval runs later, so it is always empty (dead input, harmless). Fix would reorder the graph.
* `needs_student_history` is decided by an LLM; mastery/history reach the response prompt only when it is true. Diagnosis/intervention prompts do not receive history.
* Write-only tables: `ai_interaction_sources`, `assignment_versions`, `document_chunk_concepts`, `document_chunk_assignments`, `verification_question_evidence` are never read. `risk_signals.severity/confidence` always NULL (intentional).
* Rate limiting is per-process memory (documented in code).
* Landing-page product previews use static illustrative numbers (marketing, not app data). Teacher dashboard/analytics metrics all trace to SQL in `analytics.py`; I found no hardcoded figures there.

## 4. Data-utilisation matrix
| Data | Stored in | Retrieved by | Used by AI | Used by verification | Used by dashboard | Status |
|---|---|---|---|---|---|---|
| Student name | users | `get_current_user` | response prompt | no | names | USED |
| Assignment title/instructions/due/subject | assignments | `student_assignment` | all prompts | challenge context (instr. only) | yes | USED |
| Course/classroom/university names | courses/classrooms/universities | `coach_application_context` (new) | response prompt | no | yes | was DEAD -> FIXED |
| Material catalogue / attachments | materials, stored_files, assignment_attachments | `coach_application_context` (new) | response prompt | no | teacher pages | was BROKEN -> FIXED |
| Assignment concepts | assignment_concepts | new loader; verification `_concept` | response prompt (new) | yes (concept choice) | teacher detail | was PARTIAL -> FIXED |
| Retrieved RAG chunks | document_chunks | RAGService via scoped tool | `generate_response`, `validate` (not `diagnose`) | no | provenance stored only | PARTIALLY USED |
| Conversation history | messages | `routers/ai.py` (window) | all node prompts | no | count only | USED |
| Previous diagnosis/intervention | ai_interactions | last row | diagnose, choose_intervention | no | no | USED |
| Evidence candidates | evidence_candidates | history provider | response prompt (if LLM asks) | created by verification | student detail (STRONG only) | PARTIALLY USED |
| Concept mastery | student_concept_state | history provider (new) | response prompt (new) | computed from results | teacher (struggling topics) | was DEAD for AI -> FIXED |
| Verification results/feedback | verification_results | history provider (new) | response prompt (new) | source | review, attention list | was DEAD for AI -> FIXED |
| Learning events | learning_events | activity feed only | no | no | feeds/timeline | PARTIALLY USED |
| Risk signals | risk_signals | analytics | no | no | counts, attention | USED (evidence wording) |
| Submissions text | submissions | verification, teacher review | verification prompts | yes | preview | USED |
| Grade (`submissions.score`) | submissions | `analytics.course_dashboard` | no | no | `average_grade` never rendered | DEAD/MISLEADING (no writer) |
| Instructor feedback | none | none | no | no | no | DOES NOT EXIST |
| Interaction sources | ai_interaction_sources | none | no | no | no | DEAD (write-only) |

## 5. Data flow (actual)
```
React (api.ts JSON) -> /api/v1/ai/coach -> require_student -> access.student_assignment
  -> context loaders: allowed_document_ids, coach_application_context (NEW), last diagnosis, message window
  -> AIAdapter.coach_turn (TaskContext with trusted scope) -> LangGraph Coach
       understand_context -> diagnose -> choose_intervention -> retrieve_context (RAG scoped + StudentHistory incl. mastery NEW)
       -> generate_response (structured LLM) -> validate -> emit_interaction
  -> one transaction: ai_interactions, sources, messages, learning_event, evidence, risk_signals, turn_count
  -> analytics.py SQL -> teacher dashboard / student detail / submission review
```

## 6. Tests
* Executed: `python -m py_compile` on all changed Python files: passed. Grep confirms no `teacher_code` / `TEACHER_SIGNUP_CODE` remain.
* **NOT RUN (no network/Postgres/node_modules):** entire pytest suite (ai, backend, database), tsc, lint, build, all integration flows.
* Added (NOT RUN): `backend/tests/test_data_utilization.py` (8 tests: catalogue, scoping, concepts, mastery, per-student isolation, verification feedback, teacher visibility). Rewrote signup tests in `backend/tests/test_security.py`.
  I updated the production config-validation expectation from `>= 5` to `>= 4` problems by counting; confirm when you run it.

## 7. Not audited in depth (NOT VERIFIED)
RLS policies (013), RAG retrieval/reranker internals and latency, embedding-dimension checks (schema declares `vector(2048)`), file extractors/upload hardening, HNSW indexes, performance/N+1 measurements, frontend rendering. No performance claims are made.

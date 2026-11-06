# SocratiQ — The Socratic Class

An AI learning platform for university courses built around one loop:

**Student attempt → Socratic AI coaching → learning evidence → teacher insight**

The AI Coach is designed to help students *think*, not to hand over answers: it diagnoses where the student is, asks a targeted
question, gives the smallest useful hint, and moves on to transfer or verification once understanding is shown. What the student
does along the way (attempts, coach turns, revisions, verification, grades) is recorded as evidence the instructor can inspect.
There is intentionally **no avatar**; the interface is text, voice and a thinking space.

## What is in the repository

| Area | Where | Notes |
|---|---|---|
| API | `backend/app/` | FastAPI. Routers in `routers/`; authorization helpers in `access.py`; serializers in `views.py` |
| AI Coach | `ai/agents/coach/` | LangGraph pipeline: understand → analyze code → diagnose → choose intervention → retrieve → respond → validate (safe fallback on failure) |
| RAG | `ai/rag/` | pgvector store, NVIDIA embeddings and reranker, chunking, ingestion, prompt-injection sanitising (`security.py`) |
| Smart Whiteboard | `ai/whiteboard/` | board model, LaTeX allow-list, action validation + layout engine, `read_board` digest, Arabic/English command rules (pure Python, no network) |
| Verification | `ai/verification/` | short check of understanding after submission |
| Database | `database/migrations/000…015` | Postgres 16 + pgvector, row-level security, tenant integrity triggers |
| Frontend | `frontend/` | React + Vite + TypeScript + Tailwind, react-query, Supabase Auth |
| Tests | `ai/tests`, `backend/tests`, `database/tests`, `frontend/src/**/*.test.ts(x)` | see Testing |
| Reports from earlier passes | `docs/*.md` | audit, merged architecture, risk/dashboard and UI polish notes (point-in-time, may lag the code) |

## Features (all implemented in code; see "Known limitations" for what was not verified)

- **Roles:** students and instructors. Role, university, classroom and assistance policy are derived on the server from the database; the client never supplies them. Other instructors/universities get 404.
- **Coach:** `POST /api/v1/ai/coach` and a streaming variant `POST /api/v1/ai/coach/stream` (Server-Sent Events) share the same context loading, graph and persistence. The stream reports real pipeline stages and sends the reply text only after the validator accepted it. A turn that fails or is cancelled is not saved.
- **Coach context:** course, classroom, assignment instructions and concepts, material catalogue, student name, previous attempt/conversation, prior diagnosis, retrieved course passages, and the student's whiteboard steps. Course material and student text are treated as untrusted data.
- **Voice:** microphone → browser speech recognition → the same Coach request → reply text → browser speech synthesis. English and Arabic. Uses the Web Speech API; there is no separate voice pipeline.
- **Smart Whiteboard:** the Coach page has two modes, **Chat** and **Whiteboard**. The board is a full workspace with select/move, pen, highlighter, eraser (also removes elements), text, KaTeX equations, arrows (linkable to elements), rectangles/ellipses, undo/redo, clear, grid and an *Ask SocratiQ* menu (explain, continue, check my work, summarize, organize, highlight the key point, turn into steps). The board lives in `attempts.whiteboard` and autosaves.
- **SocratiQ writes on the board through validated actions, not pixels.** The model may return `board_actions` with its reply (`add_text`, `add_equation`, `highlight`, `erase`, `clear`, `update`, `add_arrow`, `add_shape`, `organize`). It reads the board as structured state with element ids and authorship, never as an image, and never chooses coordinates: positions are semantic ("below the previous step", "next to element e3") and the server lays them out. The server re-validates every action against the board as stored, applies it atomically with the turn, and returns the new board; the browser reveals new items one after another.
- **Board safety rules (enforced in code, not only in the prompt):** the same pedagogy validator judges the reply *and* the text SocratiQ wants to write, so the board cannot bypass guided coaching; if the reply is rewritten or falls back, the board writing is dropped. Clearing the board, erasing or organizing the *student's* items happens only when the student explicitly asked (typed or spoken, Arabic or English, or via the Organize button). Student-written items are never rewritten; corrections are added as notes. Equations must pass a LaTeX allow-list. Authorship (student vs SocratiQ) is decided by the server, and SocratiQ-written content is never counted as the student's reasoning.
- **Voice controls the board:** a spoken request is just another Coach turn, so "write this law on the board", "erase the last step" or "clear the board" go through the same pipeline; unmistakable clear/erase-last/organize commands also work if the model forgets to emit the action.
- **Learning evidence:** attempts, coach turns (with diagnosis and intervention), revisions (one per coach turn, only when the draft materially changed), submissions, verification results.
- **Grading:** instructors grade a student's latest submission (score, maximum, feedback). One persisted grade on `submissions`; the student view, submission review and dashboard average all read it.
- **Teacher dashboard:** counts and rates computed from real rows; a *Needs Review* list that states the reason, evidence count and assignment, with a link to the underlying work. Possible external-AI-assistance indicators are signals to look at, never a finding of misconduct.

## Setup

Requirements: Python 3.12, Node 22, Postgres 16 with the `pgvector` extension, a Supabase project for Auth (and Storage in production).

```bash
cp .env.example .env              # then fill it in; see "Environment variables"

# Backend (repository root)
pip install -r requirements-dev.txt
python database/run_migrations.py                    # applies database/migrations/*.sql using DATABASE_URL
uvicorn backend.app.main:app --reload --port 8000    # docs at http://localhost:8000/docs, health at /health

# Frontend
cd frontend && npm ci && npm run dev                 # http://localhost:5173
```

On a plain Postgres (no Supabase `auth` schema) run `python database/run_migrations.py --local-supabase-stub` instead. Never use that flag on a real Supabase project.

Everything in one go: `docker compose up --build` (needs `POSTGRES_PASSWORD` and your `SUPABASE_*` values in `.env`; web on :5173, API on :8000).

## Environment variables

`.env.example` lists every variable the code reads, with which are required. The essentials:

- `DATABASE_URL`, `CORS_ORIGINS` (explicit origins; `*` is rejected in production), `PUBLIC_API_URL`
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (server only), `FILE_LINK_SECRET` (required in production)
- Frontend build: `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (public by design)
- AI: `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL_DEFAULT`, or per role `AI_<ROLE>_PROVIDER/API_KEY/BASE_URL` and `AI_MODEL_<ROLE>` for `COACH`, `REASONING`, `LIGHTWEIGHT`, `VERIFICATION` (resolution rules are in `ai/config.py`)
- RAG: `NVIDIA_API_KEY`, `RAG_EMBEDDING_*`, `RAG_RERANKER_*`. `RAG_EMBEDDING_DIM` must equal the database column (`vector(2048)`)

With `ENVIRONMENT=production` the backend refuses to start on an incomplete configuration.

## Database

Migrations are plain SQL in `database/migrations/` and are idempotent; `schema_migrations` records what was applied. Notable ones: `007`/`013` row-level security, `009` tenant integrity, `014_grading.sql` (scale, feedback and grader on `submissions`), `015_whiteboard.sql` (`attempts.whiteboard`), `016_whiteboard_scene.sql` (room for the native board scene under `whiteboard->'scene'`). The backend connects with its own credentials and performs authorization in code; RLS additionally protects the Supabase Data API.

## RAG

Documents are parsed, chunked, embedded (NVIDIA) and stored in pgvector with university/course/classroom/assignment metadata. Retrieval is dense + full-text, fused and reranked, always filtered to the student's allowed documents. Retrieved text is sanitised for instruction-like content and wrapped as untrusted before it reaches a prompt; if nothing relevant is retrieved the Coach is told not to invent course facts.

## Voice and whiteboard

The board needs no extra configuration or migration (it reuses `attempts.whiteboard`, migration `015`). KaTeX is bundled and loaded on demand. Voice needs a browser with `SpeechRecognition` (Chrome, Edge, Safari); where it is missing the microphone button is hidden and typing still works. The web server must allow the microphone (`Permissions-Policy: microphone=(self)` in `frontend/nginx.conf`); a deployment guard test checks this. Audio never passes through this application's servers when the browser's built-in recognition is used (the browser vendor's service may process it).

## Testing

```bash
# Backend + AI + database. DB tests need Postgres with pgvector; without it they SKIP (check the skip count):
export TEST_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres
python -m pytest ai/tests backend/tests database/tests -q

# Also run the live-database and pgvector storage tests (apply migrations to that database first: python database/run_migrations.py):
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/socratiq_test TEST_DATABASE_URL=$DATABASE_URL

# Frontend
cd frontend && npx tsc -b && npx oxlint && npm run build && npm test
```

`backend/tests/test_e2e_learning_loop.py` runs the whole loop (draft and whiteboard → streamed Coach turn → revision → submit → verification → evidence → teacher dashboard → grade → student sees the grade) through the real routers, authorization, Postgres, Coach graph and verification service with only the LLM faked. `scripts/*.py` are manual smoke tests against real providers.

## Deployment notes

- API image: `Dockerfile` (non-root, `/health` healthcheck, `--proxy-headers`). Web image: `frontend/Dockerfile` (nginx, SPA fallback). `frontend/vercel.json` provides the SPA rewrite for Vercel.
- CORS must list the web origin; the API allows `GET, POST, PUT, PATCH, DELETE, OPTIONS` and the `Authorization`, `Content-Type`, `X-Request-ID` headers (a test covers preflight for every method the frontend uses).
- **Streaming:** the stream endpoint sets `X-Accel-Buffering: no` and `Cache-Control: no-cache`. Any reverse proxy in front of the API must not buffer or time out `text/event-stream` responses before the Coach finishes (allow at least the AI timeout).
- Rate limits and the "turn in progress" guard are per process; with several API workers they are per worker.
- Set `FILE_LINK_SECRET`, Supabase credentials and explicit `CORS_ORIGINS`; local file storage is refused in production.

## Known limitations

- Not verified in the development environment: a real browser session, a real microphone and speech playback (including Arabic recognition), canvas drawing on touch devices, the real NVIDIA embedding/reranker services (one test needs a real key), a real LLM provider, and an actual production deployment. The voice logic is tested against a fake speech API only.
- The whiteboard is not read visually: SocratiQ reads typed text and equations (and the structure of arrows and frames), not freehand drawing. There is no zoom/pan, colour/size picker or manual sticky-note tool yet. Only the latest saved board is kept server-side; undo/redo history lives in the browser session.
- Whether a real model chooses sensible board actions (and understands Arabic voice commands beyond the explicit patterns) is **not verified**: tests script the model. The validation, layout, safety rules, persistence and UI are tested.
- The Coach streams stage progress, not tokens. Resistance of a real model to prompt injection cannot be proven by tests with a fake LLM; the defences tested are structural (sanitising, untrusted wrapping, server-side policy, reply validation).
- One grade per student per assignment, applied to the latest submission. No per-assignment grade distribution yet.
- Rate limiting and the in-flight guard are in memory per process.

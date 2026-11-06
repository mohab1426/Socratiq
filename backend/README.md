# Backend (FastAPI)

Thin, explicit application layer between the UI, the database and the AI.

```
app/main.py         app factory (dependency-injectable), guards, uniform errors
app/config.py       environment (aliases, production validation)
app/db.py           psycopg pool + transactions
app/auth.py         Supabase JWT verification + profile loading
app/access.py       ALL authorisation queries (university/course/classroom/enrolment/ownership)
app/routers/        student · teacher · ai (coach) · verification · files · auth_users · health
app/analytics.py    instructor metrics, each derived from stored evidence
app/records.py      learning events / evidence / risk indicators / concept state writers
app/ai_adapter.py   the only place that talks to `ai/` (Coach, retrieval, history, verification)
app/files/          registry · validation · extractors · legacy Office readers · OCR · storage · pipeline · worker · RAG bridge
tests/              real-Postgres integration tests (see docs/TESTING.md)
```

Run: `uvicorn backend.app.main:app` (from the repository root). Tests: `pytest backend/tests`.

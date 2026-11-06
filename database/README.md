# The Socratic Class — Separated Database

Apply migrations in numeric order.

- 000 extensions
- 001 RAG/pgvector — authoritative RAG tables and indexes
- 002 core university/domain
- 003 attempts/submissions
- 004 AI Coach + RAG provenance
- 005 Verification
- 006 learning evidence
- 007 RLS
- 008 general indexes/triggers

The RAG migration preserves the existing AI contract: `documents`,
`document_chunks`, `vector(2048)`, cosine HNSW, English FTS/GIN, `concepts`
JSONB and `assignment_ids` JSONB.

AI-facing IDs are strings. Attempts/submissions are separate. Verification is
run/question/response/result. No authoritative `ai_dependency_score` or hidden
chain-of-thought storage is included.

Static test:
`pytest -q tests/test_schema_static.py`

Live DB test:
`DATABASE_URL="..." pytest -q tests/test_live_db.py`

Run live tests against a disposable/test Supabase database.

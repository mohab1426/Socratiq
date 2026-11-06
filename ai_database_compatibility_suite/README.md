# The Socratic Class — AI ↔ Database Compatibility Test Suite

This suite is designed to test the **already implemented AI** against the separated
Supabase/PostgreSQL database. It does not redesign or modify the AI.

## What it tests

1. Database connectivity and required extensions.
2. Required tables/columns/types/indexes.
3. RAG schema compatibility:
   - `documents`
   - `document_chunks`
   - `vector(1024)`
   - `tsv_content`
   - HNSW cosine index
   - GIN FTS index
   - `assignment_ids` JSONB
   - exact processing/content-type values
4. Actual `PgVectorStore` compatibility when available.
5. Actual `HybridRetriever` compatibility when available.
6. Retrieval-scope isolation.
7. AI contract ID compatibility (string IDs).
8. Coach module import/contract smoke checks.
9. Verification module import/contract smoke checks.
10. Optional end-to-end AI/database integration checks.

## Important

The suite is intentionally split into **safe checks** and **live AI checks**.

- Safe checks do not call the LLM or mutate the database.
- RAG live checks can insert and delete their own uniquely tagged test rows.
- Coach/Verification live checks are opt-in because they can call external AI providers
  and may consume API credits.

The suite never logs API keys, prompts, or model secrets.

## Expected project layout

Run from the project root, for example:

    C:\Users\moata\the final

The suite expects:

    ai/
    database/
    .env

It can also be placed under `database/tests/ai_compatibility/`.

## Install

Use the same virtual environment as the project:

    python -m pip install pytest sqlalchemy psycopg2-binary python-dotenv

If the existing AI requires additional packages, install the project's normal
requirements as well.

## Environment

The tests load `.env` from the project root.

Required for database tests:

    DATABASE_URL=postgresql://...

Optional:

    RUN_LIVE_RAG=1
    RUN_LIVE_COACH=1
    RUN_LIVE_VERIFICATION=1
    RUN_LIVE_E2E=1

The default is **0** for all live AI tests.

Optional database test identifiers:

    TEST_UNIVERSITY_ID=compat_test_university
    TEST_COURSE_ID=compat_test_course
    TEST_CLASSROOM_ID=compat_test_classroom
    TEST_ASSIGNMENT_ID=compat_test_assignment
    TEST_STUDENT_ID=compat_test_student

## Run

### 1. Static AI/source inspection

    pytest -q tests/test_ai_source_contracts.py

### 2. Database structure

    pytest -q tests/test_database_schema.py

### 3. RAG database compatibility

    pytest -q tests/test_rag_database.py

### 4. AI module smoke checks

    pytest -q tests/test_ai_modules.py

### 5. Everything safe

    pytest -q -m "not live"

### 6. Live RAG

PowerShell:

    $env:RUN_LIVE_RAG="1"
    pytest -q tests/test_live_rag.py

### 7. Live Coach

PowerShell:

    $env:RUN_LIVE_COACH="1"
    pytest -q tests/test_live_coach.py

### 8. Live Verification

PowerShell:

    $env:RUN_LIVE_VERIFICATION="1"
    pytest -q tests/test_live_verification.py

### 9. Full end-to-end

PowerShell:

    $env:RUN_LIVE_E2E="1"
    pytest -q tests/test_live_e2e.py

## Recommended order

Run these first:

    pytest -q -m "not live"

Then:

    RUN_LIVE_RAG=1 pytest -q tests/test_live_rag.py

Then Coach and Verification only after the RAG/database layer passes.

## Interpreting failures

- `SCHEMA_FAIL`: database does not expose what the AI requires.
- `IMPORT_FAIL`: the existing AI cannot be imported in the current environment.
- `CONTRACT_FAIL`: AI contracts and persistence-facing assumptions disagree.
- `RAG_FAIL`: the actual RAG implementation cannot use the database.
- `SCOPE_FAIL`: retrieval isolation is not working.
- `COACH_FAIL`: the existing Coach integration cannot operate with the supplied
  database/context.
- `VERIFICATION_FAIL`: verification persistence/context is incompatible.
- `E2E_FAIL`: an integrated workflow failed.

A passing SQL/schema test is **not** enough to declare the AI/database integration
complete. The strongest evidence is that the actual AI classes can read/write and
retrieve successfully.

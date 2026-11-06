from sqlalchemy import text


def test_required_tables_exist(db_engine):
    required = {
        "documents",
        "document_chunks",
        "universities",
        "users",
        "students",
        "professors",
        "courses",
        "classrooms",
        "enrollments",
        "materials",
        "concepts",
        "assignments",
        "assignment_concepts",
        "assignment_materials",
        "document_chunk_assignments",
        "document_chunk_concepts",
        "attempts",
        "submissions",
        "ai_sessions",
        "ai_interactions",
        "messages",
        "ai_interaction_sources",
        "verification_runs",
        "verification_questions",
        "verification_responses",
        "verification_results",
        "learning_events",
        "evidence_candidates",
        "evidence_sources",
        "verification_question_evidence",
        "risk_signals",
        "student_concept_state",
    }

    with db_engine.connect() as conn:
        got = set(
            conn.execute(
                text("""
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                """)
            ).scalars().all()
        )

    missing = required - got

    assert not missing, (
        "SCHEMA_FAIL missing required tables: "
        + ", ".join(sorted(missing))
    )


def test_ai_native_string_id_columns(db_engine):
    expected = {
        "ai_sessions": {
            "session_id",
            "student_id",
            "assignment_id",
        },
        "ai_interactions": {
            "interaction_id",
            "session_id",
            "student_id",
            "assignment_id",
        },
        "learning_events": {
            "event_id",       # was "id" in an earlier draft; the live schema and the backend use event_id
            "student_id",
            "assignment_id",
            "session_id",
        },
        "evidence_candidates": {
            "student_id",
            "assignment_id",
        },
        "verification_runs": {
            "verification_id",
            "student_id",
            "assignment_id",
        },
    }

    with db_engine.connect() as conn:
        for table, columns in expected.items():
            rows = conn.execute(
                text("""
                    SELECT column_name, data_type
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = :table
                      AND column_name = ANY(:columns)
                """),
                {
                    "table": table,
                    "columns": list(columns),
                },
            ).all()

            actual = {row.column_name: row.data_type for row in rows}

            missing = columns - actual.keys()

            assert not missing, (
                f"SCHEMA_FAIL {table}: missing columns "
                + ", ".join(sorted(missing))
            )

            for column in columns:
                assert actual[column] in {
                    "character varying",
                    "text",
                }, (
                    f"SCHEMA_FAIL {table}.{column}: "
                    f"expected string/text-compatible ID, "
                    f"actual={actual[column]}"
                )


def test_rag_columns(db_engine):
    expected = {
        "documents": {
            "document_id",
            "university_id",
            "course_id",
            "classroom_id",
            "filename",
            "file_type",
            "storage_path",
            "processing_status",
            "upload_date",
            "total_pages",
            "total_chunks",
            "extra_metadata",
        },
        "document_chunks": {
            "chunk_id",
            "university_id",
            "course_id",
            "classroom_id",
            "document_id",
            "title",
            "page_number",
            "section",
            "subsection",
            "concepts",
            "content_type",
            "assignment_ids",
            "chunk_index",
            "created_at",
            "content",
            "embedding",
            "token_count",
            "tsv_content",
        },
    }

    with db_engine.connect() as conn:
        for table, columns in expected.items():
            rows = conn.execute(
                text("""
                    SELECT column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = :table
                """),
                {"table": table},
            ).scalars().all()

            actual = set(rows)
            missing = columns - actual

            assert not missing, (
                f"SCHEMA_FAIL {table}: missing columns "
                + ", ".join(sorted(missing))
            )


def test_vector_dimension_and_indexes(db_engine):
    with db_engine.connect() as conn:
        # Do not rely on pgvector's internal typmod representation.
        # Ask PostgreSQL to format the actual declared type.
        dimension = conn.execute(
            text("""
                SELECT format_type(a.atttypid, a.atttypmod)
                FROM pg_attribute a
                JOIN pg_class c
                  ON c.oid = a.attrelid
                JOIN pg_namespace n
                  ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'document_chunks'
                  AND a.attname = 'embedding'
                  AND NOT a.attisdropped
            """)
        ).scalar()

        assert dimension == "vector(1024)", (
            "SCHEMA_FAIL expected document_chunks.embedding "
            f"to be vector(1024), actual={dimension}"
        )

        indexes = set(
            conn.execute(
                text("""
                    SELECT indexname
                    FROM pg_indexes
                    WHERE schemaname = 'public'
                      AND tablename = 'document_chunks'
                """)
            ).scalars().all()
        )

        assert "document_chunks_embedding_hnsw_idx" in indexes, (
            "SCHEMA_FAIL missing HNSW vector index"
        )

        assert "document_chunks_tsv_content_gin_idx" in indexes, (
            "SCHEMA_FAIL missing GIN FTS index"
        )
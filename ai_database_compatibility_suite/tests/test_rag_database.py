from uuid import uuid4

from sqlalchemy import text


def _test_ids():
    suffix = uuid4().hex[:12]

    return {
        "document_id": f"compat_doc_{suffix}",
        "university_id": f"compat_u_{suffix}",
        "course_id": f"compat_c_{suffix}",
        "classroom_id": f"compat_cl_{suffix}",
        "chunk_id": f"compat_chunk_{suffix}",
        "assignment_id": f"compat_assignment_{suffix}",
    }


def test_rag_round_trip_sql(db_engine):
    ids = _test_ids()

    storage_path = f"compatibility-tests/{ids['document_id']}"

    with db_engine.begin() as conn:
        # ------------------------------------------------------------
        # Tenant parents. Since migration 009 the database enforces
        # (course, university) and (classroom, course, university)
        # foreign keys, so a document can no longer be created under a
        # university/course/classroom that does not exist.
        # ------------------------------------------------------------
        conn.execute(text("INSERT INTO universities (university_id, name) VALUES (:university_id, 'compat')"), ids)
        conn.execute(text("INSERT INTO courses (course_id, university_id, code, title) VALUES (:course_id, :university_id, :course_id, 'compat')"), ids)
        conn.execute(text("INSERT INTO classrooms (classroom_id, course_id, name, university_id) VALUES (:classroom_id, :course_id, 'compat', :university_id)"), ids)

        # ------------------------------------------------------------
        # Insert document
        # ------------------------------------------------------------
        conn.execute(
            text("""
                INSERT INTO documents
                (
                    document_id,
                    university_id,
                    course_id,
                    classroom_id,
                    filename,
                    file_type,
                    storage_path,
                    processing_status,
                    upload_date,
                    total_pages,
                    total_chunks,
                    extra_metadata
                )
                VALUES
                (
                    :document_id,
                    :university_id,
                    :course_id,
                    :classroom_id,
                    'compatibility-test.txt',
                    'text/plain',
                    :storage_path,
                    'stored',
                    now(),
                    1,
                    1,
                    CAST(:meta AS jsonb)
                )
            """),
            {
                **ids,
                "storage_path": storage_path,
                "meta": '{"test":true,"suite":"ai_database_compatibility"}',
            },
        )

        # ------------------------------------------------------------
        # Insert document chunk
        # ------------------------------------------------------------
        conn.execute(
            text("""
                INSERT INTO document_chunks
                (
                    chunk_id,
                    university_id,
                    course_id,
                    classroom_id,
                    document_id,
                    title,
                    content_type,
                    assignment_ids,
                    chunk_index,
                    content
                )
                VALUES
                (
                    :chunk_id,
                    :university_id,
                    :course_id,
                    :classroom_id,
                    :document_id,
                    'Compatibility Test',
                    'explanation',
                    CAST(:assignment_ids AS jsonb),
                    0,
                    'Gradient descent uses a learning rate.'
                )
            """),
            {
                **ids,
                "assignment_ids": f'["{ids["assignment_id"]}"]',
            },
        )

        # ------------------------------------------------------------
        # Read the inserted chunk
        # ------------------------------------------------------------
        row = conn.execute(
            text("""
                SELECT
                    chunk_id,
                    document_id,
                    content_type,
                    assignment_ids,
                    content
                FROM document_chunks
                WHERE chunk_id = :chunk_id
            """),
            {"chunk_id": ids["chunk_id"]},
        ).first()

        assert row is not None, (
            "RAG_FAIL inserted document chunk could not be read back"
        )

        assert row.chunk_id == ids["chunk_id"]

        assert row.document_id == ids["document_id"]

        assert row.content_type == "explanation"

        assert row.assignment_ids == [ids["assignment_id"]]

        assert row.content == (
            "Gradient descent uses a learning rate."
        )

        # ------------------------------------------------------------
        # Verify parent document
        # ------------------------------------------------------------
        document = conn.execute(
            text("""
                SELECT
                    document_id,
                    storage_path,
                    processing_status,
                    total_pages,
                    total_chunks
                FROM documents
                WHERE document_id = :document_id
            """),
            {"document_id": ids["document_id"]},
        ).first()

        assert document is not None

        assert document.document_id == ids["document_id"]

        assert document.storage_path == storage_path

        assert document.processing_status == "stored"

        assert document.total_pages == 1

        assert document.total_chunks == 1

        # ------------------------------------------------------------
        # Cleanup
        # ------------------------------------------------------------
        conn.execute(
            text("""
                DELETE FROM documents
                WHERE document_id = :document_id
            """),
            {"document_id": ids["document_id"]},
        )

        # Verify cleanup
        remaining = conn.execute(
            text("""
                SELECT COUNT(*)
                FROM documents
                WHERE document_id = :document_id
            """),
            {"document_id": ids["document_id"]},
        ).scalar_one()

        assert remaining == 0

        for stmt in ("DELETE FROM classrooms WHERE classroom_id = :classroom_id",
                     "DELETE FROM courses WHERE course_id = :course_id",
                     "DELETE FROM universities WHERE university_id = :university_id"):
            conn.execute(text(stmt), ids)

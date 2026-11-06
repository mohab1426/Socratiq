"""
PostgreSQL + pgvector storage implementation for production course RAG.

Provides dense vector similarity search via pgvector operator `<=>` and
lexical full-text search via PostgreSQL `tsvector` and `plainto_tsquery`.
Strict multi-tenant scope isolation (course, classroom, university, assignment,
allowed document IDs) is enforced directly in SQL predicates before ranking.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Optional, Sequence

from ai.rag.config import get_rag_config
from ai.rag.models import (
    ContentType,
    DocumentChunk,
    DocumentMetadata,
    ProcessingStatus,
    RetrievalScope,
    RetrievedChunk,
)

logger = logging.getLogger(__name__)


class PgVectorStore:
    """Production vector store using PostgreSQL, pgvector, and PostgreSQL FTS."""

    def __init__(self, database_url: Optional[str] = None) -> None:
        cfg = get_rag_config()
        self.database_url = database_url or cfg.database_url
        if not self.database_url:
            raise ValueError("DATABASE_URL is required for PgVectorStore.")

    def _get_connection(self):
        import psycopg
        from pgvector.psycopg import register_vector

        conn = psycopg.connect(self.database_url, autocommit=True)
        register_vector(conn)
        return conn

    def store_document(
        self,
        metadata: DocumentMetadata,
        chunks: list[DocumentChunk],
    ) -> None:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                # Upsert document metadata
                cur.execute(
                    """
                    INSERT INTO documents (
                        document_id, university_id, course_id, classroom_id,
                        uploader_id, filename, file_type, storage_path,
                        upload_date, processing_status, total_pages, total_chunks,
                        extra_metadata
                    ) VALUES (
                        %(document_id)s, %(university_id)s, %(course_id)s, %(classroom_id)s,
                        %(uploader_id)s, %(filename)s, %(file_type)s, %(storage_path)s,
                        %(upload_date)s, %(processing_status)s, %(total_pages)s, %(total_chunks)s,
                        %(extra_metadata)s
                    )
                    ON CONFLICT (document_id) DO UPDATE SET
                        processing_status = EXCLUDED.processing_status,
                        total_pages = EXCLUDED.total_pages,
                        total_chunks = EXCLUDED.total_chunks,
                        storage_path = EXCLUDED.storage_path;
                    """,
                    {
                        "document_id": metadata.document_id,
                        "university_id": metadata.university_id,
                        "course_id": metadata.course_id,
                        "classroom_id": metadata.classroom_id,
                        "uploader_id": metadata.uploader_id,
                        "filename": metadata.filename,
                        "file_type": metadata.file_type,
                        "storage_path": metadata.storage_path,
                        "upload_date": metadata.upload_date,
                        "processing_status": metadata.processing_status.value,
                        "total_pages": metadata.total_pages,
                        "total_chunks": metadata.total_chunks,
                        "extra_metadata": json.dumps(
                            {**metadata.extra_metadata, "content_hash": metadata.content_hash}
                            if metadata.content_hash
                            else metadata.extra_metadata
                        ),
                    },
                )

                # Delete previous chunks for this document if re-indexing
                cur.execute(
                    "DELETE FROM document_chunks WHERE document_id = %s;",
                    (metadata.document_id,),
                )

                # Insert chunks
                for chunk in chunks:
                    cur.execute(
                        """
                        INSERT INTO document_chunks (
                            chunk_id, university_id, course_id, classroom_id,
                            document_id, title, page_number, section, subsection,
                            concepts, content_type, assignment_ids, chunk_index,
                            created_at, content, embedding, token_count
                        ) VALUES (
                            %(chunk_id)s, %(university_id)s, %(course_id)s, %(classroom_id)s,
                            %(document_id)s, %(title)s, %(page_number)s, %(section)s, %(subsection)s,
                            %(concepts)s, %(content_type)s, %(assignment_ids)s, %(chunk_index)s,
                            %(created_at)s, %(content)s, %(embedding)s, %(token_count)s
                        );
                        """,
                        {
                            "chunk_id": chunk.chunk_id,
                            "university_id": chunk.university_id,
                            "course_id": chunk.course_id,
                            "classroom_id": chunk.classroom_id,
                            "document_id": chunk.document_id,
                            "title": chunk.title,
                            "page_number": chunk.page_number,
                            "section": chunk.section,
                            "subsection": chunk.subsection,
                            "concepts": json.dumps(chunk.concepts),
                            "content_type": chunk.content_type.value,
                            "assignment_ids": json.dumps(chunk.assignment_ids),
                            "chunk_index": chunk.chunk_index,
                            "created_at": chunk.created_at,
                            "content": chunk.content,
                            "embedding": chunk.embedding,
                            "token_count": chunk.token_count,
                        },
                    )

    def search_dense(
        self,
        course_id: str,
        query_vector: list[float],
        top_k: int = 20,
        classroom_id: Optional[str] = None,
        university_id: Optional[str] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
        scope: Optional[RetrievalScope] = None,
    ) -> list[RetrievedChunk]:
        """Perform dense vector search strictly scoped to the authorized scope."""
        eff_course = scope.course_id if scope else course_id
        eff_uni = scope.university_id if scope else university_id
        eff_room = scope.classroom_id if scope else classroom_id
        eff_asg = scope.assignment_id if scope else assignment_id
        eff_docs = scope.allowed_document_ids if scope else (tuple(allowed_document_ids) if allowed_document_ids else ())

        if not eff_course:
            raise ValueError("course_id is required for course-scoped retrieval.")

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT chunk_id, university_id, course_id, classroom_id,
                           document_id, title, page_number, section, subsection,
                           concepts, content_type, assignment_ids, chunk_index,
                           created_at, content, token_count,
                           (1 - (embedding <=> %(q_vec)s::vector)) AS cosine_sim
                    FROM document_chunks
                    WHERE course_id = %(course_id)s
                      AND (%(university_id)s::text IS NULL OR university_id = %(university_id)s::text)
                      AND (%(classroom_id)s::text IS NULL OR classroom_id = %(classroom_id)s::text OR classroom_id IS NULL)
                      AND (%(assignment_id)s::text IS NULL OR assignment_ids IS NULL OR assignment_ids::jsonb ? %(assignment_id)s::text OR assignment_ids::jsonb = '[]'::jsonb)
                      AND (%(allowed_document_ids)s::text[] IS NULL OR document_id = ANY(%(allowed_document_ids)s::text[]))
                      AND embedding IS NOT NULL
                    ORDER BY embedding <=> %(q_vec)s::vector
                    LIMIT %(top_k)s;
                    """,
                    {
                        "q_vec": query_vector,
                        "course_id": eff_course,
                        "university_id": eff_uni,
                        "classroom_id": eff_room,
                        "assignment_id": eff_asg,
                        "allowed_document_ids": list(eff_docs) if eff_docs else None,
                        "top_k": top_k,
                    },
                )
                rows = cur.fetchall()

        results: list[RetrievedChunk] = []
        for r in rows:
            chunk = DocumentChunk(
                chunk_id=r[0],
                university_id=r[1],
                course_id=r[2],
                classroom_id=r[3],
                document_id=r[4],
                title=r[5],
                page_number=r[6],
                section=r[7],
                subsection=r[8],
                concepts=json.loads(r[9]) if isinstance(r[9], str) else (r[9] or []),
                content_type=ContentType(r[10]),
                assignment_ids=json.loads(r[11]) if isinstance(r[11], str) else (r[11] or []),
                chunk_index=r[12],
                created_at=r[13],
                content=r[14],
                token_count=r[15],
            )
            sim_score = float(r[16]) if r[16] is not None else 0.0
            results.append(RetrievedChunk(chunk=chunk, score=sim_score, dense_score=sim_score))

        return results

    def search_fts(
        self,
        course_id: str,
        query: str,
        top_k: int = 20,
        classroom_id: Optional[str] = None,
        university_id: Optional[str] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
        scope: Optional[RetrievalScope] = None,
    ) -> list[RetrievedChunk]:
        """Perform PostgreSQL Full Text Search strictly scoped to the authorized scope."""
        eff_course = scope.course_id if scope else course_id
        eff_uni = scope.university_id if scope else university_id
        eff_room = scope.classroom_id if scope else classroom_id
        eff_asg = scope.assignment_id if scope else assignment_id
        eff_docs = scope.allowed_document_ids if scope else (tuple(allowed_document_ids) if allowed_document_ids else ())

        if not eff_course:
            raise ValueError("course_id is required for course-scoped retrieval.")

        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT chunk_id, university_id, course_id, classroom_id,
                           document_id, title, page_number, section, subsection,
                           concepts, content_type, assignment_ids, chunk_index,
                           created_at, content, token_count,
                           ts_rank_cd(tsv_content, plainto_tsquery('english', %(query)s)) AS rank
                    FROM document_chunks
                    WHERE course_id = %(course_id)s
                      AND (%(university_id)s::text IS NULL OR university_id = %(university_id)s::text)
                      AND (%(classroom_id)s::text IS NULL OR classroom_id = %(classroom_id)s::text OR classroom_id IS NULL)
                      AND (%(assignment_id)s::text IS NULL OR assignment_ids IS NULL OR assignment_ids::jsonb ? %(assignment_id)s::text OR assignment_ids::jsonb = '[]'::jsonb)
                      AND (%(allowed_document_ids)s::text[] IS NULL OR document_id = ANY(%(allowed_document_ids)s::text[]))
                      AND tsv_content @@ plainto_tsquery('english', %(query)s)
                    ORDER BY rank DESC
                    LIMIT %(top_k)s;
                    """,
                    {
                        "query": query,
                        "course_id": eff_course,
                        "university_id": eff_uni,
                        "classroom_id": eff_room,
                        "assignment_id": eff_asg,
                        "allowed_document_ids": list(eff_docs) if eff_docs else None,
                        "top_k": top_k,
                    },
                )
                rows = cur.fetchall()

        results: list[RetrievedChunk] = []
        for r in rows:
            chunk = DocumentChunk(
                chunk_id=r[0],
                university_id=r[1],
                course_id=r[2],
                classroom_id=r[3],
                document_id=r[4],
                title=r[5],
                page_number=r[6],
                section=r[7],
                subsection=r[8],
                concepts=json.loads(r[9]) if isinstance(r[9], str) else (r[9] or []),
                content_type=ContentType(r[10]),
                assignment_ids=json.loads(r[11]) if isinstance(r[11], str) else (r[11] or []),
                chunk_index=r[12],
                created_at=r[13],
                content=r[14],
                token_count=r[15],
            )
            fts_score = float(r[16]) if r[16] is not None else 0.0
            results.append(RetrievedChunk(chunk=chunk, score=fts_score, fts_score=fts_score))

        return results

    def get_chunk(self, chunk_id: str) -> Optional[DocumentChunk]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT chunk_id, university_id, course_id, classroom_id,
                    document_id, title, page_number, section, subsection,
                    concepts, content_type, assignment_ids, chunk_index,
                    created_at, content, token_count
                    FROM document_chunks
                    WHERE chunk_id = %s;
                    """,
                    (chunk_id,),
                )
                r = cur.fetchone()
                if not r:
                    return None
                return DocumentChunk(
                    chunk_id=r[0],
                    university_id=r[1],
                    course_id=r[2],
                    classroom_id=r[3],
                    document_id=r[4],
                    title=r[5],
                    page_number=r[6],
                    section=r[7],
                    subsection=r[8],
                    concepts=json.loads(r[9]) if isinstance(r[9], str) else (r[9] or []),
                    content_type=ContentType(r[10]),
                    assignment_ids=json.loads(r[11]) if isinstance(r[11], str) else (r[11] or []),
                    chunk_index=r[12],
                    created_at=r[13],
                    content=r[14],
                    token_count=r[15],
                )

    def get_document_by_hash(
        self, course_id: str, content_hash: str
    ) -> Optional[DocumentMetadata]:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT document_id, university_id, course_id, classroom_id,
                           uploader_id, filename, file_type, storage_path,
                           upload_date, processing_status, total_pages, total_chunks,
                           extra_metadata
                    FROM documents
                    WHERE course_id = %s
                      AND (extra_metadata->>'content_hash' = %s);
                    """,
                    (course_id, content_hash),
                )
                r = cur.fetchone()
                if not r:
                    return None
                extra = json.loads(r[12]) if isinstance(r[12], str) else (r[12] or {})
                return DocumentMetadata(
                    document_id=r[0],
                    university_id=r[1],
                    course_id=r[2],
                    classroom_id=r[3],
                    uploader_id=r[4],
                    filename=r[5],
                    file_type=r[6],
                    storage_path=r[7],
                    content_hash=extra.get("content_hash", content_hash),
                    upload_date=r[8],
                    processing_status=ProcessingStatus(r[9]),
                    total_pages=r[10],
                    total_chunks=r[11],
                    extra_metadata=extra,
                )

    def delete_document(self, document_id: str) -> bool:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM documents WHERE document_id = %s;", (document_id,))
                return cur.rowcount > 0

    def get_vector_dimension(self) -> Optional[int]:
        """Introspect the actual configured dimension of the `embedding` vector column.

        Used by RAGService startup validation to fail fast when the configured
        embedding dimension does not match the live database schema, instead of
        failing later (and more confusingly) on document insertion.
        Returns None if the dimension cannot be determined (e.g. table missing).
        """
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT atttypmod
                    FROM pg_attribute
                    WHERE attrelid = 'document_chunks'::regclass
                      AND attname = 'embedding'
                      AND NOT attisdropped;
                    """
                )
                r = cur.fetchone()
                if not r or r[0] is None or r[0] <= 0:
                    return None
                return int(r[0])

    def count_chunks(self, course_id: Optional[str] = None) -> int:
        with self._get_connection() as conn:
            with conn.cursor() as cur:
                if course_id:
                    cur.execute(
                        "SELECT COUNT(*) FROM document_chunks WHERE course_id = %s;",
                        (course_id,),
                    )
                else:
                    cur.execute("SELECT COUNT(*) FROM document_chunks;")
                return cur.fetchone()[0]

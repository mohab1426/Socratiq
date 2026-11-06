"""
In-memory vector and full-text search store.

Enforces strict course, classroom, university, assignment, and allowed-document isolation.
Uses cosine similarity for dense retrieval and BM25 / token matching for FTS.
Provides an identical contract to PgVectorStore for testing, CI, and standalone execution.
"""
from __future__ import annotations

import math
from collections import defaultdict
from typing import Optional, Sequence

import numpy as np

from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata, RetrievalScope, RetrievedChunk


class MemoryVectorStore:
    """Zero-external-dependency vector and FTS store with strict multi-tenant scope isolation."""

    def __init__(self) -> None:
        # doc_id -> DocumentMetadata
        self.documents: dict[str, DocumentMetadata] = {}
        # chunk_id -> DocumentChunk
        self.chunks: dict[str, DocumentChunk] = {}
        # course_id -> list of chunk_ids
        self.course_index: dict[str, list[str]] = defaultdict(list)

    def store_document(
        self,
        metadata: DocumentMetadata,
        chunks: list[DocumentChunk],
    ) -> None:
        self.documents[metadata.document_id] = metadata

        # Remove existing chunks for this document if updating
        existing_to_remove = [
            cid for cid, c in self.chunks.items() if c.document_id == metadata.document_id
        ]
        for cid in existing_to_remove:
            chunk = self.chunks.pop(cid, None)
            if chunk and chunk.course_id in self.course_index:
                if cid in self.course_index[chunk.course_id]:
                    self.course_index[chunk.course_id].remove(cid)

        for chunk in chunks:
            self.chunks[chunk.chunk_id] = chunk
            self.course_index[chunk.course_id].append(chunk.chunk_id)

    def _matches_scope(
        self,
        chunk: DocumentChunk,
        course_id: str,
        university_id: Optional[str] = None,
        classroom_id: Optional[str] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
    ) -> bool:
        """Enforces all 5 scope dimensions before candidate scoring."""
        # 1. Course isolation (mandatory)
        if chunk.course_id != course_id:
            return False

        # 2. University isolation (if specified)
        if university_id and chunk.university_id != university_id:
            return False

        # 3. Classroom scoping (if specified, chunk must belong to classroom or be course-wide)
        if classroom_id and chunk.classroom_id not in (None, classroom_id):
            return False

        # 4. Assignment scoping (if specified and chunk has assignment restrictions)
        if assignment_id and chunk.assignment_ids and assignment_id not in chunk.assignment_ids:
            return False

        # 5. Document whitelist scoping (if specified)
        if allowed_document_ids and chunk.document_id not in allowed_document_ids:
            return False

        return True

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
        """Perform dense cosine similarity search scoped strictly to the authorized scope."""
        eff_course = scope.course_id if scope else course_id
        eff_uni = scope.university_id if scope else university_id
        eff_room = scope.classroom_id if scope else classroom_id
        eff_asg = scope.assignment_id if scope else assignment_id
        eff_docs = scope.allowed_document_ids if scope else (tuple(allowed_document_ids) if allowed_document_ids else ())

        if not eff_course:
            raise ValueError("course_id is required for course-scoped retrieval.")

        candidate_ids = self.course_index.get(eff_course, [])
        if not candidate_ids:
            return []

        q_vec = np.array(query_vector, dtype=np.float32)
        q_norm = np.linalg.norm(q_vec)
        if q_norm > 0:
            q_vec = q_vec / q_norm

        scored_candidates: list[tuple[float, DocumentChunk]] = []

        for cid in candidate_ids:
            chunk = self.chunks[cid]

            # Mandatory Multi-Tenant Isolation Filter
            if not self._matches_scope(
                chunk=chunk,
                course_id=eff_course,
                university_id=eff_uni,
                classroom_id=eff_room,
                assignment_id=eff_asg,
                allowed_document_ids=eff_docs,
            ):
                continue

            if not chunk.embedding:
                continue

            c_vec = np.array(chunk.embedding, dtype=np.float32)
            c_norm = np.linalg.norm(c_vec)
            if c_norm > 0:
                c_vec = c_vec / c_norm

            sim = float(np.dot(q_vec, c_vec))
            scored_candidates.append((sim, chunk))

        # Sort descending by cosine similarity
        scored_candidates.sort(key=lambda x: x[0], reverse=True)
        top_candidates = scored_candidates[:top_k]

        return [
            RetrievedChunk(chunk=chunk, score=score, dense_score=score)
            for score, chunk in top_candidates
        ]

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
        """Perform full-text search scoped strictly to the authorized scope."""
        eff_course = scope.course_id if scope else course_id
        eff_uni = scope.university_id if scope else university_id
        eff_room = scope.classroom_id if scope else classroom_id
        eff_asg = scope.assignment_id if scope else assignment_id
        eff_docs = scope.allowed_document_ids if scope else (tuple(allowed_document_ids) if allowed_document_ids else ())

        if not eff_course:
            raise ValueError("course_id is required for course-scoped retrieval.")

        candidate_ids = self.course_index.get(eff_course, [])
        if not candidate_ids:
            return []

        query_terms = [t.lower() for t in query.split() if len(t) > 1]
        if not query_terms:
            return []

        scored_candidates: list[tuple[float, DocumentChunk]] = []

        for cid in candidate_ids:
            chunk = self.chunks[cid]

            # Mandatory Multi-Tenant Isolation Filter
            if not self._matches_scope(
                chunk=chunk,
                course_id=eff_course,
                university_id=eff_uni,
                classroom_id=eff_room,
                assignment_id=eff_asg,
                allowed_document_ids=eff_docs,
            ):
                continue

            # Compute BM25-like lexical relevance score
            search_corpus = f"{chunk.title} {chunk.section or ''} {chunk.content}".lower()
            score = 0.0

            for term in query_terms:
                count = search_corpus.count(term)
                if count > 0:
                    title_bonus = 2.0 if term in (chunk.section or "").lower() else 0.0
                    concept_bonus = 3.0 if any(term in c.lower() for c in chunk.concepts) else 0.0
                    tf = count / (count + 1.2)
                    score += tf + title_bonus + concept_bonus

            if score > 0.0:
                scored_candidates.append((score, chunk))

        scored_candidates.sort(key=lambda x: x[0], reverse=True)
        top_candidates = scored_candidates[:top_k]

        return [
            RetrievedChunk(chunk=chunk, score=score, fts_score=score)
            for score, chunk in top_candidates
        ]

    def get_chunk(self, chunk_id: str) -> Optional[DocumentChunk]:
        return self.chunks.get(chunk_id)

    def get_document_by_hash(
        self, course_id: str, content_hash: str
    ) -> Optional[DocumentMetadata]:
        for doc in self.documents.values():
            if doc.course_id == course_id and doc.content_hash == content_hash:
                return doc
        return None

    def delete_document(self, document_id: str) -> bool:
        if document_id not in self.documents:
            return False

        del self.documents[document_id]
        cids_to_del = [
            cid for cid, c in self.chunks.items() if c.document_id == document_id
        ]
        for cid in cids_to_del:
            chunk = self.chunks.pop(cid, None)
            if chunk and chunk.course_id in self.course_index:
                if cid in self.course_index[chunk.course_id]:
                    self.course_index[chunk.course_id].remove(cid)
        return True

    def count_chunks(self, course_id: Optional[str] = None) -> int:
        if course_id:
            return len(self.course_index.get(course_id, []))
        return len(self.chunks)

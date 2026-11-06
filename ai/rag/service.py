"""
RAG Service facade.

Provides reusable, modular knowledge retrieval and document ingestion APIs for
the Socratic Class AI Coach. Strictly decouples retrieval from AI response generation.
"""
from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path
from typing import Any, BinaryIO, Optional, Sequence, Union

from ai.models.schemas import RetrievedContext
from ai.rag.chunking import StructureAwareChunker
from ai.rag.config import get_rag_config
from ai.rag.embeddings import EmbeddingProvider, get_embedding_provider
from ai.rag.ingestion import (
    DoclingParser,
    DocumentCleaner,
    DocumentParser,
    DocumentStorage,
    PyMuPDF4LLMParser,
    get_document_storage,
    normalize_file_input,
)
from ai.rag.models import (
    DocumentChunk,
    DocumentMetadata,
    IngestionError,
    ProcessingStatus,
    QueryUnderstandingResult,
    RetrievalScope,
    RetrievedChunk,
    SourceReference,
)
from ai.rag.retrieval import (
    HybridRetriever,
    QueryUnderstander,
    RerankerProvider,
    compute_rrf_fusion,
    get_reranker_provider,
)
from ai.rag.security import format_safe_retrieval_context, sanitize_untrusted_text
from ai.rag.storage import VectorStore, get_vector_store
from ai.rag.tracing import rag_traceable

logger = logging.getLogger(__name__)


class RAGService:
    """End-to-end RAG Service providing document ingestion and isolated retrieval."""

    def __init__(
        self,
        vector_store: Optional[VectorStore] = None,
        embedding_provider: Optional[EmbeddingProvider] = None,
        reranker: Optional[RerankerProvider] = None,
        parser: Optional[DocumentParser] = None,
        cleaner: Optional[DocumentCleaner] = None,
        chunker: Optional[StructureAwareChunker] = None,
        storage: Optional[DocumentStorage] = None,
        query_understander: Optional[QueryUnderstander] = None,
        fallback_parser: Optional[DocumentParser] = None,
    ) -> None:
        self.config = get_rag_config()
        self.vector_store = vector_store or get_vector_store()
        # Track whether the caller supplied their own embedding provider (common in
        # unit tests exercising storage/retrieval mechanics with arbitrary vector
        # sizes) vs. relying on the configured factory default (the real production
        # path where a dimension misconfiguration must fail fast).
        _provider_was_injected = embedding_provider is not None
        self.embedding_provider = embedding_provider or get_embedding_provider()
        self.reranker = reranker or get_reranker_provider()
        self.parser = parser or PyMuPDF4LLMParser()
        self.fallback_parser = fallback_parser if fallback_parser is not None else DoclingParser()
        self.cleaner = cleaner or DocumentCleaner()
        self.chunker = chunker or StructureAwareChunker()
        self.storage = storage or get_document_storage()
        self.query_understander = query_understander or QueryUnderstander(use_llm=False)

        self.retriever = HybridRetriever(
            vector_store=self.vector_store,
            embedding_provider=self.embedding_provider,
            reranker=self.reranker,
            dense_top_k=self.config.dense_top_k,
            fts_top_k=self.config.fts_top_k,
            rrf_k=self.config.rrf_k,
            final_top_k=self.config.rerank_top_k,
        )

        self._validate_embedding_dimensions(check_provider_vs_config=not _provider_was_injected)

    def _validate_embedding_dimensions(self, check_provider_vs_config: bool = True) -> None:
        """Fail fast on embedding dimension mismatches.

        Verifies that:
        1. configured RAG embedding dimension == provider dimension (only when
           the provider came from the configured factory default; a caller
           who explicitly injects a provider — e.g. tests exercising storage
           or retrieval mechanics with an arbitrary vector size — is making
           a deliberate choice that isn't a misconfiguration)
        2. provider dimension == database vector column dimension (when the
           live schema dimension can be introspected, e.g. PgVectorStore).
           This check always runs, since a real database's schema
           disagreeing with whatever provider is in use is a genuine bug
           regardless of how the provider was constructed.

        Raising here at service construction time means a dimension
        misconfiguration surfaces immediately at startup rather than as a
        cryptic pgvector error partway through document insertion.
        """
        configured_dim = self.config.embedding_dim
        provider_dim = getattr(self.embedding_provider, "dimension", None)

        if check_provider_vs_config and provider_dim is not None and provider_dim != configured_dim:
            raise ValueError(
                "Embedding dimension mismatch: configured RAG_EMBEDDING_DIM="
                f"{configured_dim} but embedding provider "
                f"'{type(self.embedding_provider).__name__}' produces "
                f"{provider_dim}-dimensional vectors. These must match."
            )

        get_db_dim = getattr(self.vector_store, "get_vector_dimension", None)
        if callable(get_db_dim):
            try:
                db_dim = get_db_dim()
            except Exception as exc:  # pragma: no cover - defensive, DB may be unreachable
                logger.warning(
                    "Could not introspect vector store dimension for startup validation: %s",
                    exc,
                )
                db_dim = None

            expected_dim = provider_dim if provider_dim is not None else configured_dim
            if db_dim is not None and db_dim != expected_dim:
                raise ValueError(
                    f"Embedding dimension mismatch: embedding provider "
                    f"'{type(self.embedding_provider).__name__}' produces "
                    f"{expected_dim}-dimensional vectors but the database "
                    f"vector column is {db_dim}-dimensional. Run a migration "
                    "to align the `embedding` column dimension with the "
                    "embedding provider, or update RAG_EMBEDDING_DIM."
                )

    # -------------------------------------------------------------------------
    # Ingestion Pipeline Spans
    # -------------------------------------------------------------------------

    @rag_traceable(name="rag.ingestion.parse", run_type="parser")
    def _parse_document(
        self, content_bytes: bytes, resolved_title: str, metadata: DocumentMetadata
    ) -> Any:
        parsed_doc = self.parser.parse(content_bytes, title=resolved_title)
        metadata.total_pages = parsed_doc.total_pages

        extra_meta = metadata.extra_metadata or {}
        is_flagged = bool(
            extra_meta.get("heavy_tables")
            or extra_meta.get("scanned_pages")
            or extra_meta.get("force_docling")
        )
        raw_text_len = len(parsed_doc.raw_markdown.strip())
        avg_chars = (
            raw_text_len / max(1, parsed_doc.total_pages)
            if parsed_doc.total_pages > 0
            else 0
        )
        is_degraded = (parsed_doc.total_pages > 0 and avg_chars < 100) or is_flagged

        if is_degraded and self.fallback_parser is not None:
            logger.info(
                "Primary parser output degraded or flagged (avg_chars=%.1f, flagged=%s). "
                "Invoking fallback parser (%s).",
                avg_chars,
                is_flagged,
                type(self.fallback_parser).__name__,
            )
            try:
                fallback_doc = self.fallback_parser.parse(
                    content_bytes, title=resolved_title
                )
                if len(fallback_doc.raw_markdown.strip()) > raw_text_len:
                    parsed_doc = fallback_doc
                    metadata.total_pages = parsed_doc.total_pages
                    metadata.extra_metadata["fallback_parser_used"] = type(
                        self.fallback_parser
                    ).__name__
            except Exception as fb_err:
                logger.warning(
                    "Fallback parser failed (%s); retaining primary parser output.",
                    fb_err,
                )

        if parsed_doc.total_pages == 0 or not parsed_doc.raw_markdown.strip():
            raise IngestionError(
                f"Document {metadata.filename} contains no extractable pages or text content."
            )

        return parsed_doc

    @rag_traceable(name="rag.ingestion.clean", run_type="tool")
    def _clean_document(self, parsed_doc: Any) -> Any:
        return self.cleaner.clean_document(parsed_doc)

    @rag_traceable(name="rag.ingestion.chunk", run_type="tool")
    def _chunk_document(
        self, cleaned_doc: Any, metadata: DocumentMetadata
    ) -> list[DocumentChunk]:
        chunks = self.chunker.chunk_document(cleaned_doc, metadata)
        if not chunks:
            raise IngestionError(
                f"Document {metadata.filename} yielded 0 chunks after parsing and cleaning."
            )
        return chunks

    @rag_traceable(name="rag.ingestion.embed", run_type="embedding")
    def _embed_chunks(self, chunks: list[DocumentChunk]) -> None:
        chunk_texts = [c.content for c in chunks]
        if chunk_texts:
            embeddings = self.embedding_provider.embed_documents(chunk_texts)
            for chk, emb in zip(chunks, embeddings):
                chk.embedding = emb

    @rag_traceable(name="rag.ingest_document", run_type="chain")
    def ingest_document(
        self,
        file_input: Union[str, Path, bytes, BinaryIO],
        university_id: str,
        course_id: str,
        classroom_id: Optional[str] = None,
        uploader_id: Optional[str] = None,
        filename: Optional[str] = None,
        title: Optional[str] = None,
        assignment_ids: Optional[list[str]] = None,
        force: bool = False,
    ) -> DocumentMetadata:
        """Ingest, clean, chunk, embed, and index a course document."""
        if not university_id or not course_id:
            raise ValueError("university_id and course_id are required for ingestion.")

        # Canonical normalization to avoid stream exhaustion across components
        content_bytes, resolved_filename = normalize_file_input(
            file_input, default_filename=filename
        )
        resolved_title = title or Path(resolved_filename).stem.replace("_", " ").title()

        if not content_bytes or len(content_bytes) < 10:
            raise IngestionError(f"Document {resolved_filename} is empty or corrupt (<10 bytes).")

        content_hash = hashlib.sha256(content_bytes).hexdigest()

        # Idempotency guard: Return existing metadata if already indexed
        if not force:
            existing_doc = self.vector_store.get_document_by_hash(
                course_id=course_id, content_hash=content_hash
            )
            if existing_doc and existing_doc.processing_status == ProcessingStatus.STORED:
                logger.info(
                    "Document %s already ingested for course %s with content hash %s. Returning existing metadata.",
                    existing_doc.document_id,
                    course_id,
                    content_hash,
                )
                return existing_doc

        deterministic_doc_id = f"doc_{hashlib.sha256(f'{university_id}:{course_id}:{content_hash}'.encode()).hexdigest()[:12]}"

        metadata = DocumentMetadata(
            document_id=deterministic_doc_id,
            university_id=university_id,
            course_id=course_id,
            classroom_id=classroom_id,
            uploader_id=uploader_id,
            filename=resolved_filename,
            file_type="pdf",
            content_hash=content_hash,
            processing_status=ProcessingStatus.PARSING,
            extra_metadata={"assignment_ids": assignment_ids or []},
        )

        storage_path: Optional[str] = None
        try:
            # 1. Store raw document via storage engine
            storage_path = self.storage.save(metadata, content_bytes)
            metadata.storage_path = storage_path

            # 2. Parse PDF with structure preservation (PyMuPDF4LLM primary + Docling fallback)
            parsed_doc = self._parse_document(content_bytes, resolved_title, metadata)
            metadata.processing_status = ProcessingStatus.CHUNKING

            # 3. Clean extracted text
            cleaned_doc = self._clean_document(parsed_doc)

            # 4. Structure-aware chunking & concept extraction
            chunks = self._chunk_document(cleaned_doc, metadata)
            metadata.total_chunks = len(chunks)

            if assignment_ids:
                for chk in chunks:
                    chk.assignment_ids = list(assignment_ids)

            # 5. Generate embeddings
            metadata.processing_status = ProcessingStatus.EMBEDDING
            self._embed_chunks(chunks)

            # 6. Store chunks in vector store
            self.vector_store.store_document(metadata, chunks)
            metadata.processing_status = ProcessingStatus.STORED
            logger.info(
                "Successfully ingested document %s (%d pages, %d chunks)",
                metadata.document_id,
                metadata.total_pages,
                metadata.total_chunks,
            )
            return metadata

        except Exception as exc:
            metadata.processing_status = ProcessingStatus.FAILED
            logger.exception("Document ingestion failed for %s: %s", resolved_filename, exc)
            if storage_path:
                try:
                    self.storage.delete(storage_path)
                    metadata.storage_path = None
                except Exception as del_err:
                    logger.warning("Failed to clean up stored file %s: %s", storage_path, del_err)
            raise IngestionError(f"Ingestion failed: {exc}") from exc

    # -------------------------------------------------------------------------
    # Retrieval Pipeline
    # -------------------------------------------------------------------------

    @rag_traceable(name="rag.retrieve_course_material", run_type="retriever")
    def retrieve_course_material(
        self,
        course_id: Optional[Union[str, RetrievalScope]] = None,
        query: str = "",
        top_k: int = 4,
        classroom_id: Optional[str] = None,
        university_id: Optional[str] = None,
        assignment_id: Optional[str] = None,
        allowed_document_ids: Optional[Sequence[str]] = None,
        scope: Optional[RetrievalScope] = None,
        student_context: Optional[dict[str, Any]] = None,
    ) -> list[RetrievedContext]:
        """Primary scoped retrieval function for the AI Coach.

        Supports both trusted `RetrievalScope` and individual tenant parameters.
        Returns a list of `RetrievedContext` objects compatible with Coach LangGraph nodes,
        with strict multi-tenant isolation and comprehensive source citations.
        """
        start_time = time.perf_counter()

        # Handle scope passed as first positional parameter
        if isinstance(course_id, RetrievalScope):
            scope = course_id
            resolved_course_id = scope.course_id
        else:
            resolved_course_id = (scope.course_id if scope else course_id) or ""

        if not resolved_course_id:
            raise ValueError("course_id is required for course-scoped retrieval.")

        resolved_uni = scope.university_id if scope else university_id
        resolved_room = scope.classroom_id if scope else classroom_id
        resolved_asg = scope.assignment_id if scope else assignment_id
        resolved_docs = scope.allowed_document_ids if scope else (tuple(allowed_document_ids) if allowed_document_ids else ())

        if scope is None and resolved_uni:
            scope = RetrievalScope(
                university_id=resolved_uni,
                course_id=resolved_course_id,
                classroom_id=resolved_room,
                assignment_id=resolved_asg,
                allowed_document_ids=resolved_docs,
            )

        search_query = query
        # Optional query understanding if student context is supplied.
        #
        # P1 fix: previously, whenever `student_context` was truthy this
        # unconditionally overwrote `search_query` with
        # `qu_result.retrieval_query`, silently discarding any richer query
        # the caller had already constructed (e.g. the Coach's
        # `build_retrieval_query()`, which folds in assignment title/
        # instructions, diagnosed concept/explanation/evidence, and recent
        # conversation turns). Since Coach retrieval always supplies
        # `student_context`, that discard happened on essentially every
        # production retrieval call.
        #
        # Callers now mark an already-fully-formed query explicitly via
        # `student_context["query_is_final"]` (see
        # `ai.agents.coach.nodes.build_student_context_adapter`). When set,
        # QueryUnderstander still runs -- but only to decide whether
        # retrieval is needed at all -- and its `retrieval_query` is never
        # used to replace the caller's query. Callers that pass a bare
        # query (no pre-built query, e.g. simple/legacy call sites) keep the
        # old enrichment behavior unchanged.
        if student_context:
            qu_result = self.query_understander.understand(
                student_message=student_context.get("message") or query,
                student_attempt=student_context.get("attempt", ""),
                assignment_title=student_context.get("assignment_title"),
                assignment_instructions=student_context.get("assignment_instructions"),
                prior_diagnosis=student_context.get("prior_diagnosis"),
                is_programming=student_context.get("is_programming", False),
            )
            if not qu_result.needs_retrieval:
                logger.info("Query understanding determined retrieval is not needed.")
                return []

            query_is_final = bool(student_context.get("query_is_final")) and bool(query.strip())
            if not query_is_final:
                search_query = qu_result.retrieval_query

        # Execute hybrid retrieval + RRF + reranker with pre-ranking scoping
        retrieved_chunks = self.retriever.retrieve(
            course_id=resolved_course_id,
            query=search_query,
            classroom_id=resolved_room,
            university_id=resolved_uni,
            top_k=top_k,
            assignment_id=resolved_asg,
            allowed_document_ids=resolved_docs,
            scope=scope,
        )

        latency_ms = (time.perf_counter() - start_time) * 1000
        logger.info(
            "Retrieved %d chunks for course %s (query: '%s') in %.1f ms",
            len(retrieved_chunks),
            resolved_course_id,
            search_query[:60],
            latency_ms,
        )

        return self.to_retrieved_contexts(retrieved_chunks)

    def retrieve_scoped(
        self,
        scope: RetrievalScope,
        query: str,
        top_k: int = 4,
    ) -> list[RetrievedContext]:
        """Convenience method for retrieving strictly within a trusted RetrievalScope."""
        return self.retrieve_course_material(scope=scope, query=query, top_k=top_k)

    @rag_traceable(name="rag.retrieval.dense", run_type="retriever")
    def search_dense(
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
        """Expose raw dense search for testing or custom workflows."""
        q_vec = self.embedding_provider.embed_query(query)
        return self.vector_store.search_dense(
            course_id=course_id,
            query_vector=q_vec,
            top_k=top_k,
            classroom_id=classroom_id,
            university_id=university_id,
            assignment_id=assignment_id,
            allowed_document_ids=allowed_document_ids,
            scope=scope,
        )

    @rag_traceable(name="rag.retrieval.fts", run_type="retriever")
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
        """Expose raw FTS search for testing or custom workflows."""
        return self.vector_store.search_fts(
            course_id=course_id,
            query=query,
            top_k=top_k,
            classroom_id=classroom_id,
            university_id=university_id,
            assignment_id=assignment_id,
            allowed_document_ids=allowed_document_ids,
            scope=scope,
        )

    def fuse_results(
        self,
        dense_candidates: list[RetrievedChunk],
        fts_candidates: list[RetrievedChunk],
        rrf_k: int = 60,
    ) -> list[RetrievedChunk]:
        """Expose RRF fusion function."""
        return compute_rrf_fusion(dense_candidates, fts_candidates, rrf_k=rrf_k)

    def rerank_results(
        self,
        query: str,
        candidates: list[RetrievedChunk],
        top_k: int = 5,
    ) -> list[RetrievedChunk]:
        """Expose reranker function."""
        return self.reranker.rerank(query, candidates, top_k=top_k)

    def build_retrieval_context(
        self,
        chunks: Sequence[Union[RetrievedChunk, DocumentChunk]],
    ) -> str:
        """Format chunks into safe passive text reference blocks."""
        return format_safe_retrieval_context(chunks)

    # -------------------------------------------------------------------------
    # Educational Context Helpers
    # -------------------------------------------------------------------------

    def get_assignment_context(
        self,
        assignment_id: str,
        assignment_store: Optional[dict[str, Any]] = None,
    ) -> Optional[dict[str, Any]]:
        """Retrieve assignment instructions and metadata."""
        if assignment_store and assignment_id in assignment_store:
            return assignment_store[assignment_id]
        return None

    def get_assignment_policy(
        self,
        assignment_id: str,
        assignment_store: Optional[dict[str, Any]] = None,
    ) -> str:
        """Retrieve pedagogical assistance policy ('GUIDED', 'ASSISTED', 'OPEN')."""
        ctx = self.get_assignment_context(assignment_id, assignment_store)
        if ctx and "policy" in ctx:
            return str(ctx["policy"])
        return "GUIDED"

    def get_student_attempt(
        self,
        session_id: str,
        attempt_store: Optional[dict[str, Any]] = None,
    ) -> Optional[str]:
        """Retrieve latest student attempt text/code."""
        if attempt_store and session_id in attempt_store:
            return attempt_store[session_id].get("attempt")
        return None

    def get_student_learning_context(
        self,
        student_id: str,
        course_id: str,
        concept: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        """Retrieve student's recent learning history for concept/course."""
        return []

    # -------------------------------------------------------------------------
    # Format Conversion
    # -------------------------------------------------------------------------

    @staticmethod
    def to_retrieved_contexts(retrieved_chunks: list[RetrievedChunk]) -> list[RetrievedContext]:
        """Convert internal `RetrievedChunk` models into domain `RetrievedContext` models.

        Sanitizes chunk text against prompt injection for defense-in-depth before
        passing content to LLM prompts.
        """
        contexts: list[RetrievedContext] = []
        for rc in retrieved_chunks:
            chunk = rc.chunk
            source_citation = (
                f"{chunk.title} [p. {chunk.page_number}, {chunk.section or 'Section'}]"
            )
            metadata = {
                "chunk_id": chunk.chunk_id,
                "document_id": chunk.document_id,
                "course_id": chunk.course_id,
                "classroom_id": chunk.classroom_id,
                "university_id": chunk.university_id,
                "assignment_ids": chunk.assignment_ids,
                "title": chunk.title,
                "page_number": chunk.page_number,
                "section": chunk.section,
                "subsection": chunk.subsection,
                "concepts": chunk.concepts,
                "content_type": chunk.content_type.value,
                "score": rc.score,
                "dense_score": rc.dense_score,
                "fts_score": rc.fts_score,
                "rrf_score": rc.rrf_score,
                "rerank_score": rc.rerank_score,
                "source_reference": rc.source_reference.model_dump(),
            }
            contexts.append(
                RetrievedContext(
                    source=source_citation,
                    content=sanitize_untrusted_text(chunk.content),
                    metadata=metadata,
                )
            )
        return contexts


_default_rag_service: Optional[RAGService] = None


def get_rag_service() -> RAGService:
    """Return shared RAG service instance."""
    global _default_rag_service
    if _default_rag_service is None:
        _default_rag_service = RAGService()
    return _default_rag_service

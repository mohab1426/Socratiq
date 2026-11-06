"""
Regression tests for Arabic / mixed-language retrieval (P1 #4).

PostgreSQL FTS in this project is configured with the `english` text-search
config (see database/migrations/001_rag_pgvector_schema.sql), which offers
no genuine Arabic stemming/normalization. Rather than pretend otherwise,
`HybridRetriever` treats Arabic-dominant queries as a dense-only retrieval
path (see ai/rag/language.py + ai/rag/retrieval/hybrid_retriever.py) while
leaving English queries/content on the full hybrid path.
"""
from __future__ import annotations

from ai.rag.embeddings.mock import MockEmbeddingProvider
from ai.rag.language import arabic_char_ratio, is_arabic_dominant, normalize_arabic_text
from ai.rag.models import ContentType, DocumentChunk, DocumentMetadata, ProcessingStatus
from ai.rag.retrieval.hybrid_retriever import HybridRetriever
from ai.rag.storage.memory import MemoryVectorStore


# ---------------------------------------------------------------------------
# ai.rag.language unit tests
# ---------------------------------------------------------------------------

def test_arabic_char_ratio_detects_arabic_dominant_text():
    assert arabic_char_ratio("اشرحلي مفهوم لو سمحت overfitting") > 0.5
    assert arabic_char_ratio("explain overfitting to me") == 0.0
    assert arabic_char_ratio("") == 0.0
    assert arabic_char_ratio("123 456") == 0.0  # no letters at all


def test_is_arabic_dominant_threshold_behavior():
    assert is_arabic_dominant("ايه الفرق بين precision و recall؟")
    assert is_arabic_dominant("ليه الموديل بيعمل overfit؟")
    assert not is_arabic_dominant("what is the difference between precision and recall?")
    # A short embedded Arabic word inside a mostly-English sentence should
    # not flip the whole query to Arabic-dominant.
    assert not is_arabic_dominant("Can you explain the concept of معلومة briefly in English?")


def test_normalize_arabic_text_strips_diacritics_and_normalizes_letters():
    diacritized = "اشْرَحْلي مفهوم overfitting"
    normalized = normalize_arabic_text(diacritized)
    assert "\u0650" not in normalized  # kasra removed
    assert "\u064E" not in normalized  # fatha removed

    # Hamza-on-alef variants normalize to plain alef.
    assert normalize_arabic_text("أهلا إخوان آمين") == "اهلا اخوان امين"

    # English text is untouched.
    assert normalize_arabic_text("overfitting and underfitting") == "overfitting and underfitting"


# ---------------------------------------------------------------------------
# HybridRetriever: Arabic-dominant queries skip FTS, English queries don't
# ---------------------------------------------------------------------------

def _seeded_store_and_embeddings():
    store = MemoryVectorStore()
    embeddings = MockEmbeddingProvider(dimension=128)
    doc = DocumentMetadata(
        document_id="doc_of",
        university_id="univ_1",
        course_id="course_ml",
        classroom_id=None,
        filename="overfitting.pdf",
        processing_status=ProcessingStatus.STORED,
        storage_path="hi",
    )
    content_en = "Overfitting occurs when a model learns noise in the training data."
    content_ar = "الموديل بيعمل overfit لما بيتعلم التفاصيل الدقيقة أو الضوضاء الموجودة في بيانات التدريب."
    chunks = [
        DocumentChunk(
            chunk_id="chk_of_en",
            university_id="univ_1",
            course_id="course_ml",
            classroom_id=None,
            document_id="doc_of",
            title="Overfitting",
            page_number=1,
            section="Definitions",
            concepts=["overfitting"],
            content_type=ContentType.EXPLANATION,
            content=content_en,
            embedding=embeddings.embed_documents([content_en])[0],
        ),
        DocumentChunk(
            chunk_id="chk_of_ar",
            university_id="univ_1",
            course_id="course_ml",
            classroom_id=None,
            document_id="doc_of",
            title="Overfitting (Arabic notes)",
            page_number=2,
            section="Definitions",
            concepts=["overfitting"],
            content_type=ContentType.EXPLANATION,
            content=content_ar,
            embedding=embeddings.embed_documents([content_ar])[0],
        ),
    ]
    store.store_document(doc, chunks)
    return store, embeddings


def test_hybrid_retriever_skips_fts_for_arabic_dominant_query(monkeypatch):
    store, embeddings = _seeded_store_and_embeddings()
    retriever = HybridRetriever(vector_store=store, embedding_provider=embeddings)

    fts_calls = []
    original_search_fts = store.search_fts

    def spying_search_fts(*args, **kwargs):
        fts_calls.append((args, kwargs))
        return original_search_fts(*args, **kwargs)

    monkeypatch.setattr(store, "search_fts", spying_search_fts)

    results = retriever.retrieve(course_id="course_ml", query="ليه الموديل بيعمل overfit؟")

    assert not fts_calls, "FTS must be skipped entirely for an Arabic-dominant query."
    assert results, "Dense retrieval should still surface results for the Arabic query."


def test_hybrid_retriever_keeps_fts_for_english_query(monkeypatch):
    store, embeddings = _seeded_store_and_embeddings()
    retriever = HybridRetriever(vector_store=store, embedding_provider=embeddings)

    fts_calls = []
    original_search_fts = store.search_fts

    def spying_search_fts(*args, **kwargs):
        fts_calls.append((args, kwargs))
        return original_search_fts(*args, **kwargs)

    monkeypatch.setattr(store, "search_fts", spying_search_fts)

    results = retriever.retrieve(course_id="course_ml", query="what causes overfitting?")

    assert fts_calls, "English queries must keep using FTS as part of the hybrid path."
    assert results

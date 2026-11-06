"""
Unit tests for SupabaseDocumentStorage and storage backend switching.

Verifies:
- SupabaseDocumentStorage adheres to DocumentStorage protocol.
- save(), load(), delete() operate via HTTP REST against Supabase Storage API.
- Graceful fallback to LocalFileStorage when unconfigured or upon request failure.
- get_document_storage() factory selects the configured backend via RAGConfig.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from ai.rag.ingestion.storage import (
    DocumentStorage,
    LocalFileStorage,
    SupabaseDocumentStorage,
    get_document_storage,
)
from ai.rag.models import DocumentMetadata, ProcessingStatus


def test_supabase_storage_protocol_conformance():
    storage = SupabaseDocumentStorage(
        supabase_url="https://xyz.supabase.co",
        supabase_key="test-api-key",
        bucket_name="course-bucket",
    )
    assert isinstance(storage, DocumentStorage)
    assert storage.is_configured() is True


def test_supabase_storage_unconfigured_detection():
    storage = SupabaseDocumentStorage(supabase_url=None, supabase_key=None)
    assert storage.is_configured() is False


def test_supabase_storage_save_success():
    storage = SupabaseDocumentStorage(
        supabase_url="https://xyz.supabase.co",
        supabase_key="secret-key-123",
        bucket_name="course-bucket",
    )

    metadata = DocumentMetadata(
        document_id="doc_test_123",
        university_id="stanford",
        course_id="cs101",
        classroom_id="room_1",
        filename="notes.pdf",
    )

    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.raise_for_status = MagicMock()

    with patch("httpx.post", return_value=fake_response) as mock_post:
        result = storage.save(metadata, b"%PDF-test-data")

        assert result == "supabase://course-bucket/stanford/cs101/room_1/doc_test_123_notes.pdf"
        mock_post.assert_called_once()
        args, kwargs = mock_post.call_args
        assert args[0] == "https://xyz.supabase.co/storage/v1/object/course-bucket/stanford/cs101/room_1/doc_test_123_notes.pdf"
        assert kwargs["headers"]["Authorization"] == "Bearer secret-key-123"
        assert kwargs["headers"]["apikey"] == "secret-key-123"
        assert kwargs["content"] == b"%PDF-test-data"


def test_supabase_storage_load_success():
    storage = SupabaseDocumentStorage(
        supabase_url="https://xyz.supabase.co",
        supabase_key="secret-key-123",
        bucket_name="course-bucket",
    )

    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.content = b"%PDF-loaded-bytes"
    fake_response.raise_for_status = MagicMock()

    with patch("httpx.get", return_value=fake_response) as mock_get:
        loaded = storage.load("supabase://course-bucket/stanford/cs101/all_classrooms/doc_abc_file.pdf")
        assert loaded == b"%PDF-loaded-bytes"
        mock_get.assert_called_once()
        args, kwargs = mock_get.call_args
        assert args[0] == "https://xyz.supabase.co/storage/v1/object/authenticated/course-bucket/stanford/cs101/all_classrooms/doc_abc_file.pdf"


def test_supabase_storage_delete_success():
    storage = SupabaseDocumentStorage(
        supabase_url="https://xyz.supabase.co",
        supabase_key="secret-key-123",
        bucket_name="course-bucket",
    )

    fake_response = MagicMock()
    fake_response.status_code = 200

    with patch("httpx.delete", return_value=fake_response) as mock_delete:
        success = storage.delete("supabase://course-bucket/stanford/cs101/all_classrooms/doc_abc_file.pdf")
        assert success is True
        mock_delete.assert_called_once()


def test_supabase_storage_unconfigured_fallback_to_local(tmp_path, monkeypatch):
    monkeypatch.setenv("RAG_STORAGE_FALLBACK_ON_ERROR", "true")

    import ai.rag.config
    ai.rag.config._default_rag_config = None

    storage = SupabaseDocumentStorage(supabase_url=None, supabase_key=None)
    storage._fallback.base_dir = tmp_path

    metadata = DocumentMetadata(
        document_id="doc_local_fallback",
        university_id="mit",
        course_id="math18",
        filename="algebra.pdf",
    )

    saved_path = storage.save(metadata, b"%PDF-fallback-content")
    assert not saved_path.startswith("supabase://")
    assert Path(saved_path).is_file()

    loaded = storage.load(saved_path)
    assert loaded == b"%PDF-fallback-content"

    assert storage.delete(saved_path) is True
    assert not Path(saved_path).is_file()


def test_factory_switching(monkeypatch):
    import ai.rag.config

    # Test local backend default
    monkeypatch.setenv("RAG_STORAGE_BACKEND", "local")
    ai.rag.config._default_rag_config = None
    storage = get_document_storage()
    assert isinstance(storage, LocalFileStorage)

    # Test supabase backend when configured
    monkeypatch.setenv("RAG_STORAGE_BACKEND", "supabase")
    monkeypatch.setenv("SUPABASE_URL", "https://xyz.supabase.co")
    monkeypatch.setenv("SUPABASE_KEY", "key-123")
    ai.rag.config._default_rag_config = None
    storage_sb = get_document_storage()
    assert isinstance(storage_sb, SupabaseDocumentStorage)
    assert storage_sb.is_configured() is True

    # Reset config back to default
    ai.rag.config._default_rag_config = None

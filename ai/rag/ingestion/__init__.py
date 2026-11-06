"""
Ingestion package for document parsing, cleaning, and storage.
"""
from ai.rag.ingestion.cleaner import DocumentCleaner
from ai.rag.ingestion.parser import (
    DoclingParser,
    DocumentParser,
    ParsedDocument,
    ParsedPage,
    PyMuPDF4LLMParser,
)
from ai.rag.ingestion.storage import (
    DocumentStorage,
    LocalFileStorage,
    SupabaseDocumentStorage,
    SupabaseStorage,
    get_document_storage,
    normalize_file_input,
)

__all__ = [
    "DoclingParser",
    "DocumentParser",
    "ParsedDocument",
    "ParsedPage",
    "PyMuPDF4LLMParser",
    "DocumentCleaner",
    "DocumentStorage",
    "LocalFileStorage",
    "SupabaseDocumentStorage",
    "SupabaseStorage",
    "get_document_storage",
    "normalize_file_input",
]

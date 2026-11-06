from __future__ import annotations

import importlib
import inspect
import re

import pytest

pytestmark = pytest.mark.database

def test_ai_core_modules_import(project_root):
    modules = [
        "ai.models.schemas",
        "ai.contracts.coach_contract",
        "ai.rag.models",
        "ai.rag.config",
        "ai.rag.retrieval.hybrid_retriever",
        "ai.rag.storage.pgvector",
        "ai.verification.models",
        "ai.verification.service",
        "ai.tools.student_history",
        "ai.tools.assignment_context",
    ]
    failures = []
    for name in modules:
        try:
            importlib.import_module(name)
        except Exception as exc:
            failures.append(f"{name}: {type(exc).__name__}: {exc}")
    assert not failures, "IMPORT_FAIL\n" + "\n".join(failures)

def test_expected_ai_enums_are_present():
    from ai.rag.models import ProcessingStatus, ContentType
    from ai.models.schemas import LearningEventType, DiagnosisCategory
    from ai.models.schemas import AssistancePolicy, InterventionType
    from ai.models.schemas import EvidenceType, EvidenceStrength
    from ai.verification.models import VerificationType, VerificationOutcome

    assert {x.value for x in ProcessingStatus} == {
        "pending","parsing","chunking","embedding","stored","failed"
    }
    assert {x.value for x in ContentType} == {
        "definition","explanation","example","code","formula","table",
        "summary","exercise"
    }
    assert {x.value for x in LearningEventType} == {
        "ATTEMPT","AI_INTERACTION","REVISION","SUBMISSION","VERIFICATION"
    }
    assert {x.value for x in AssistancePolicy} == {"GUIDED","ASSISTED","OPEN"}
    assert {x.value for x in InterventionType} == {
        "QUESTION","HINT","EXPLANATION","GUIDED_DEBUGGING",
        "FEEDBACK","CLARIFICATION","ENCOURAGEMENT"
    }
    assert {x.value for x in VerificationType} == {"EXPLAIN","MODIFY","TRANSFER"}
    assert {x.value for x in VerificationOutcome} == {
        "PASS","PARTIAL","NEEDS_RETRY","INSUFFICIENT_EVIDENCE"
    }
    assert {x.value for x in EvidenceType} == {
        "UNDERSTANDING","MISCONCEPTION","REVISION",
        "INDEPENDENCE","EXPLANATION","TRANSFER"
    }
    assert {x.value for x in EvidenceStrength} == {"WEAK","MODERATE","STRONG"}

def test_ai_contract_ids_are_strings():
    from ai.models.schemas import LearningEvent, AIInteraction
    from ai.verification.models import VerificationResult

    for cls in (LearningEvent, AIInteraction, VerificationResult):
        source = inspect.getsource(cls)
        assert re.search(r":\s*str\b", source), f"CONTRACT_FAIL inspect {cls.__name__}"

def test_rag_models_expose_required_fields():
    from ai.rag.models import DocumentMetadata, DocumentChunk, RetrievalScope

    for cls, fields in {
        DocumentMetadata: [
            "document_id","university_id","course_id","classroom_id",
            "filename","file_type","storage_path","processing_status",
        ],
        DocumentChunk: [
            "chunk_id","document_id","university_id","course_id",
            "content","embedding","concepts","assignment_ids","content_type",
        ],
        RetrievalScope: [
            "university_id","course_id","classroom_id",
            "assignment_id","allowed_document_ids",
        ],
    }.items():
        names = set(getattr(cls, "model_fields", getattr(cls, "__annotations__", {})))
        missing = [f for f in fields if f not in names]
        assert not missing, f"CONTRACT_FAIL {cls.__name__}: missing {missing}"

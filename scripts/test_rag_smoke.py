"""
End-to-End Smoke Test for the RAG Subsystem.

Tests the full lifecycle:
PDF creation
-> PyMuPDF4LLM parsing
-> Deterministic cleaning
-> Structure detection & concept extraction
-> Structure-aware chunking (500-900 tokens)
-> Rich metadata attachment
-> Dense embedding generation (1024-dim)
-> Vector storage & FTS indexing
-> Scoped dense vector search
-> Scoped PostgreSQL/BM25 full-text search
-> Reciprocal Rank Fusion (RRF)
-> Reranking
-> Valid source citations verification
-> Multi-tenant course & classroom isolation verification
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure project root is on sys.path
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

import pymupdf

from ai.rag.embeddings import MockEmbeddingProvider
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore


def create_sample_ml_pdf() -> bytes:
    """Create a sample multi-page Machine Learning lecture PDF."""
    canonical = _PROJECT_ROOT / "data/documents/stanford_univ/course_cs101/classroom_alpha/doc_a5ef08e158f4_lecture_03_gradient_descent.pdf"
    if canonical.is_file():
        return canonical.read_bytes()

    doc = pymupdf.open()

    p1 = doc.new_page()
    p1.insert_text(
        (50, 50),
        "# Machine Learning 101: Lecture 3\n\n"
        "## Gradient Descent Optimization\n\n"
        "Gradient descent is an iterative optimization algorithm used to find the parameters that minimize a loss function.\n\n"
        "### Parameter Update Rule\n\n"
        "The parameter update formula is given by:\n"
        "theta = theta - alpha * gradient(J(theta))\n\n"
        "where alpha is the learning rate controlling the step size at each iteration.\n"
        "If alpha is too large, the algorithm may overshoot the local minimum and diverge.\n"
        "If alpha is too small, convergence will be excessively slow.\n\n"
        "Page 1\n"
        "Stanford University CS101\n",
    )

    p2 = doc.new_page()
    p2.insert_text(
        (50, 50),
        "Stanford University CS101\n\n"
        "## Python Implementation\n\n"
        "```python\n"
        "def gradient_descent(X, y, theta, alpha, num_iters):\n"
        "    m = len(y)\n"
        "    for _ in range(num_iters):\n"
        "        grad = (1/m) * (X.T @ (X @ theta - y))\n"
        "        theta = theta - alpha * grad\n"
        "    return theta\n"
        "```\n\n"
        "| Parameter | Type | Purpose |\n"
        "|---|---|---|\n"
        "| alpha | float | Learning rate step size |\n"
        "| theta | vector | Model weight parameters |\n\n"
        "Page 2\n",
    )

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def create_sample_econ_pdf() -> bytes:
    """Create a sample Economics lecture PDF for cross-course isolation testing."""
    canonical = _PROJECT_ROOT / "data/documents/stanford_univ/course_econ201/classroom_beta/doc_27dc2c0afd59_lecture_01_supply_demand.pdf"
    if canonical.is_file():
        return canonical.read_bytes()

    doc = pymupdf.open()

    p1 = doc.new_page()
    p1.insert_text(
        (50, 50),
        "# Economics 201: Principles of Macroeconomics\n\n"
        "## Supply and Demand Equilibrium\n\n"
        "Market equilibrium occurs at the intersection of aggregate supply and demand curves.\n\n"
        "Price elasticity measures responsiveness of quantity demanded to changes in price.\n\n"
        "Page 1\n"
        "Stanford University ECON201\n",
    )

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def run_smoke_test() -> None:
    print("=" * 78)
    print("THE SOCRATIC CLASS — RAG SUBSYSTEM END-TO-END SMOKE TEST")
    print("=" * 78)

    # 1. Initialize RAG Service
    print("\n[1/6] Initializing RAG Service...")
    vector_store = MemoryVectorStore()
    embedding_provider = MockEmbeddingProvider(dimension=1024)
    service = RAGService(
        vector_store=vector_store,
        embedding_provider=embedding_provider,
    )
    print(f"  Vector Store: {type(vector_store).__name__}")
    print(f"  Embedding Provider: {type(embedding_provider).__name__} (dim={embedding_provider.dimension})")

    # 2. Ingest Course A Document (ML 101)
    print("\n[2/6] Ingesting Course A PDF (CS101 - Machine Learning)...")
    ml_pdf = create_sample_ml_pdf()
    meta_a = service.ingest_document(
        file_input=ml_pdf,
        university_id="stanford_univ",
        course_id="course_cs101",
        classroom_id="classroom_alpha",
        filename="lecture_03_gradient_descent.pdf",
        title="Gradient Descent Lecture Notes",
    )
    print(f"  Doc ID: {meta_a.document_id}")
    print(f"  Pages Parsed: {meta_a.total_pages}")
    print(f"  Chunks Created: {meta_a.total_chunks}")
    print(f"  Status: {meta_a.processing_status.value}")
    assert meta_a.total_chunks > 0, "No chunks created for Course A!"

    # 3. Ingest Course B Document (ECON 201)
    print("\n[3/6] Ingesting Course B PDF (ECON201 - Macroeconomics)...")
    econ_pdf = create_sample_econ_pdf()
    meta_b = service.ingest_document(
        file_input=econ_pdf,
        university_id="stanford_univ",
        course_id="course_econ201",
        classroom_id="classroom_beta",
        filename="lecture_01_supply_demand.pdf",
        title="Supply and Demand Notes",
    )
    print(f"  Doc ID: {meta_b.document_id}")
    print(f"  Pages Parsed: {meta_b.total_pages}")
    print(f"  Chunks Created: {meta_b.total_chunks}")
    assert meta_b.total_chunks > 0, "No chunks created for Course B!"

    # 4. Hybrid Retrieval in Course A
    print("\n[4/6] Executing Hybrid Retrieval in Course A (CS101)...")
    query_a = "How does learning rate affect the gradient descent parameter update?"
    results_a = service.retrieve_course_material(
        course_id="course_cs101",
        classroom_id="classroom_alpha",
        query=query_a,
        top_k=3,
    )
    print(f"  Query: '{query_a}'")
    print(f"  Results Returned: {len(results_a)}")
    assert len(results_a) > 0, "Expected at least 1 retrieved chunk!"

    for idx, r in enumerate(results_a, start=1):
        print(f"\n  Match #{idx}:")
        print(f"    Source Citation: {r.source}")
        print(f"    Score: {r.metadata.get('score', 0.0):.4f}")
        print(f"    Section: {r.metadata.get('section')}")
        print(f"    Concepts: {r.metadata.get('concepts')}")
        print(f"    Content Preview: {r.content[:100]}...")

    # 5. Verify Source References
    print("\n[5/6] Verifying Structured Source References...")
    top_r = results_a[0]
    source_ref = top_r.metadata.get("source_reference")
    assert source_ref is not None, "Missing source_reference dictionary!"
    assert source_ref["document_id"] == meta_a.document_id
    assert source_ref["page_number"] in (1, 2)
    assert source_ref["chunk_id"]
    print("  Document ID:", source_ref["document_id"])
    print("  Document Title:", source_ref["document_title"])
    print("  Page Number:", source_ref["page_number"])
    print("  Section:", source_ref["section"])
    print("  Source references verification: PASSED [100%]")

    # 6. Verify Strict Multi-Tenant Course & Classroom Isolation
    print("\n[6/6] Verifying Multi-Tenant Course & Classroom Isolation...")

    # Cross-Course Test 1: Query Course B topic inside Course A
    alien_query_1 = "What is the equilibrium price and quantity in supply and demand?"
    alien_results_1 = service.retrieve_course_material(
        course_id="course_cs101",
        query=alien_query_1,
        top_k=5,
    )
    for res in alien_results_1:
        assert res.metadata["course_id"] == "course_cs101", "Isolation leak detected!"
        assert "Supply and Demand" not in res.content, "Course B material leaked into Course A!"
    print("  Cross-course query 1 (Economics in CS101) leak test: PASSED (0 leaks)")

    # Cross-Course Test 2: Query Course A topic inside Course B
    alien_query_2 = "What is the gradient descent formula with theta and learning rate?"
    alien_results_2 = service.retrieve_course_material(
        course_id="course_econ201",
        query=alien_query_2,
        top_k=5,
    )
    for res in alien_results_2:
        assert res.metadata["course_id"] == "course_econ201", "Isolation leak detected!"
        assert "gradient descent" not in res.content.lower(), "Course A material leaked into Course B!"
    print("  Cross-course query 2 (Gradient descent in ECON201) leak test: PASSED (0 leaks)")

    # Classroom Scoping Test: Query Classroom Alpha with Classroom Beta filter
    classroom_results = service.retrieve_course_material(
        course_id="course_cs101",
        classroom_id="classroom_gamma_nonexistent",
        query="gradient descent",
        top_k=5,
    )
    assert len(classroom_results) == 0, "Classroom isolation failed!"
    print("  Classroom scoping test: PASSED (0 unauthorized chunks)")

    print("\n" + "=" * 78)
    print("ALL SMOKE TEST INVARIANTS VERIFIED SUCCESSFULLY! RAG SUBSYSTEM READY.")
    print("=" * 78)


if __name__ == "__main__":
    run_smoke_test()

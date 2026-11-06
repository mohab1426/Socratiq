"""
Regression tests for the RAG evaluation rebuild (P1 #5).

Covers section 15's "Evaluation" requirements: no question leakage, proper
held-out query behavior, and metric calculation correctness.
"""
from __future__ import annotations

import pytest

from ai.evaluation.fixtures.ci_smoke_dataset import CI_SMOKE_DOCUMENTS, CI_SMOKE_QUERIES
from ai.evaluation.framework import (
    EvalChunk,
    EvalDocument,
    EvalQuery,
    LeakageError,
    QueryOutcome,
    compute_metrics,
    validate_no_leakage,
)


# ---------------------------------------------------------------------------
# No question/answer leakage
# ---------------------------------------------------------------------------

def test_ci_smoke_dataset_has_no_leakage():
    """The CI fixture itself must pass the leakage check -- this is the
    direct regression test for the audit's core finding (the old dataset
    embedded both the answer and the student's own question into the only
    chunk that could match it)."""
    validate_no_leakage(CI_SMOKE_DOCUMENTS, CI_SMOKE_QUERIES)


def test_validate_no_leakage_detects_question_embedded_in_target_chunk():
    """Sanity-check the detector itself: it must actually catch the old
    failure mode when reintroduced, not just pass by construction."""
    leaking_doc = EvalDocument(
        document_id="doc_leak",
        filename="leak.pdf",
        university_id="univ",
        course_id="course",
        classroom_id=None,
        chunks=[
            EvalChunk(
                page_number=1,
                content="Further context on why is my gradient descent update wrong.",
            )
        ],
    )
    leaking_query = EvalQuery(
        query_id="q_leak",
        query="why is my gradient descent update wrong",
        course_id="course",
        classroom_id=None,
        expected_document_id="doc_leak",
        expected_page=1,
    )
    with pytest.raises(LeakageError):
        validate_no_leakage([leaking_doc], [leaking_query])


def test_validate_no_leakage_passes_for_independent_query_and_content():
    clean_doc = EvalDocument(
        document_id="doc_clean",
        filename="clean.pdf",
        university_id="univ",
        course_id="course",
        classroom_id=None,
        chunks=[EvalChunk(page_number=1, content="Gradient descent updates parameters iteratively.")],
    )
    clean_query = EvalQuery(
        query_id="q_clean",
        query="why does my model diverge during training",
        course_id="course",
        classroom_id=None,
        expected_document_id="doc_clean",
        expected_page=1,
    )
    validate_no_leakage([clean_doc], [clean_query])  # should not raise


# ---------------------------------------------------------------------------
# Metric calculation correctness (synthetic, hand-computed)
# ---------------------------------------------------------------------------

def _query(query_id: str, expected_document_id: str, expected_page=None) -> EvalQuery:
    return EvalQuery(
        query_id=query_id,
        query=f"question for {query_id}",
        course_id="c",
        classroom_id=None,
        expected_document_id=expected_document_id,
        expected_page=expected_page,
    )


def test_compute_metrics_recall_and_mrr_hand_computed():
    queries = [
        _query("q1", "doc_a"),
        _query("q2", "doc_b"),
        _query("q3", "doc_c"),
    ]
    outcomes = [
        # q1: doc_a is the top result -> RR = 1.0, hit@1
        QueryOutcome(
            query_id="q1",
            ranked_document_ids=["doc_a", "doc_x", "doc_y"],
            ranked_pages=[1, 1, 1],
            ranked_sections=[None, None, None],
            hit_document=True,
            reciprocal_rank=1.0,
            document_and_page_match_rank=None,
        ),
        # q2: doc_b is 2nd -> RR = 0.5, hit@5 but not hit@1
        QueryOutcome(
            query_id="q2",
            ranked_document_ids=["doc_x", "doc_b", "doc_y"],
            ranked_pages=[1, 1, 1],
            ranked_sections=[None, None, None],
            hit_document=True,
            reciprocal_rank=0.5,
            document_and_page_match_rank=None,
        ),
        # q3: doc_c never appears -> RR = 0.0, no hit
        QueryOutcome(
            query_id="q3",
            ranked_document_ids=["doc_x", "doc_y", "doc_z"],
            ranked_pages=[1, 1, 1],
            ranked_sections=[None, None, None],
            hit_document=False,
            reciprocal_rank=0.0,
            document_and_page_match_rank=None,
        ),
    ]

    metrics = compute_metrics(outcomes, queries, k_values=(1, 5))

    assert metrics["Recall@1"] == pytest.approx(1 / 3)  # only q1 hits within top-1
    assert metrics["Recall@5"] == pytest.approx(2 / 3)  # q1 and q2 hit within top-5 (only 3 results each anyway)
    assert metrics["MRR"] == pytest.approx((1.0 + 0.5 + 0.0) / 3)
    assert metrics["Document Accuracy"] == pytest.approx(2 / 3)


def test_compute_metrics_page_accuracy_only_over_page_labeled_queries():
    queries = [
        _query("q1", "doc_a", expected_page=3),
        _query("q2", "doc_b", expected_page=None),  # no page ground truth
    ]
    outcomes = [
        QueryOutcome(
            query_id="q1",
            ranked_document_ids=["doc_a"],
            ranked_pages=[3],
            ranked_sections=[None],
            hit_document=True,
            reciprocal_rank=1.0,
            document_and_page_match_rank=1,
        ),
        QueryOutcome(
            query_id="q2",
            ranked_document_ids=["doc_b"],
            ranked_pages=[9],
            ranked_sections=[None],
            hit_document=True,
            reciprocal_rank=1.0,
            document_and_page_match_rank=None,
        ),
    ]

    metrics = compute_metrics(outcomes, queries, k_values=(1,))

    # Only q1 has expected_page set, and it matched -> Page Accuracy is 1.0
    # over that one page-labeled query, not diluted by q2 (which has no
    # page ground truth at all).
    assert metrics["Page Accuracy"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# End-to-end: the CI smoke benchmark actually runs against the real
# MemoryVectorStore + HybridRetriever + MockEmbeddingProvider stack.
# ---------------------------------------------------------------------------

def test_run_ci_smoke_benchmark_executes_and_returns_all_five_strategies():
    from ai.evaluation.evaluate_rag import run_ci_smoke_benchmark

    results = run_ci_smoke_benchmark(top_k=10)

    expected_strategies = {"FTS", "Dense", "Hybrid (concat)", "Hybrid + RRF", "Hybrid + RRF + Reranker"}
    assert set(results.keys()) == expected_strategies
    for strategy, metrics in results.items():
        assert "Recall@1" in metrics
        assert "Recall@5" in metrics
        assert "Recall@10" in metrics
        assert "MRR" in metrics
        assert 0.0 <= metrics["MRR"] <= 1.0

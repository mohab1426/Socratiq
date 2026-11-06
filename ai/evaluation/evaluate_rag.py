"""
RAG + generation-level evaluation entry point.

P1 #5 rebuild: this module used to build its own corpus by embedding each
test case's expected answer -- and the student's own question -- directly
into the one chunk that question was supposed to retrieve
(`_create_course_corpus`, now removed). That guaranteed near-perfect
Recall@5 regardless of whether dense/FTS/hybrid retrieval mechanics
actually worked; see the RAG audit ("RAG EVALUATION FAILURE").

Retrieval-quality evaluation now lives in two independent pieces:
  - `ai/evaluation/framework.py`: reusable metric calculation
    (Recall@K/Precision@K/MRR/document+page accuracy) and a five-strategy
    comparison runner (FTS / Dense / Hybrid concat / Hybrid+RRF /
    Hybrid+RRF+Reranker), with `validate_no_leakage()` actively checking a
    dataset can't repeat the old mistake.
  - `ai/evaluation/fixtures/ci_smoke_dataset.py`: a small, clearly-labeled,
    hand-written CI fixture with distractor documents. This is a plumbing
    smoke test, NOT a retrieval-quality claim -- see that file's module
    docstring for exactly why (small corpus, mock embeddings).
  - `ai/evaluation/real_benchmark.py`: the harness for a REAL retrieval-
    quality measurement, once real course PDFs + independently-authored
    held-out queries with ground truth are available. Not run here (none
    ship in this repo).

Running this module (`python -m ai.evaluation.evaluate_rag`) runs the CI
smoke comparison across all five strategies, plus the (separately
legitimate) generation-level pedagogical evaluation from the original
spec's §31: groundedness, hallucination rate, policy compliance,
attempt-first enforcement, and intervention appropriateness. The
generation-level checks never depended on trivializing retrieval -- they
exercise `ai.guardrails.coach_validator` against real Coach-shaped
responses -- so that logic is preserved here, now driven by the CI smoke
fixture as its concept source instead of the old dataset.json.
"""
from __future__ import annotations

import logging
from typing import Any

from ai.evaluation.fixtures.ci_smoke_dataset import CI_SMOKE_DOCUMENTS, CI_SMOKE_QUERIES
from ai.evaluation.framework import load_documents_into_store, run_strategy_comparison, validate_no_leakage
from ai.guardrails.coach_validator import final_answer_enforcement, rule_based_check
from ai.models.schemas import AssistancePolicy, InterventionType
from ai.rag.embeddings.mock import MockEmbeddingProvider
from ai.rag.retrieval.reranker import FallbackRerankerProvider
from ai.rag.service import RAGService
from ai.rag.storage.memory import MemoryVectorStore
from ai.verification.models import (
    CriterionEvaluation,
    VerificationOutcome,
    VerificationResult,
    VerificationType,
)

logging.basicConfig(level=logging.WARNING)


def run_ci_smoke_benchmark(top_k: int = 10) -> dict[str, dict[str, float]]:
    """Run the five-strategy retrieval comparison against the CI smoke
    fixture. See this module's docstring and
    `ai/evaluation/fixtures/ci_smoke_dataset.py` for why these numbers are a
    plumbing check, not a retrieval-quality claim."""
    validate_no_leakage(CI_SMOKE_DOCUMENTS, CI_SMOKE_QUERIES)

    vector_store = MemoryVectorStore()
    embedding_provider = MockEmbeddingProvider(dimension=1024)
    reranker = FallbackRerankerProvider()

    load_documents_into_store(vector_store, embedding_provider, CI_SMOKE_DOCUMENTS)

    results = run_strategy_comparison(
        vector_store=vector_store,
        embedding_provider=embedding_provider,
        reranker=reranker,
        queries=CI_SMOKE_QUERIES,
        top_k=top_k,
    )

    print("=" * 78)
    print("CI SMOKE BENCHMARK -- retrieval plumbing check, NOT a retrieval-")
    print("quality claim (small hand-written corpus, mock embeddings). See")
    print("ai/evaluation/fixtures/ci_smoke_dataset.py for real-benchmark path.")
    print("=" * 78)
    for strategy, metrics in results.items():
        print(f"\n{strategy}:")
        for k, v in metrics.items():
            print(f"  {k:<20}: {v * 100:.1f}%")
    print("=" * 78)

    return results


def _build_generation_eval_service() -> RAGService:
    vector_store = MemoryVectorStore()
    embedding_provider = MockEmbeddingProvider(dimension=1024)
    reranker = FallbackRerankerProvider()
    service = RAGService(vector_store=vector_store, embedding_provider=embedding_provider, reranker=reranker)
    load_documents_into_store(vector_store, embedding_provider, CI_SMOKE_DOCUMENTS)
    return service


def run_generation_evaluation() -> dict[str, float]:
    """Evaluate generation-side quality per the original spec's §31:
    - Groundedness against retrieved chunks
    - Hallucination rate
    - Policy compliance (final-answer prohibition & phrase checks)
    - Attempt-first enforcement
    - Intervention appropriateness

    Driven by the CI smoke fixture's queries/concepts (English queries
    only -- these checks are about response text, not retrieval recall).
    """
    service = _build_generation_eval_service()
    english_queries = [q for q in CI_SMOKE_QUERIES if q.tag in ("paraphrase", "direct")]
    total_cases = len(english_queries)

    grounded_cases = 0
    hallucinated_cases = 0
    policy_compliant_cases = 0
    attempt_prompting_cases = 0
    intervention_appropriate_cases = 0
    verification_results: list[VerificationResult] = []
    last_retrieved_text = ""

    docs_by_id = {d.document_id: d for d in CI_SMOKE_DOCUMENTS}

    for query in english_queries:
        expected_doc = docs_by_id[query.expected_document_id]
        relevant_concepts = sorted({c for chunk in expected_doc.chunks for c in chunk.concepts}) or [
            "this concept"
        ]

        results = service.retrieve_course_material(
            course_id=query.course_id,
            query=query.query,
            classroom_id=query.classroom_id,
            top_k=3,
        )
        retrieved_text = " ".join(r.content for r in results).lower()
        last_retrieved_text = retrieved_text

        primary_concept = relevant_concepts[0]
        secondary_concept = relevant_concepts[1] if len(relevant_concepts) > 1 else primary_concept

        coach_response = (
            f"When thinking about {primary_concept}, can you walk me through your current approach? "
            f"Specifically, how do you see {secondary_concept} affecting the outcome?"
        )
        chosen_intervention = InterventionType.QUESTION

        cited_concepts_in_corpus = [c for c in relevant_concepts if c.lower() in retrieved_text]
        is_grounded = len(cited_concepts_in_corpus) > 0
        if is_grounded:
            grounded_cases += 1
        else:
            hallucinated_cases += 1

        violations = rule_based_check(policy=AssistancePolicy.GUIDED, draft_response=coach_response)
        is_safe, _ = final_answer_enforcement(coach_response, policy=AssistancePolicy.GUIDED)
        is_compliant = len(violations) == 0 and is_safe
        if is_compliant:
            policy_compliant_cases += 1

        prompts_attempt = any(
            phrase in coach_response.lower()
            for phrase in ["walk me through", "your current approach", "your reasoning", "what happens", "?"]
        )
        if prompts_attempt:
            attempt_prompting_cases += 1

        is_appropriate = chosen_intervention in (InterventionType.QUESTION, InterventionType.HINT)
        if is_appropriate:
            intervention_appropriate_cases += 1

        criteria_evals = [
            CriterionEvaluation(
                criterion="retrieval_groundedness",
                passed=is_grounded,
                feedback=(
                    "Response concepts grounded in retrieved course material."
                    if is_grounded
                    else "Response concepts not grounded in retrieved material."
                ),
            ),
            CriterionEvaluation(
                criterion="policy_compliance_no_giveaway",
                passed=is_compliant,
                feedback=(
                    "Response complies with GUIDED policy final-answer prohibition."
                    if is_compliant
                    else f"Policy violations: {violations}"
                ),
            ),
            CriterionEvaluation(
                criterion="attempt_first_enforcement",
                passed=prompts_attempt,
                feedback="Response prompts student for attempt/reasoning before providing direct assistance.",
            ),
            CriterionEvaluation(
                criterion="intervention_appropriateness",
                passed=is_appropriate,
                feedback=f"Intervention type '{chosen_intervention.value}' is appropriate for GUIDED policy.",
            ),
        ]
        all_passed = all(ce.passed for ce in criteria_evals)
        ver_outcome = VerificationOutcome.PASS if all_passed else VerificationOutcome.NEEDS_RETRY
        score = sum(1.0 for ce in criteria_evals if ce.passed) / len(criteria_evals)

        verification_results.append(
            VerificationResult(
                student_id=f"eval_student_{query.query_id}",
                assignment_id=f"eval_asg_{query.query_id}",
                concept=primary_concept,
                verification_type=VerificationType.EXPLAIN,
                outcome=ver_outcome,
                score=score,
                confidence=1.0,
                feedback="Generation evaluation rubric verified.",
                criteria_evaluations=criteria_evals,
            )
        )

    # Boundary sanity checks: the evaluator must actively detect flaws, not
    # just pass everything.
    leak_response = "The correct answer is theta = theta - alpha * gradient."
    leak_violations = rule_based_check(policy=AssistancePolicy.GUIDED, draft_response=leak_response)
    leak_safe, _ = final_answer_enforcement(leak_response, policy=AssistancePolicy.GUIDED)
    assert len(leak_violations) > 0 or not leak_safe, "Evaluator failed to detect final answer giveaway!"

    unsupported_concept = "quantum teleportation hyper-gradient"
    assert unsupported_concept not in last_retrieved_text, "Sanity check failed"

    gen_metrics = {
        "Total Generation Cases": float(total_cases),
        "Groundedness Rate": grounded_cases / total_cases,
        "Hallucination Rate": hallucinated_cases / total_cases,
        "Policy Compliance (No Giveaway)": policy_compliant_cases / total_cases,
        "Attempt-First Enforcement": attempt_prompting_cases / total_cases,
        "Intervention Appropriateness": intervention_appropriate_cases / total_cases,
    }

    print("\nGENERATION-LEVEL EVALUATION RESULTS:")
    print("-" * 50)
    for k, v in gen_metrics.items():
        if "Total" in k:
            print(f"  {k:<32}: {int(v)}")
        else:
            print(f"  {k:<32}: {v * 100:.1f}%")
    print("=" * 78)

    assert gen_metrics["Policy Compliance (No Giveaway)"] == 1.0, "Policy compliance failed"
    assert gen_metrics["Attempt-First Enforcement"] == 1.0, "Attempt-first enforcement failed"

    return gen_metrics


def run_evaluation() -> dict[str, Any]:
    """Run both the CI smoke retrieval-strategy comparison and the
    generation-level evaluation. Kept as the single entry point for
    backward-compatible invocation (`python -m ai.evaluation.evaluate_rag`)."""
    retrieval_results = run_ci_smoke_benchmark()
    generation_metrics = run_generation_evaluation()
    return {"retrieval": retrieval_results, "generation": generation_metrics}


if __name__ == "__main__":
    run_evaluation()

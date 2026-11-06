"""
CI smoke-test dataset for `ai/evaluation/framework.py`.

IMPORTANT -- read before trusting any number this produces:

    THIS IS A CI SMOKE TEST, NOT A REAL RETRIEVAL-QUALITY BENCHMARK.

It exists to prove two things in CI, with no external services required:
  1. The evaluation framework's plumbing (corpus loading, the five
     retrieval-strategy runs, metric calculation) actually works.
  2. Nothing in the framework or this fixture leaks a query's own text (or
     its answer) into its expected target chunk -- enforced by
     `validate_no_leakage()` in a test, not just by convention.

It does NOT tell you anything trustworthy about real-world retrieval
quality:
  - The corpus is ~12 short, hand-written paragraphs, not real course PDFs.
  - `MockEmbeddingProvider`'s vectors are a deterministic hash-based
    projection, not a real trained embedding model, so "Dense" numbers here
    say nothing about `nvidia/nv-embedqa-e5-v5`'s real semantic recall.
  - The corpus is small enough that hybrid/RRF/reranking can saturate to
    1.0 trivially, exactly as the original audit warned about the old
    35-case dataset -- these numbers cannot demonstrate marginal gains from
    hybrid/RRF/reranking either.

For an actual retrieval-quality measurement, use
`ai/evaluation/real_benchmark.py` with real course PDFs and independently
authored held-out queries with real ground truth (expected_document_id,
expected_page, ideally expected_section).

Each topic below has exactly one *target* document (the one a query should
retrieve) plus one *distractor* document that shares surface vocabulary but
answers a different question -- e.g. "precision" in ML metrics vs.
"precision" in manufacturing tolerances -- so recall actually has to
discriminate, not just match on a topic keyword.
"""
from __future__ import annotations

from ai.evaluation.framework import EvalChunk, EvalDocument, EvalQuery

_COURSE = "course_ml_eval"
_CLASSROOM = "classroom_eval"
_UNIVERSITY = "univ_eval"


def _doc(document_id: str, filename: str, chunks: list[EvalChunk]) -> EvalDocument:
    return EvalDocument(
        document_id=document_id,
        filename=filename,
        university_id=_UNIVERSITY,
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        chunks=chunks,
    )


CI_SMOKE_DOCUMENTS: list[EvalDocument] = [
    _doc(
        "doc_overfitting",
        "week3_generalization.pdf",
        [
            EvalChunk(
                page_number=1,
                section="Generalization",
                concepts=["overfitting"],
                content=(
                    "Overfitting happens when a model fits the training data too closely, "
                    "capturing sampling noise and idiosyncratic patterns specific to the "
                    "examples it was trained on, rather than the underlying signal that "
                    "generalizes to new data. Symptoms include training loss that keeps "
                    "dropping while validation loss stalls or rises -- a widening gap "
                    "between the two curves."
                ),
            ),
        ],
    ),
    _doc(
        "doc_overfitting_distractor",
        "week3_appendix_regularization_terms.pdf",
        [
            EvalChunk(
                page_number=1,
                section="Terminology appendix",
                concepts=["regularization"],
                content=(
                    "This appendix lists terminology used throughout the regularization "
                    "unit: weight decay, L1/L2 penalty, dropout rate, early stopping "
                    "criterion, and elastic net mixing coefficient."
                ),
            ),
        ],
    ),
    _doc(
        "doc_precision_recall",
        "week5_classification_metrics.pdf",
        [
            EvalChunk(
                page_number=2,
                section="Evaluating classifiers",
                concepts=["precision", "recall"],
                content=(
                    "Two complementary measures describe how a binary classifier errs: one, "
                    "precision, counts how many of the cases flagged positive were true "
                    "false positives versus correct; the other, recall, counts how many "
                    "actually-positive cases were missed detections versus caught. A model "
                    "tuned to minimize missed detections will typically flag more borderline "
                    "cases, which tends to increase false positives and reduce precision in "
                    "exchange for improving recall."
                ),
            ),
        ],
    ),
    _doc(
        "doc_precision_recall_distractor",
        "week1_lab_measurement_tolerances.pdf",
        [
            EvalChunk(
                page_number=1,
                section="Lab equipment calibration",
                concepts=["precision"],
                content=(
                    "When calibrating lab instruments, precision refers to how tightly "
                    "repeated measurements of the same quantity cluster together, "
                    "regardless of whether they cluster around the true value -- that "
                    "property is called accuracy instead."
                ),
            ),
        ],
    ),
    _doc(
        "doc_bias_variance",
        "week4_bias_variance_tradeoff.pdf",
        [
            EvalChunk(
                page_number=1,
                section="Bias-variance tradeoff",
                concepts=["bias", "variance"],
                content=(
                    "Prediction error can be decomposed into a component from overly "
                    "simplistic assumptions baked into the model -- causing it to miss "
                    "real relationships -- and a component from excessive sensitivity to "
                    "small fluctuations in the training sample. Reducing one component "
                    "often increases the other, which is why model complexity is usually "
                    "tuned rather than maximized."
                ),
            ),
        ],
    ),
    _doc(
        "doc_regularization",
        "week6_l1_l2_penalties.pdf",
        [
            EvalChunk(
                page_number=3,
                section="Penalizing model complexity",
                concepts=["regularization", "l1", "l2"],
                content=(
                    "Adding a penalty term proportional to the magnitude of the model's "
                    "coefficients discourages the optimizer from relying too heavily on "
                    "any single feature. A penalty proportional to the absolute value of "
                    "the coefficients tends to push many of them to exactly zero, which is "
                    "useful for feature selection; a penalty proportional to their squared "
                    "magnitude shrinks them smoothly instead."
                ),
            ),
        ],
    ),
    _doc(
        "doc_cross_validation",
        "week2_model_selection.pdf",
        [
            EvalChunk(
                page_number=1,
                section="Model selection",
                concepts=["cross-validation"],
                content=(
                    "To estimate how well a model will perform on unseen data without "
                    "spending a separate held-out set for every hyperparameter choice, the "
                    "training data can be split into several folds; the model is trained "
                    "repeatedly, each time holding out a different fold for evaluation, and "
                    "the resulting scores are averaged."
                ),
            ),
        ],
    ),
    _doc(
        "doc_learning_rate",
        "week3_gradient_descent.pdf",
        [
            EvalChunk(
                page_number=4,
                section="Gradient descent updates",
                concepts=["learning_rate", "gradient_descent"],
                content=(
                    "Each gradient descent step moves the parameters in the direction that "
                    "locally reduces the loss the fastest, scaled by a small positive step "
                    "size (the learning rate). Choosing that step size too large can cause "
                    "the updates to overshoot and diverge; choosing it too small makes "
                    "convergence impractically slow."
                ),
            ),
        ],
    ),
    _doc(
        "doc_backpropagation",
        "week7_backprop.pdf",
        [
            EvalChunk(
                page_number=2,
                section="Computing gradients",
                concepts=["backpropagation"],
                content=(
                    "Gradients of the loss with respect to every parameter in a multi-layer "
                    "network are computed efficiently by applying the chain rule "
                    "layer-by-layer, working backward from the output layer to the input "
                    "layer, reusing intermediate derivative computations rather than "
                    "recomputing them from scratch for each parameter."
                ),
            ),
        ],
    ),
    # An Arabic-content document for the mixed-language retrieval rows.
    _doc(
        "doc_overfitting_arabic",
        "week3_generalization_ar.pdf",
        [
            EvalChunk(
                page_number=1,
                section="التعميم",
                concepts=["overfitting"],
                content=(
                    "يحدث فرط التخصيص عندما يتعلم النموذج التفاصيل الدقيقة والضوضاء "
                    "الموجودة في بيانات التدريب بدلاً من النمط العام الذي يمكن تعميمه على "
                    "بيانات جديدة، مما يؤدي إلى أداء ضعيف على بيانات لم يسبق للنموذج رؤيتها."
                ),
            ),
        ],
    ),
]


CI_SMOKE_QUERIES: list[EvalQuery] = [
    EvalQuery(
        query_id="q_overfitting_paraphrase",
        query="Why does my model do great on training data but badly on new data?",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_overfitting",
        expected_page=1,
        expected_section="Generalization",
        tag="paraphrase",
    ),
    EvalQuery(
        query_id="q_precision_recall_paraphrase",
        query="What's the tradeoff between false positives and missed detections called?",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_precision_recall",
        expected_page=2,
        tag="paraphrase",
    ),
    EvalQuery(
        query_id="q_bias_variance_direct",
        query="Explain the bias-variance tradeoff.",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_bias_variance",
        expected_page=1,
        tag="direct",
    ),
    EvalQuery(
        query_id="q_regularization_paraphrase",
        query="How does adding a penalty on the weights help avoid relying on one feature too much?",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_regularization",
        expected_page=3,
        tag="paraphrase",
    ),
    EvalQuery(
        query_id="q_l1_vs_l2_direct",
        query="What's the difference between L1 and L2 regularization?",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_regularization",
        expected_page=3,
        tag="direct",
    ),
    EvalQuery(
        query_id="q_cross_validation_paraphrase",
        query="How do I evaluate a model without wasting data on a separate validation set for each setting?",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_cross_validation",
        expected_page=1,
        tag="paraphrase",
    ),
    EvalQuery(
        query_id="q_learning_rate_paraphrase",
        query="What happens if the step size in gradient descent is too big?",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_learning_rate",
        expected_page=4,
        tag="paraphrase",
    ),
    EvalQuery(
        query_id="q_backprop_direct",
        query="How are gradients computed in a neural network?",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_backpropagation",
        expected_page=2,
        tag="direct",
    ),
    EvalQuery(
        query_id="q_overfitting_arabic",
        query="ليه الموديل بيعمل overfit؟",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_overfitting_arabic",
        expected_page=1,
        tag="arabic",
    ),
    EvalQuery(
        query_id="q_overfitting_mixed_language",
        query="اشرحلي مفهوم overfitting في الموديل",
        course_id=_COURSE,
        classroom_id=_CLASSROOM,
        expected_document_id="doc_overfitting_arabic",
        expected_page=1,
        tag="mixed_language",
    ),
]

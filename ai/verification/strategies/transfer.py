"""
Transfer Verification Strategy: Checks if the student can apply the concept in a novel domain.
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from ai.verification.models import (
    VerificationChallengeRequest,
    VerificationRequest,
    VerificationType,
)
from ai.verification.strategies.base import BaseVerificationStrategy

_CHALLENGE_SYSTEM = """You are an expert pedagogy system designing a concise 'Conceptual Transfer' verification question.
Given a student's demonstrated competence on concept ({concept}), ask them to apply the concept to one new, simple case or domain.

Requirements:
- Ask the student to apply ({concept}) to one new, simple case or domain.
- Target the concept specifically: {concept}.
- Length constraint: Prefer 5–12 words per question whenever practical.
- Ask only one thing. Avoid compound questions, elaborate backstories, or long hypothetical scenarios.
- Require a short answer, ideally one sentence or a few words.
- Adapt the question to the student's demonstrated understanding.
- Distinctness: Must test application to a new simple case, distinct from explaining the current solution (Explain) or changing a condition (Modify).
- Do NOT make it multiple choice.
- Define 2-3 clear criteria for evaluating conceptual transfer.
"""

_EVALUATION_SYSTEM = """You are an expert pedagogical evaluator assessing a student's conceptual transfer.
Determine whether the student can abstract the core principles of the concept and apply them correctly to a novel domain.

Evaluation Outcomes:
- PASS: The student successfully transferred the concept to the new case. Note: Concise, accurate answers (a single sentence or a few words) must be awarded PASS if conceptually sound.
- PARTIAL: The student transferred the core intuition but struggled with minor specifics.
- NEEDS_RETRY: The student failed to transfer the concept or misapplied it completely.
- INSUFFICIENT_EVIDENCE: The response is evasive, completely off-topic, or empty. Do NOT flag a response as insufficient evidence simply because it is concise or only one sentence.

Scoring:
- PASS: score >= 0.8
- PARTIAL: score 0.5 to 0.79
- NEEDS_RETRY: score 0.1 to 0.49
- INSUFFICIENT_EVIDENCE: score 0.0

Evaluate each rubric criterion individually and provide constructive student feedback.
"""


class TransferStrategy(BaseVerificationStrategy):
    verification_type = VerificationType.TRANSFER

    def build_challenge_prompt(self, request: VerificationChallengeRequest) -> list:
        system = SystemMessage(content=_CHALLENGE_SYSTEM.format(concept=request.concept))
        human = (
            f"Concept: {request.concept}\n"
            f"Current Assignment Context: {request.course_context or 'N/A'}\n\n"
            f"Student's Demonstrated Work:\n{request.student_work}\n\n"
            "Generate the transfer challenge question and 2-3 rubric criteria."
        )
        return [system, HumanMessage(content=human)]

    def build_evaluation_prompt(self, request: VerificationRequest) -> list:
        criteria_str = "\n".join(f"- {c}" for c in request.criteria) if request.criteria else "(Standard transfer criteria)"
        system = SystemMessage(content=_EVALUATION_SYSTEM)
        human = (
            f"Concept: {request.concept}\n"
            f"Novel Scenario Challenge: {request.challenge_question}\n"
            f"Rubric Criteria:\n{criteria_str}\n\n"
            f"Student's Transfer Response:\n{request.student_response}\n\n"
            "Evaluate the student's conceptual transfer thoroughly."
        )
        return [system, HumanMessage(content=human)]

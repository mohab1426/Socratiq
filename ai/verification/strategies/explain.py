"""
Explain Verification Strategy: Checks if the student can explain why their solution works.
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from ai.verification.models import (
    VerificationChallengeRequest,
    VerificationRequest,
    VerificationType,
)
from ai.verification.strategies.base import BaseVerificationStrategy

_CHALLENGE_SYSTEM = """You are an expert pedagogy system designing a concise 'Conceptual Explanation' verification question.
Given a student's completed or partially completed work on an assignment, design a targeted question asking them to explain the core mechanics or reasoning behind a key concept ({concept}).

Requirements:
- Verify conceptual understanding using exactly one direct question.
- Target the concept specifically: {concept}.
- Ask them to explain *why* something works or why a choice was made in their work.
- Length constraint: Prefer 5–12 words per question whenever practical.
- Ask only one thing. Avoid compound questions, preamble, or unnecessary context.
- Require a short answer, ideally one sentence or a few words.
- Adapt the question to the student's actual work and lesson context.
- Do NOT make it multiple choice.
- Do NOT ask trivia or rote definitions; ask about their actual reasoning.
- Define 2-3 clear criteria for what constitutes a sound explanation.
"""

_EVALUATION_SYSTEM = """You are an expert pedagogical evaluator assessing a student's conceptual explanation.
Determine whether the student truly understands the underlying concept or if they are repeating superficial phrases.

Evaluation Outcomes:
- PASS: The student understands the mechanism, causal relationship, or rationale. Note: Concise, accurate answers (a single sentence or a few words) must be awarded PASS if conceptually sound.
- PARTIAL: The student understands the general idea but has minor imprecisions or omissions.
- NEEDS_RETRY: The student shows fundamental misconceptions or incorrect causal reasoning.
- INSUFFICIENT_EVIDENCE: The response is evasive, completely off-topic, or empty. Do NOT flag a response as insufficient evidence simply because it is concise or only one sentence.

Scoring:
- PASS: score >= 0.8
- PARTIAL: score 0.5 to 0.79
- NEEDS_RETRY: score 0.1 to 0.49
- INSUFFICIENT_EVIDENCE: score 0.0

Evaluate each rubric criterion individually and provide constructive student feedback.
"""


class ExplainStrategy(BaseVerificationStrategy):
    verification_type = VerificationType.EXPLAIN

    def build_challenge_prompt(self, request: VerificationChallengeRequest) -> list:
        system = SystemMessage(content=_CHALLENGE_SYSTEM.format(concept=request.concept))
        human = (
            f"Concept: {request.concept}\n"
            f"Assignment Context: {request.course_context or 'N/A'}\n\n"
            f"Student's Work:\n{request.student_work}\n\n"
            "Generate the explanation challenge question and 2-3 rubric criteria."
        )
        return [system, HumanMessage(content=human)]

    def build_evaluation_prompt(self, request: VerificationRequest) -> list:
        criteria_str = "\n".join(f"- {c}" for c in request.criteria) if request.criteria else "(Standard conceptual criteria)"
        system = SystemMessage(content=_EVALUATION_SYSTEM)
        human = (
            f"Concept: {request.concept}\n"
            f"Challenge Question: {request.challenge_question}\n"
            f"Rubric Criteria:\n{criteria_str}\n\n"
            f"Original Work Reference:\n{request.original_attempt or '(None)'}\n\n"
            f"Student's Explanation Response:\n{request.student_response}\n\n"
            "Evaluate the student's response thoroughly."
        )
        return [system, HumanMessage(content=human)]

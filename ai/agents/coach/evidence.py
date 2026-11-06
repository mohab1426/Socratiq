"""
Observable learning evidence extraction and external AI risk signals.

All evidence candidates emitted here are:
- Strictly observable from the student's attempt, revision state, and conversation.
- Traceable to source interaction / learning event IDs.
- Calibrated by model confidence.

Boundary rules (section 19-21 of AI Spec):
- Never compute final mastery scores.
- Never compute an overall dependency score.
- Never assert or label that a student cheated or used external AI.
- Only report observable signals with explicit uncertainty.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Optional

from langchain_core.messages import HumanMessage

from ai.models.schemas import (
    DiagnosisCategory,
    EvidenceStrength,
    EvidenceType,
    ExternalAIRiskSignal,
    LearningEvidenceCandidate,
)

if TYPE_CHECKING:
    from ai.agents.coach.state import CoachState

_EXPLANATION_MARKERS = (
    "because",
    "since",
    "the reason is",
    "so that",
    "my reasoning",
    "in order to",
    "this means that",
    "which leads to",
    "i did this to",
    "i chose this because",
)


def extract_evidence_candidates(
    state: CoachState, source_event_id: Optional[str] = None
) -> list[LearningEvidenceCandidate]:
    """Extract candidate learning evidence indicators from the current turn.

    Emitted candidates represent discrete observable learning moments (e.g.
    demonstrated understanding, observable misconception, revision behavior,
    independent problem solving, self-explanation).
    """
    candidates: list[LearningEvidenceCandidate] = []
    metadata = state.get("metadata")
    if not metadata:
        return candidates

    student_id = metadata.student_id
    assignment_id = metadata.assignment_id
    turn_index = metadata.turn_index or 1
    source_ids = [source_event_id] if source_event_id else []

    diagnosis = state.get("diagnosis")
    if diagnosis and not diagnosis.is_uncertain:
        concept = diagnosis.concept

        # 1. Understanding evidence
        if diagnosis.category == DiagnosisCategory.CORRECT_REASONING:
            strength = (
                EvidenceStrength.STRONG
                if diagnosis.confidence >= 0.8
                else (EvidenceStrength.MODERATE if diagnosis.confidence >= 0.5 else EvidenceStrength.WEAK)
            )
            candidates.append(
                LearningEvidenceCandidate(
                    student_id=student_id,
                    assignment_id=assignment_id,
                    concept=concept,
                    evidence_type=EvidenceType.UNDERSTANDING,
                    strength=strength,
                    observation=(
                        f"Student demonstrated correct reasoning regarding "
                        f"{concept or 'the required task'}: {diagnosis.explanation}"
                    ),
                    source_event_ids=source_ids,
                )
            )

            # 2. Independence evidence
            # Student achieved sound reasoning on their initial attempt without prior hints
            if turn_index <= 1:
                candidates.append(
                    LearningEvidenceCandidate(
                        student_id=student_id,
                        assignment_id=assignment_id,
                        concept=concept,
                        evidence_type=EvidenceType.INDEPENDENCE,
                        strength=EvidenceStrength.STRONG if diagnosis.confidence >= 0.8 else EvidenceStrength.MODERATE,
                        observation=(
                            "Student produced an accurate solution on initial attempt "
                            "without requiring prior hints."
                        ),
                        source_event_ids=source_ids,
                    )
                )

        # 3. Misconception evidence
        elif diagnosis.category in (
            DiagnosisCategory.MISCONCEPTION,
            DiagnosisCategory.CONCEPTUAL_GAP,
            DiagnosisCategory.LOGICAL_ERROR,
            DiagnosisCategory.PROCEDURAL_ERROR,
            DiagnosisCategory.CODE_ERROR,
            DiagnosisCategory.INCOMPLETE_REASONING,
        ):
            strength = (
                EvidenceStrength.STRONG
                if diagnosis.confidence >= 0.8
                else (EvidenceStrength.MODERATE if diagnosis.confidence >= 0.5 else EvidenceStrength.WEAK)
            )
            detail = diagnosis.evidence or diagnosis.explanation
            cat_label = diagnosis.category.value.lower().replace("_", " ")
            candidates.append(
                LearningEvidenceCandidate(
                    student_id=student_id,
                    assignment_id=assignment_id,
                    concept=concept,
                    evidence_type=EvidenceType.MISCONCEPTION,
                    strength=strength,
                    observation=f"Observable {cat_label}: {detail}",
                    source_event_ids=source_ids,
                )
            )

    # 4. Revision evidence
    if turn_index > 1:
        rev_strength = (
            EvidenceStrength.STRONG
            if diagnosis and diagnosis.category == DiagnosisCategory.CORRECT_REASONING
            else EvidenceStrength.MODERATE
        )
        candidates.append(
            LearningEvidenceCandidate(
                student_id=student_id,
                assignment_id=assignment_id,
                concept=diagnosis.concept if diagnosis else None,
                evidence_type=EvidenceType.REVISION,
                strength=rev_strength,
                observation="Student submitted a revised attempt following pedagogical guidance.",
                source_event_ids=source_ids,
            )
        )

    # 5. Explanation evidence
    current_attempt = (state.get("current_attempt") or "").lower()
    if any(marker in current_attempt for marker in _EXPLANATION_MARKERS):
        candidates.append(
            LearningEvidenceCandidate(
                student_id=student_id,
                assignment_id=assignment_id,
                concept=diagnosis.concept if diagnosis else None,
                evidence_type=EvidenceType.EXPLANATION,
                strength=EvidenceStrength.MODERATE,
                observation="Student explicitly articulated rationale or self-explanation in their attempt.",
                source_event_ids=source_ids,
            )
        )

    return candidates


def extract_risk_signals(state: CoachState) -> list[ExternalAIRiskSignal]:
    """Detect observable risk signals across attempts.

    Reports only concrete, observable structural phenomena (e.g. large complexity
    jumps between turns without intermediate scaffolding). Never asserts cheating
    or external AI usage.
    """
    signals: list[ExternalAIRiskSignal] = []
    metadata = state.get("metadata")
    if not metadata or (metadata.turn_index or 0) <= 1:
        return signals

    messages = state.get("messages") or []
    human_attempts: list[str] = [m.content for m in messages if isinstance(m, HumanMessage)]
    if len(human_attempts) < 2:
        return signals

    previous_attempt = human_attempts[-2]
    current_attempt = human_attempts[-1]

    len_prev = len(previous_attempt.strip())
    len_curr = len(current_attempt.strip())

    # Signal 1: Unusually large jump between attempts
    # Previous attempt was minimal/broken (<60 chars), current attempt jumped to a large solution (>350 chars)
    if len_prev < 60 and len_curr > 350 and (len_curr / max(len_prev, 1)) >= 5.0:
        signals.append(
            ExternalAIRiskSignal(
                signal="unusually_large_attempt_jump",
                observation=(
                    f"Observable complexity jump between turn {metadata.turn_index - 1} ({len_prev} chars) "
                    f"and turn {metadata.turn_index} ({len_curr} chars) without intermediate drafting steps."
                ),
                metadata={
                    "prior_length": len_prev,
                    "current_length": len_curr,
                    "turn_index": metadata.turn_index,
                },
            )
        )

    # Signal 2: Sudden introduction of multi-function structure after elementary attempt
    code_analysis = state.get("code_analysis")
    if code_analysis and code_analysis.is_valid_syntax and len_prev < 80:
        if len(code_analysis.defined_functions) >= 3:
            signals.append(
                ExternalAIRiskSignal(
                    signal="solution_sophistication_inconsistent_with_prior_attempt",
                    observation=(
                        f"Student introduced multiple structured functions "
                        f"({', '.join(code_analysis.defined_functions)}) in turn {metadata.turn_index} "
                        f"after an elementary prior attempt."
                    ),
                    metadata={
                        "defined_functions": code_analysis.defined_functions,
                        "turn_index": metadata.turn_index,
                    },
                )
            )

    # Signal 3: Style shift — formal/structured patterns appear suddenly
    _FORMAL_MARKERS = (
        "```",  # markdown code fences
        "def ",  # function definitions
        "class ",
        "# ",  # comments
        '"""',  # docstrings
    )
    prev_formal_count = sum(1 for m in _FORMAL_MARKERS if m in previous_attempt)
    curr_formal_count = sum(1 for m in _FORMAL_MARKERS if m in current_attempt)
    if prev_formal_count == 0 and curr_formal_count >= 3 and len_curr > 200:
        signals.append(
            ExternalAIRiskSignal(
                signal="style_shift_between_attempts",
                observation=(
                    f"Observable formatting/style shift: prior attempt had {prev_formal_count} "
                    f"formal markers, current attempt has {curr_formal_count} formal markers "
                    f"in turn {metadata.turn_index}."
                ),
                metadata={
                    "prior_formal_count": prev_formal_count,
                    "current_formal_count": curr_formal_count,
                    "turn_index": metadata.turn_index,
                },
            )
        )

    return signals

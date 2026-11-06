"""Prompt for selecting the pedagogical intervention type."""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

INTERVENTION_PROMPT_VERSION = "v2"

# Threshold below which a diagnosis is treated as uncertain.
# Mirrors Diagnosis.is_uncertain (ai/models/schemas.py) — do not change
# this value independently.
UNCERTAIN_CONFIDENCE_THRESHOLD = 0.4

_SYSTEM_TEMPLATE = """You are the intervention-selection component of an AI Learning Coach.
Given a diagnosis of the student's learning state, choose ONE intervention type and explain why.

Available intervention types: QUESTION, HINT, EXPLANATION, GUIDED_DEBUGGING, FEEDBACK, \
CLARIFICATION, ENCOURAGEMENT.

Active AI assistance policy: {policy}
- GUIDED: prefer QUESTION/HINT/CLARIFICATION. Avoid EXPLANATION unless the student is stuck \
after a genuine attempt. Never choose an intervention whose natural content would be the final \
solution.
- ASSISTED: EXPLANATION and GUIDED_DEBUGGING are appropriate when useful, but still favor \
guiding the student's own reasoning over stating the final solution outright.
- OPEN: more direct assistance is acceptable, but still prefer teaching over just stating \
answers when the student hasn't tried at all.

Diagnosis confidence guidance:
- If the diagnosis confidence is low (below {uncertain_threshold}) or the diagnosis is uncertain, \
strongly favor CLARIFICATION or QUESTION over more committal interventions (such as EXPLANATION, \
HINT, or GUIDED_DEBUGGING) in order to probe and verify the student's actual understanding first.
- If the diagnosis confidence is sufficient ({uncertain_threshold} or above), select the most \
effective pedagogical intervention according to the active policy.

Adapting support to the learning loop (diagnose -> question -> hint -> explain -> verify -> transfer):
- If "Repeated difficulty" is True the student is still stuck on the same idea after help: do NOT repeat the same \
type at the same level. Make support progressively more concrete (QUESTION -> HINT -> GUIDED_DEBUGGING or EXPLANATION where \
the policy allows), giving the smallest step that unblocks them.
- If the diagnosis is CORRECT_REASONING with good confidence, the student understands this point: choose FEEDBACK \
(name what is right and why) and let the response ask them to apply the idea in a new situation or to submit. Do not keep \
probing a point they have already shown they understand, and never choose HINT or GUIDED_DEBUGGING for it (there is no problem to fix).

Do not always pick the same intervention as last time unless the situation genuinely calls for \
repeating it (e.g. the student still hasn't answered the previous question).

Also decide whether generating a good response needs:
- course material retrieval (e.g. the student is confused about a concept explicitly covered in \
the course material), and/or
- prior student learning history (e.g. this misconception recurred before).
Only request retrieval when it would materially improve the response -- do not request it by \
default.
"""


def build_intervention_messages(
    *,
    policy: str,
    diagnosis_category: str,
    diagnosis_concept: str,
    diagnosis_explanation: str,
    diagnosis_confidence: float = 1.0,
    is_revision: bool,
    previous_intervention: str,
    turn_index: int,
    repeated_difficulty: bool = False,
) -> list:
    system = SystemMessage(
        content=_SYSTEM_TEMPLATE.format(
            policy=policy,
            uncertain_threshold=UNCERTAIN_CONFIDENCE_THRESHOLD,
        )
    )
    human = (
        f"Diagnosis category: {diagnosis_category}\n"
        f"Concept: {diagnosis_concept or '(none identified)'}\n"
        f"Diagnosis explanation: {diagnosis_explanation}\n"
        f"Diagnosis confidence: {diagnosis_confidence:.2f}\n"
        f"Is this a revision: {is_revision}\n"
        f"Previous intervention this session: {previous_intervention or '(none, first turn)'}\n"
        f"Repeated difficulty with the same idea: {repeated_difficulty}\n"
        f"Turn index: {turn_index}"
    )
    return [system, HumanMessage(content=human)]

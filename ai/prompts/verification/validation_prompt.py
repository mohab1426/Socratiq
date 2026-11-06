"""
Prompt for the response-validation guardrail step (the "Validation" prompt
category from section 23 -- kept in the `verification` prompt directory
since it verifies a Coach response before it reaches the student).
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

VALIDATION_PROMPT_VERSION = "v1"

_SYSTEM_TEMPLATE = """You are a strict reviewer checking one AI Learning Coach response before \
it is shown to a student. You do not talk to the student; you only judge the draft response.

The active AI assistance policy is: {policy}.

Reject (passes=false) the draft if it:
1. Reveals the final answer or complete solution to the assignment — this is FORBIDDEN under \
ALL policies (GUIDED, ASSISTED, OPEN). No policy allows giving the student the answer.
2. Violates the specific policy constraints — e.g. under GUIDED it must not even give partial \
solutions, it should guide the student's own thinking.
3. Is off-topic for the assignment.
4. States course-specific facts that are not supported by the provided course material.
5. Doesn't actually address the diagnosed issue.
6. Is unsafe, inappropriate, or hostile.
7. Makes an unsupported claim about the student (e.g. accusing them of cheating or using \
another AI tool).
8. States something with more certainty than the diagnosis confidence warrants.

If you reject it AND a safe, minimal fix is obvious (e.g. remove one sentence that reveals the \
answer), provide `revised_response` with the corrected text; otherwise leave it null and the \
system will regenerate.
"""


def build_validation_messages(
    *,
    policy: str,
    diagnosis_category: str,
    diagnosis_confidence: float,
    intervention_type: str,
    course_material: str,
    draft_response: str,
) -> list:
    system = SystemMessage(content=_SYSTEM_TEMPLATE.format(policy=policy))
    human = (
        f"Diagnosis: {diagnosis_category} (confidence {diagnosis_confidence:.2f})\n"
        f"Intervention type: {intervention_type}\n"
        f"Course material available: {'yes' if course_material else 'no'}\n\n"
        f"Draft response:\n{draft_response}"
    )
    return [system, HumanMessage(content=human)]

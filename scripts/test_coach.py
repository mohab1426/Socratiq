#!/usr/bin/env python3
"""
Manual smoke test for the real AI Coach pipeline.

Usage:
    python scripts/test_coach.py

Verifies the full pipeline end-to-end against configured real LLM:
    Coach -> diagnosis -> intervention -> response -> validation
Returns a valid CoachResult under GUIDED assistance policy.
Does not execute student code.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure project root is in sys.path
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from ai.agents.coach.graph import Coach
from ai.agents.coach.state import TaskContext
from ai.config import AIConfigError, ModelRole, validate_ai_config
from ai.models.schemas import AssistancePolicy, CoachResult


def run_coach_smoke_test() -> int:
    print("==================================================")
    print("The Socratic Class - Coach Integration Smoke Test")
    print("==================================================")

    # 1. Validate configuration first
    try:
        config = validate_ai_config(ModelRole.COACH)
        print(f"Provider:    {config.provider}")
        print(f"Model:       {config.model}")
        print(f"Base URL:    {config.base_url or '[Default/Official]'}")
        print("API Key:     [CONFIGURED]")
        print("Configuration status: VALID\n")
    except AIConfigError as err:
        print("\n[Configuration Incomplete or Invalid]")
        print(f"{err}\n")
        print("To run the Coach smoke test, please edit .env and configure your AI provider and API key.")
        return 1
    except Exception as exc:
        print(f"\nUnexpected configuration error: {exc}")
        return 1

    # 2. Setup mock assignment context and student attempt
    task = TaskContext(
        assignment_id="smoke_asg_01",
        course_id="ml_fundamentals_101",
        title="Optimization with Gradient Descent",
        instructions=(
            "Explain or implement gradient descent. Specifically, explain how the parameter update "
            "step adjusts parameters based on the gradient and learning rate."
        ),
        subject_area="machine_learning",
        is_programming=False,
    )

    attempt = "I think gradient descent works by increasing the learning rate until the loss becomes smaller."
    print("Simulating student attempt under GUIDED policy:")
    print(f"Task:    {task.title}")
    print(f"Attempt: {attempt!r}\n")
    print("Executing Coach pipeline (understand_context -> diagnose -> choose_intervention -> generate_response -> validate)...")

    try:
        coach = Coach()
        result: CoachResult = coach.invoke(
            student_id="smoke_student_01",
            assignment_id=task.assignment_id,
            session_id="smoke_sess_01",
            task_context=task,
            attempt=attempt,
            policy=AssistancePolicy.GUIDED,
        )

        assert isinstance(result, CoachResult), f"Expected CoachResult, got {type(result)}"

        print("\n--- Pipeline Execution Succeeded ---")
        print(f"Diagnosis Category:     {result.diagnosis_summary.category.value}")
        print(f"Diagnosis Concept:      {result.diagnosis_summary.concept or 'n/a'}")
        print(f"Diagnosis Explanation:  {result.diagnosis_summary.explanation}")
        print(f"Intervention Type:      {result.intervention.type.value}")
        print(f"Intervention Rationale: {result.intervention.rationale}")
        print(f"Validation Passed:      {result.metadata.get('validation_violations') == []}")
        print(f"Tools Used:             {result.tools_used}")
        print(f"Evidence Candidates:    {len(result.evidence_candidates)} emitted")
        for ev in result.evidence_candidates:
            print(f"  - [{ev.evidence_type.value} / {ev.strength.value}] {ev.observation}")
        print(f"Risk Signals:           {len(result.risk_signals)} detected")
        for sig in result.risk_signals:
            print(f"  - [{sig.signal}] {sig.observation}")
        print(f"\nCoach Response:\n{result.response}")
        print("------------------------------------\n")
        print("SUCCESS: Coach integration smoke test passed!")
        return 0
    except Exception as exc:
        print(f"\n[Coach Execution Failed]: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(run_coach_smoke_test())

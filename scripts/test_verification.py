"""
Standalone smoke test for the Learning Verification module.

Usage:
    python scripts/test_verification.py
"""
import sys
from pathlib import Path

# Ensure project root is in sys.path
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from ai.config import AIConfigError, ModelRole, validate_ai_config


def main():
    print("=" * 55)
    print("The Socratic Class - Learning Verification Smoke Test")
    print("=" * 55)

    try:
        config = validate_ai_config(ModelRole.VERIFICATION)
        print(f"[Configuration Loaded]")
        print(f"  Role:        {config.role.value}")
        print(f"  Provider:    {config.provider}")
        print(f"  Model:       {config.model}")
        print(f"  Base URL:    {config.base_url or '[Default]'}")
        print(f"  Temperature: {config.temperature}")
        print(f"  Timeout:     {config.timeout}s")
        print()
    except AIConfigError as exc:
        print("\n[Configuration Incomplete or Invalid]")
        print(str(exc))
        print("\nTo run real verification calls, please edit .env and configure your AI provider and API key.")
        sys.exit(1)

    from ai.verification import (
        VerificationChallengeRequest,
        VerificationRequest,
        VerificationService,
        VerificationType,
    )

    service = VerificationService()
    print("Generating conceptual challenge (Explain mode)...")
    challenge = service.generate_challenge(
        VerificationChallengeRequest(
            assignment_id="asg_smoke",
            concept="gradient_descent",
            verification_type=VerificationType.EXPLAIN,
            student_work="theta = theta - lr * gradient",
        )
    )
    print(f"Challenge ID: {challenge.challenge_id}")
    print(f"Question:     {challenge.question}")
    print(f"Criteria:     {challenge.criteria}")
    print()

    print("Evaluating sample student response...")
    result = service.verify(
        VerificationRequest(
            student_id="student_smoke",
            assignment_id="asg_smoke",
            concept="gradient_descent",
            verification_type=VerificationType.EXPLAIN,
            challenge_question=challenge.question,
            student_response="Subtracting moves parameters in the opposite direction of the gradient, decreasing loss.",
            criteria=challenge.criteria,
        )
    )
    print(f"Outcome:      {result.outcome.value}")
    print(f"Score:        {result.score:.2f}")
    print(f"Feedback:     {result.feedback}")
    if result.evidence_candidate:
        print(f"Evidence:     {result.evidence_candidate.evidence_type.value} ({result.evidence_candidate.strength.value})")
    print("\nVerification smoke test completed successfully!")


if __name__ == "__main__":
    main()

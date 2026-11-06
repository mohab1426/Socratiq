import importlib


def test_ai_core_modules_import():
    modules = [
        "ai.models.schemas",
        "ai.contracts.coach_contract",
        "ai.agents.coach.graph",
        "ai.agents.coach.state",
        "ai.agents.coach.evidence",
        "ai.verification.models",
        "ai.verification.service",
        "ai.rag.models",
        "ai.rag.storage.pgvector",
        "ai.rag.retrieval.hybrid_retriever",
    ]

    failures = []

    for module_name in modules:
        try:
            importlib.import_module(module_name)
        except Exception as exc:
            failures.append(f"{module_name}: {exc}")

    assert not failures, (
        "AI_IMPORT_FAIL\n" + "\n".join(failures)
    )


def test_coach_entrypoints_exist():
    candidates = [
        (
            "ai.agents.coach.graph",
            [
                "CoachGraph",
                "build_coach_graph",
                "coach_graph",
            ],
        ),
        (
            "ai.agents.coach.state",
            [
                "CoachState",
            ],
        ),
        (
            "ai.agents.coach.evidence",
            [
                "extract_evidence_candidates",
                "extract_risk_signals",
            ],
        ),
    ]

    failures = []

    for module_name, names in candidates:
        try:
            module = importlib.import_module(module_name)

            if not any(hasattr(module, name) for name in names):
                failures.append(
                    f"{module_name}: none of {names}"
                )

        except Exception as exc:
            failures.append(
                f"{module_name}: {exc}"
            )

    assert not failures, (
        "COACH_FAIL\n" + "\n".join(failures)
    )


def test_evidence_entrypoints_are_callable():
    module = importlib.import_module(
        "ai.agents.coach.evidence"
    )

    assert callable(
        module.extract_evidence_candidates
    ), "extract_evidence_candidates must be callable"

    assert callable(
        module.extract_risk_signals
    ), "extract_risk_signals must be callable"
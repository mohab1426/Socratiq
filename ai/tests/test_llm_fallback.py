"""
Tests for the multi-model fallback chain (AI_FALLBACK_<n>_* env slots).

Covers:
1. No fallback env -> behaviour identical to the single-model setup.
2. Primary fails (quota / 429 / outage) -> the next model answers.
3. Primary succeeds -> fallbacks are never called.
4. Every model fails -> an error propagates to the caller (LangChain re-raises the first one).
5. Slot parsing: same-endpoint slots inherit credentials, different-endpoint
   slots must bring their own key, role-specific overrides, malformed slots.
"""
from __future__ import annotations

import pytest
from langchain_core.runnables import RunnableLambda

from ai.config import AIConfigError, ModelConfig, ModelRole, get_fallback_configs
from ai.models import llm as llm_module
from ai.models.llm import clear_llm_cache, get_structured_llm


class FakeChatModel:
    """Stand-in chat model: `with_structured_output` returns a runnable that
    either answers with its own name or raises like an exhausted quota."""

    def __init__(self, name: str, failing: set[str]):
        self.name = name
        self.failing = failing
        self.calls = 0

    def with_structured_output(self, schema):
        def _call(_messages):
            self.calls += 1
            if self.name in self.failing:
                raise RuntimeError(f"429 quota exceeded for {self.name}")
            return f"answer-from-{self.name}"

        return RunnableLambda(_call)


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    clear_llm_cache()
    names = [
        "AI_PROVIDER", "AI_API_KEY", "AI_BASE_URL", "AI_MODEL_DEFAULT",
        "AI_MODEL_COACH", "AI_MODEL_REASONING", "AI_MODEL_LIGHTWEIGHT", "AI_MODEL_VERIFICATION",
        "AI_TEMPERATURE_DEFAULT", "AI_TIMEOUT", "AI_MAX_RETRIES",
    ]
    # Clear role-specific primary/fallback settings loaded from the project's
    # real .env so these unit tests exercise the isolated fixture configuration.
    names.extend(
        f"AI_{role}_{suffix}"
        for role in ("DEFAULT", "COACH", "REASONING", "LIGHTWEIGHT", "VERIFICATION")
        for suffix in ("PROVIDER", "API_KEY", "BASE_URL")
    )
    names.extend(
        f"AI_{role}_FALLBACK_{slot}_{suffix}"
        for role in ("DEFAULT", "COACH", "REASONING", "LIGHTWEIGHT", "VERIFICATION")
        for slot in range(1, 6)
        for suffix in ("PROVIDER", "API_KEY", "BASE_URL", "MODEL")
    )
    for n in range(1, 6):
        for suffix in ("PROVIDER", "API_KEY", "BASE_URL", "MODEL",
                       "MODEL_COACH", "MODEL_REASONING", "MODEL_LIGHTWEIGHT", "MODEL_VERIFICATION"):
            names.append(f"AI_FALLBACK_{n}_{suffix}")
    for name in names:
        monkeypatch.delenv(name, raising=False)
    yield
    clear_llm_cache()


def _configure_primary(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_API_KEY", "primary-key")
    monkeypatch.setenv("AI_BASE_URL", "https://primary.example/v1")
    monkeypatch.setenv("AI_MODEL_DEFAULT", "model-a")


def _install_fakes(monkeypatch, failing: set[str]) -> dict[str, FakeChatModel]:
    built: dict[str, FakeChatModel] = {}

    def fake_build(config):
        built.setdefault(config.model, FakeChatModel(config.model, failing))
        return built[config.model]

    monkeypatch.setattr(llm_module, "_build_chat_model", fake_build)
    return built


# ---------------------------------------------------------------------------
# Runtime behaviour
# ---------------------------------------------------------------------------

def test_without_fallbacks_returns_plain_primary(monkeypatch):
    _configure_primary(monkeypatch)
    built = _install_fakes(monkeypatch, failing=set())

    runnable = get_structured_llm(ModelRole.COACH, object)

    assert not hasattr(runnable, "fallbacks")
    assert runnable.invoke("hi") == "answer-from-model-a"
    assert list(built) == ["model-a"]


def test_primary_failure_falls_through_to_next_model(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_1_MODEL", "model-b")
    monkeypatch.setenv("AI_FALLBACK_2_MODEL", "model-c")
    built = _install_fakes(monkeypatch, failing={"model-a", "model-b"})

    result = get_structured_llm(ModelRole.COACH, object).invoke("hi")

    assert result == "answer-from-model-c"
    assert [built[m].calls for m in ("model-a", "model-b", "model-c")] == [1, 1, 1]


def test_fallbacks_not_called_when_primary_succeeds(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_1_MODEL", "model-b")
    built = _install_fakes(monkeypatch, failing=set())

    assert get_structured_llm(ModelRole.COACH, object).invoke("hi") == "answer-from-model-a"
    assert built["model-b"].calls == 0


def test_all_models_failing_raises(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_1_MODEL", "model-b")
    _install_fakes(monkeypatch, failing={"model-a", "model-b"})

    with pytest.raises(RuntimeError, match="quota exceeded"):
        get_structured_llm(ModelRole.COACH, object).invoke("hi")


# ---------------------------------------------------------------------------
# Slot parsing
# ---------------------------------------------------------------------------

def test_same_endpoint_slot_inherits_primary_credentials(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_1_MODEL", "model-b")

    (cfg,) = get_fallback_configs(ModelRole.COACH)

    assert cfg.model == "model-b"
    assert cfg.provider == "openai_compatible"
    assert cfg.api_key == "primary-key"
    assert cfg.base_url == "https://primary.example/v1"


def test_different_endpoint_slot_uses_its_own_credentials(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_1_BASE_URL", "https://second.example/v1")
    monkeypatch.setenv("AI_FALLBACK_1_API_KEY", "second-key")
    monkeypatch.setenv("AI_FALLBACK_1_MODEL", "model-b")

    (cfg,) = get_fallback_configs(ModelRole.COACH)

    assert cfg.api_key == "second-key"
    assert cfg.base_url == "https://second.example/v1"
    assert cfg.provider == "openai_compatible"


def test_primary_key_is_never_sent_to_a_different_endpoint(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_1_BASE_URL", "https://second.example/v1")
    monkeypatch.setenv("AI_FALLBACK_1_MODEL", "model-b")  # no API key given

    with pytest.raises(AIConfigError, match="AI_FALLBACK_1_API_KEY"):
        get_fallback_configs(ModelRole.COACH)


def test_slot_without_model_is_an_error(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_1_API_KEY", "some-key")

    with pytest.raises(AIConfigError, match="AI_FALLBACK_1_MODEL"):
        get_fallback_configs(ModelRole.COACH)


def test_role_specific_model_override_and_gaps(monkeypatch):
    _configure_primary(monkeypatch)
    monkeypatch.setenv("AI_FALLBACK_2_MODEL", "big-model")            # slot 1 left empty
    monkeypatch.setenv("AI_FALLBACK_2_MODEL_LIGHTWEIGHT", "small-model")

    assert [c.model for c in get_fallback_configs(ModelRole.COACH)] == ["big-model"]
    assert [c.model for c in get_fallback_configs(ModelRole.LIGHTWEIGHT)] == ["small-model"]


def test_no_slots_means_empty_chain(monkeypatch):
    _configure_primary(monkeypatch)
    assert get_fallback_configs(ModelRole.COACH) == []

# ---------------------------------------------------------------------------
# Role-isolated fallback configuration
# ---------------------------------------------------------------------------

def _configure_role(monkeypatch, role: str, model: str, key: str, base_url: str):
    monkeypatch.setenv(f"AI_{role}_PROVIDER", "openai_compatible")
    monkeypatch.setenv(f"AI_{role}_API_KEY", key)
    monkeypatch.setenv(f"AI_{role}_BASE_URL", base_url)
    monkeypatch.setenv(f"AI_MODEL_{role}", model)


def test_each_role_has_its_own_primary_configuration(monkeypatch):
    _configure_role(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach.example/v1")
    _configure_role(monkeypatch, "REASONING", "reasoning-primary", "reasoning-key", "https://reasoning.example/v1")

    coach = ModelConfig(ModelRole.COACH)
    reasoning = ModelConfig(ModelRole.REASONING)

    assert (coach.provider, coach.api_key, coach.base_url, coach.model) == (
        "openai_compatible", "coach-key", "https://coach.example/v1", "coach-primary"
    )
    assert (reasoning.provider, reasoning.api_key, reasoning.base_url, reasoning.model) == (
        "openai_compatible", "reasoning-key", "https://reasoning.example/v1", "reasoning-primary"
    )


def test_role_fallbacks_use_their_own_credentials_and_endpoint(monkeypatch):
    _configure_role(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach.example/v1")
    _configure_role(monkeypatch, "REASONING", "reasoning-primary", "reasoning-key", "https://reasoning.example/v1")

    monkeypatch.setenv("AI_COACH_FALLBACK_1_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_API_KEY", "coach-backup-key")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_BASE_URL", "https://coach-backup.example/v1")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_MODEL", "coach-backup")

    monkeypatch.setenv("AI_REASONING_FALLBACK_1_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_REASONING_FALLBACK_1_API_KEY", "reasoning-backup-key")
    monkeypatch.setenv("AI_REASONING_FALLBACK_1_BASE_URL", "https://reasoning-backup.example/v1")
    monkeypatch.setenv("AI_REASONING_FALLBACK_1_MODEL", "reasoning-backup")

    coach_fallbacks = get_fallback_configs(ModelRole.COACH)
    reasoning_fallbacks = get_fallback_configs(ModelRole.REASONING)

    assert [(c.model, c.api_key, c.base_url) for c in coach_fallbacks] == [
        ("coach-backup", "coach-backup-key", "https://coach-backup.example/v1")
    ]
    assert [(c.model, c.api_key, c.base_url) for c in reasoning_fallbacks] == [
        ("reasoning-backup", "reasoning-backup-key", "https://reasoning-backup.example/v1")
    ]


def test_role_fallback_does_not_inherit_primary_credentials(monkeypatch):
    _configure_role(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach.example/v1")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_BASE_URL", "https://other.example/v1")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_MODEL", "coach-backup")

    with pytest.raises(AIConfigError, match="AI_COACH_FALLBACK_1_API_KEY"):
        get_fallback_configs(ModelRole.COACH)


def test_role_fallback_runtime_is_independent(monkeypatch):
    _configure_role(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach.example/v1")
    _configure_role(monkeypatch, "REASONING", "reasoning-primary", "reasoning-key", "https://reasoning.example/v1")

    monkeypatch.setenv("AI_COACH_FALLBACK_1_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_API_KEY", "coach-backup-key")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_BASE_URL", "https://coach-backup.example/v1")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_MODEL", "coach-backup")

    monkeypatch.setenv("AI_REASONING_FALLBACK_1_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_REASONING_FALLBACK_1_API_KEY", "reasoning-backup-key")
    monkeypatch.setenv("AI_REASONING_FALLBACK_1_BASE_URL", "https://reasoning-backup.example/v1")
    monkeypatch.setenv("AI_REASONING_FALLBACK_1_MODEL", "reasoning-backup")

    built = _install_fakes(monkeypatch, failing={"coach-primary"})

    assert get_structured_llm(ModelRole.COACH, object).invoke("hi") == "answer-from-coach-backup"
    # Reasoning has a separate primary and must not use the Coach fallback.
    assert get_structured_llm(ModelRole.REASONING, object).invoke("hi") == "answer-from-reasoning-primary"
    assert built["reasoning-primary"].calls == 1
    assert built["coach-backup"].calls == 1
    assert "reasoning-backup" not in built or built["reasoning-backup"].calls == 0

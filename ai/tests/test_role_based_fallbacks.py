"""Tests for independent role-specific providers and fallback chains."""
from __future__ import annotations

import pytest
from langchain_core.runnables import RunnableLambda

from ai.config import AIConfigError, ModelRole, get_fallback_configs, ModelConfig
from ai.models import llm as llm_module
from ai.models.llm import clear_llm_cache, get_structured_llm


ROLES = ("DEFAULT", "COACH", "REASONING", "LIGHTWEIGHT", "VERIFICATION")


@pytest.fixture(autouse=True)
def clean_role_env(monkeypatch):
    clear_llm_cache()
    prefixes = ["AI"]
    for role in ROLES:
        prefixes.append(f"AI_{role}")
    names = [
        "AI_PROVIDER", "AI_API_KEY", "AI_BASE_URL", "AI_MODEL_DEFAULT",
        "AI_MODEL_COACH", "AI_MODEL_REASONING", "AI_MODEL_LIGHTWEIGHT",
        "AI_MODEL_VERIFICATION", "AI_TEMPERATURE_DEFAULT", "AI_TIMEOUT",
        "AI_MAX_RETRIES",
    ]
    for prefix in prefixes:
        for n in range(1, 6):
            for suffix in ("PROVIDER", "API_KEY", "BASE_URL", "MODEL"):
                names.append(f"{prefix}_FALLBACK_{n}_{suffix}")
    for role in ROLES:
        names.extend([
            f"AI_{role}_PROVIDER", f"AI_{role}_API_KEY", f"AI_{role}_BASE_URL",
        ])
    for name in names:
        monkeypatch.delenv(name, raising=False)
    yield
    clear_llm_cache()


def _set_primary(monkeypatch, role: str, model: str, key: str, url: str):
    monkeypatch.setenv(f"AI_{role}_PROVIDER", "openai_compatible")
    monkeypatch.setenv(f"AI_{role}_API_KEY", key)
    monkeypatch.setenv(f"AI_{role}_BASE_URL", url)
    monkeypatch.setenv(f"AI_MODEL_{role}", model)


def _set_fallback(monkeypatch, role: str, slot: int, model: str, key: str, url: str):
    prefix = f"AI_{role}_FALLBACK_{slot}_"
    monkeypatch.setenv(f"{prefix}PROVIDER", "openai_compatible")
    monkeypatch.setenv(f"{prefix}API_KEY", key)
    monkeypatch.setenv(f"{prefix}BASE_URL", url)
    monkeypatch.setenv(f"{prefix}MODEL", model)


def test_each_role_reads_its_own_primary_provider_key_url_and_model(monkeypatch):
    _set_primary(monkeypatch, "DEFAULT", "default-model", "default-key", "https://default/v1")
    _set_primary(monkeypatch, "COACH", "coach-model", "coach-key", "https://coach/v1")
    _set_primary(monkeypatch, "REASONING", "reasoning-model", "reasoning-key", "https://reasoning/v1")
    _set_primary(monkeypatch, "LIGHTWEIGHT", "light-model", "light-key", "https://light/v1")
    _set_primary(monkeypatch, "VERIFICATION", "verify-model", "verify-key", "https://verify/v1")

    expected = {
        ModelRole.DEFAULT: ("default-model", "default-key", "https://default/v1"),
        ModelRole.COACH: ("coach-model", "coach-key", "https://coach/v1"),
        ModelRole.REASONING: ("reasoning-model", "reasoning-key", "https://reasoning/v1"),
        ModelRole.LIGHTWEIGHT: ("light-model", "light-key", "https://light/v1"),
        ModelRole.VERIFICATION: ("verify-model", "verify-key", "https://verify/v1"),
    }
    for role, (model, key, url) in expected.items():
        cfg = ModelConfig(role)
        assert (cfg.model, cfg.api_key, cfg.base_url) == (model, key, url)


def test_each_role_has_an_independent_fallback_chain(monkeypatch):
    _set_primary(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach/v1")
    _set_primary(monkeypatch, "REASONING", "reason-primary", "reason-key", "https://reason/v1")
    _set_fallback(monkeypatch, "COACH", 1, "coach-f1", "coach-f1-key", "https://coach-f1/v1")
    _set_fallback(monkeypatch, "COACH", 2, "coach-f2", "coach-f2-key", "https://coach-f2/v1")
    _set_fallback(monkeypatch, "REASONING", 1, "reason-f1", "reason-f1-key", "https://reason-f1/v1")

    coach = get_fallback_configs(ModelRole.COACH)
    reasoning = get_fallback_configs(ModelRole.REASONING)

    assert [(c.model, c.api_key, c.base_url) for c in coach] == [
        ("coach-f1", "coach-f1-key", "https://coach-f1/v1"),
        ("coach-f2", "coach-f2-key", "https://coach-f2/v1"),
    ]
    assert [(c.model, c.api_key, c.base_url) for c in reasoning] == [
        ("reason-f1", "reason-f1-key", "https://reason-f1/v1"),
    ]


def test_coach_fallback_does_not_use_reasoning_credentials(monkeypatch):
    _set_primary(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach/v1")
    _set_primary(monkeypatch, "REASONING", "reason-primary", "reason-key", "https://reason/v1")
    _set_fallback(monkeypatch, "REASONING", 1, "reason-f1", "reason-f1-key", "https://reason-f1/v1")

    assert get_fallback_configs(ModelRole.COACH) == []


def test_incomplete_role_fallback_is_rejected(monkeypatch):
    _set_primary(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach/v1")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_MODEL", "coach-f1")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_API_KEY", "coach-f1-key")
    monkeypatch.setenv("AI_COACH_FALLBACK_1_BASE_URL", "https://coach-f1/v1")
    with pytest.raises(AIConfigError, match="PROVIDER"):
        get_fallback_configs(ModelRole.COACH)


def test_role_fallback_chain_is_used_in_runtime(monkeypatch):
    _set_primary(monkeypatch, "COACH", "coach-primary", "coach-key", "https://coach/v1")
    _set_fallback(monkeypatch, "COACH", 1, "coach-f1", "coach-f1-key", "https://coach-f1/v1")
    _set_fallback(monkeypatch, "COACH", 2, "coach-f2", "coach-f2-key", "https://coach-f2/v1")

    built = {}

    class Fake:
        def __init__(self, name):
            self.name = name
            self.calls = 0

        def with_structured_output(self, schema):
            def call(_):
                self.calls += 1
                if self.name != "coach-f2":
                    raise RuntimeError(f"429 quota exhausted: {self.name}")
                return "coach-success"
            return RunnableLambda(call)

    def fake_build(config):
        key = f"{config.provider}|{config.api_key}|{config.base_url}|{config.model}"
        built.setdefault(key, Fake(config.model))
        return built[key]

    monkeypatch.setattr(llm_module, "_build_chat_model", fake_build)
    clear_llm_cache()

    result = get_structured_llm(ModelRole.COACH, object).invoke("hello")
    assert result == "coach-success"
    assert all(fake.calls == 1 for fake in built.values())
    assert len(built) == 3


def test_legacy_global_configuration_still_works(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_API_KEY", "legacy-key")
    monkeypatch.setenv("AI_BASE_URL", "https://legacy/v1")
    monkeypatch.setenv("AI_MODEL_COACH", "legacy-coach")
    monkeypatch.setenv("AI_FALLBACK_1_MODEL", "legacy-f1")

    primary = ModelConfig(ModelRole.COACH)
    fallbacks = get_fallback_configs(ModelRole.COACH)

    assert primary.model == "legacy-coach"
    assert fallbacks[0].model == "legacy-f1"
    assert fallbacks[0].api_key == "legacy-key"
    assert fallbacks[0].base_url == "https://legacy/v1"

"""
Unit tests for AI and LLM configuration, environment loading, and validation.

Verifies:
1. Default provider behavior.
2. Provider loaded from environment.
3. API key loaded from environment.
4. Base URL loaded when required.
5. Default model fallback.
6. Role-specific model override.
7. Missing required API key produces a clear error.
8. Secrets are never included in error messages.
9. Base URL validation for providers requiring it.
10. Temperature and timeout/retry handling.
"""
from __future__ import annotations

import pytest

from ai.config import (
    AIConfigError,
    ModelConfig,
    ModelRole,
    SUPPORTED_PROVIDERS,
    _mask_secret,
    validate_ai_config,
)
from ai.models.llm import clear_llm_cache, get_llm


@pytest.fixture(autouse=True)
def clean_ai_env(monkeypatch):
    """Ensure environment is isolated for each configuration test."""
    clear_llm_cache()
    keys_to_clear = [
        # Legacy/global settings.
        "AI_PROVIDER",
        "AI_API_KEY",
        "AI_BASE_URL",
        "AI_MODEL_DEFAULT",
        "AI_MODEL_COACH",
        "AI_MODEL_REASONING",
        "AI_MODEL_LIGHTWEIGHT",
        "AI_MODEL_VERIFICATION",
        # Role-specific primary settings. The application intentionally loads
        # the repository .env, so tests must explicitly clear those values to
        # avoid leaking a developer's local configuration into unit tests.
        *[
            f"AI_{role}_{suffix}"
            for role in ("DEFAULT", "COACH", "REASONING", "LIGHTWEIGHT", "VERIFICATION")
            for suffix in ("PROVIDER", "API_KEY", "BASE_URL")
        ],
        "AI_TEMPERATURE_DEFAULT",
        "AI_TEMPERATURE_COACH",
        "AI_TEMPERATURE_REASONING",
        "AI_TEMPERATURE_LIGHTWEIGHT",
        "AI_TEMPERATURE_VERIFICATION",
        "AI_TIMEOUT",
        "AI_MAX_RETRIES",
    ]
    for key in keys_to_clear:
        monkeypatch.delenv(key, raising=False)
    yield
    clear_llm_cache()


# ---------------------------------------------------------------------------
# 1. Default provider behavior
# ---------------------------------------------------------------------------

def test_default_provider_behavior():
    config = ModelConfig(ModelRole.COACH)
    assert config.provider == "openai"
    assert config.model == "gpt-4o-mini"
    assert config.temperature == 0.5


# ---------------------------------------------------------------------------
# 2. Provider loaded from environment
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("provider", ["anthropic", "openai_compatible", "nvidia", "nvidia_nim"])
def test_provider_loaded_from_environment(monkeypatch, provider):
    monkeypatch.setenv("AI_PROVIDER", provider.upper())
    config = ModelConfig(ModelRole.COACH)
    assert config.provider == provider


def test_unknown_provider_raises_clear_error(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "unsupported_llm_provider")
    monkeypatch.setenv("AI_API_KEY", "test-key")
    config = ModelConfig(ModelRole.COACH)
    with pytest.raises(AIConfigError) as exc_info:
        config.validate()
    msg = str(exc_info.value)
    assert "Unknown AI_PROVIDER 'unsupported_llm_provider'" in msg
    for supported in SUPPORTED_PROVIDERS:
        assert supported in msg


# ---------------------------------------------------------------------------
# 3. API key loaded from environment
# ---------------------------------------------------------------------------

def test_api_key_loaded_from_environment(monkeypatch):
    monkeypatch.setenv("AI_API_KEY", "test-secret-key-12345")
    config = ModelConfig(ModelRole.COACH)
    assert config.api_key == "test-secret-key-12345"


# ---------------------------------------------------------------------------
# 4. Base URL loaded when required
# ---------------------------------------------------------------------------

def test_base_url_loaded_for_openai_compatible(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_API_KEY", "test-key")
    monkeypatch.setenv("AI_BASE_URL", "http://localhost:8000/v1")

    config = ModelConfig(ModelRole.COACH)
    assert config.base_url == "http://localhost:8000/v1"
    config.validate()  # Passes validation


def test_base_url_required_for_nvidia(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "nvidia")
    monkeypatch.setenv("AI_API_KEY", "nvapi-test-key")
    # AI_BASE_URL is missing
    config = ModelConfig(ModelRole.COACH)
    with pytest.raises(AIConfigError) as exc_info:
        config.validate()
    assert "AI_BASE_URL is required when AI_PROVIDER=nvidia" in str(exc_info.value)


def test_base_url_required_for_openai_compatible(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_API_KEY", "test-key")
    # AI_BASE_URL is missing
    config = ModelConfig(ModelRole.COACH)
    with pytest.raises(AIConfigError) as exc_info:
        config.validate()
    assert "AI_BASE_URL is required when AI_PROVIDER=openai_compatible" in str(exc_info.value)


# ---------------------------------------------------------------------------
# 5. Default model fallback
# ---------------------------------------------------------------------------

def test_default_model_fallback(monkeypatch):
    monkeypatch.setenv("AI_MODEL_DEFAULT", "custom-fallback-model")
    config_coach = ModelConfig(ModelRole.COACH)
    config_reasoning = ModelConfig(ModelRole.REASONING)
    assert config_coach.model == "custom-fallback-model"
    assert config_reasoning.model == "custom-fallback-model"


# ---------------------------------------------------------------------------
# 6. Role-specific model override
# ---------------------------------------------------------------------------

def test_role_specific_model_override(monkeypatch):
    monkeypatch.setenv("AI_MODEL_DEFAULT", "general-model")
    monkeypatch.setenv("AI_MODEL_REASONING", "deep-reasoning-model")
    monkeypatch.setenv("AI_MODEL_COACH", "friendly-tutor-model")

    coach = ModelConfig(ModelRole.COACH)
    reasoning = ModelConfig(ModelRole.REASONING)
    lightweight = ModelConfig(ModelRole.LIGHTWEIGHT)
    verification = ModelConfig(ModelRole.VERIFICATION)

    assert coach.model == "friendly-tutor-model"
    assert reasoning.model == "deep-reasoning-model"
    assert lightweight.model == "general-model"
    assert verification.model == "general-model"


# ---------------------------------------------------------------------------
# 7. Missing required API key produces a clear error
# ---------------------------------------------------------------------------

def test_missing_api_key_raises_clear_error(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    # No AI_API_KEY set
    config = ModelConfig(ModelRole.COACH)
    with pytest.raises(AIConfigError) as exc_info:
        config.validate()

    expected = "AI configuration error:\nAI_API_KEY is required when AI_PROVIDER=openai"
    assert expected in str(exc_info.value)


def test_get_llm_fails_fast_when_api_key_missing(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    # No AI_API_KEY set
    with pytest.raises(AIConfigError) as exc_info:
        get_llm(ModelRole.COACH)

    assert "AI_API_KEY is required when AI_PROVIDER=openai" in str(exc_info.value)


# ---------------------------------------------------------------------------
# 8. Secrets are never included in error messages or string representations
# ---------------------------------------------------------------------------

def test_secrets_are_never_included_in_error_or_repr(monkeypatch):
    secret_key = "super-secret-token-do-not-leak-98765"
    monkeypatch.setenv("AI_PROVIDER", "openai_compatible")
    monkeypatch.setenv("AI_API_KEY", secret_key)
    # Trigger an error: missing AI_BASE_URL
    config = ModelConfig(ModelRole.COACH)

    with pytest.raises(AIConfigError) as exc_info:
        config.validate()

    error_message = str(exc_info.value)
    assert secret_key not in error_message
    assert "AI_BASE_URL is required" in error_message

    # Verify __repr__ and __str__ mask the secret
    repr_str = repr(config)
    assert secret_key not in repr_str
    assert "[CONFIGURED]" in repr_str

    str_out = str(config)
    assert secret_key not in str_out
    assert "[CONFIGURED]" in str_out

    # When secret is not set
    assert _mask_secret(None) == "[NOT SET]"
    assert _mask_secret("") == "[NOT SET]"


# ---------------------------------------------------------------------------
# 9. Temperature overrides and fallbacks
# ---------------------------------------------------------------------------

def test_temperature_defaults_and_overrides(monkeypatch):
    # Default without env vars: reasoning is 0.2, others 0.5
    assert ModelConfig(ModelRole.REASONING).temperature == 0.2
    assert ModelConfig(ModelRole.COACH).temperature == 0.5

    # Global default override
    monkeypatch.setenv("AI_TEMPERATURE_DEFAULT", "0.7")
    assert ModelConfig(ModelRole.COACH).temperature == 0.7
    assert ModelConfig(ModelRole.REASONING).temperature == 0.7

    # Role override takes precedence
    monkeypatch.setenv("AI_TEMPERATURE_REASONING", "0.1")
    assert ModelConfig(ModelRole.REASONING).temperature == 0.1
    assert ModelConfig(ModelRole.COACH).temperature == 0.7


def test_invalid_temperature_raises_clear_error(monkeypatch):
    monkeypatch.setenv("AI_TEMPERATURE_COACH", "not-a-number")
    with pytest.raises(AIConfigError) as exc_info:
        ModelConfig(ModelRole.COACH)
    assert "Invalid temperature value 'not-a-number'" in str(exc_info.value)


# ---------------------------------------------------------------------------
# 10. Timeout and max_retries
# ---------------------------------------------------------------------------

def test_timeout_and_retries_parsing(monkeypatch):
    monkeypatch.setenv("AI_TIMEOUT", "45.5")
    monkeypatch.setenv("AI_MAX_RETRIES", "4")
    config = ModelConfig(ModelRole.COACH)
    assert config.timeout == 45.5
    assert config.max_retries == 4


def test_invalid_timeout_raises_clear_error(monkeypatch):
    monkeypatch.setenv("AI_TIMEOUT", "abc")
    with pytest.raises(AIConfigError) as exc_info:
        ModelConfig(ModelRole.COACH)
    assert "Invalid AI_TIMEOUT value 'abc'" in str(exc_info.value)


def test_validate_ai_config_helper(monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_API_KEY", "test-key")
    config = validate_ai_config(ModelRole.REASONING)
    assert config.role == ModelRole.REASONING
    assert config.provider == "openai"

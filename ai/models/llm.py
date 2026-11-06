"""
Model/provider abstraction.

Nothing in ai/agents or ai/prompts should import a concrete LangChain chat
model class directly. Everything goes through `get_llm(role)` /
`get_structured_llm(role, schema)`.

Configuration is entirely through environment variables so every logical role
(DEFAULT, COACH, REASONING, LIGHTWEIGHT, VERIFICATION) can point at its own
OpenAI-compatible endpoint, NVIDIA NIM, Anthropic, or local server. Each role
can also have an independent ordered fallback chain.
"""
from __future__ import annotations

import logging
from functools import lru_cache

from langchain_core.language_models.chat_models import BaseChatModel

from ai.config import (
    AIConfigError,
    ModelConfig,
    ModelRole,
    SUPPORTED_PROVIDERS,
    _DEFAULT_MODELS,
    get_fallback_configs,
)

logger = logging.getLogger(__name__)


def _build_chat_model(config: ModelConfig) -> BaseChatModel:
    config.validate()

    if config.provider in ("openai", "openai_compatible", "nvidia", "nvidia_nim"):
        # NVIDIA NIM and most self-hosted providers expose an OpenAI-compatible
        # /v1/chat/completions API, so a single client class covers all of them.
        from langchain_openai import ChatOpenAI

        kwargs = dict(model=config.model, temperature=config.temperature)
        if config.api_key:
            kwargs["api_key"] = config.api_key
        if config.base_url:
            kwargs["base_url"] = config.base_url
        if config.timeout is not None:
            kwargs["timeout"] = config.timeout
        if config.max_retries is not None:
            kwargs["max_retries"] = config.max_retries
        return ChatOpenAI(**kwargs)

    if config.provider == "anthropic":
        from langchain_anthropic import ChatAnthropic

        kwargs = dict(model=config.model, temperature=config.temperature)
        if config.api_key:
            kwargs["api_key"] = config.api_key
        if config.base_url:
            kwargs["base_url"] = config.base_url
        if config.timeout is not None:
            kwargs["default_request_timeout"] = config.timeout
        if config.max_retries is not None:
            kwargs["max_retries"] = config.max_retries
        return ChatAnthropic(**kwargs)

    supported = ", ".join(SUPPORTED_PROVIDERS)
    raise AIConfigError(
        f"AI configuration error:\nUnknown AI_PROVIDER '{config.provider}'. Supported: {supported}."
    )


@lru_cache(maxsize=None)
def get_llm(role: ModelRole = ModelRole.COACH) -> BaseChatModel:
    """Return a cached chat model instance for the given logical role."""
    config = ModelConfig(role)
    return _build_chat_model(config)


@lru_cache(maxsize=None)
def get_fallback_llms(role: ModelRole = ModelRole.COACH) -> tuple[BaseChatModel, ...]:
    """Cached chat models for the role-specific fallback chain (may be empty)."""
    configs = get_fallback_configs(role)
    if configs:
        primary = ModelConfig(role)
        chain = " -> ".join(f"{c.provider}:{c.model}" for c in [primary, *configs])
        logger.info("LLM chain for role %s: %s", role.value, chain)
    return tuple(_build_chat_model(c) for c in configs)


def get_structured_llm(role: ModelRole, schema):
    """Chat model bound to a Pydantic schema via `with_structured_output`.

    When fallback slots are configured, the returned runnable tries the primary
    first and, if the call raises (quota exhausted, 429, timeout, 5xx, ...),
    retries the same request on each fallback in order. Each model is bound to
    the schema individually so every fallback returns the same structured type.
    With no fallbacks configured this is exactly the primary's structured model.

    Callers should still wrap invocation with error handling -- see
    ai/agents/coach/nodes.py.
    """
    primary = get_llm(role).with_structured_output(schema)
    fallbacks = [m.with_structured_output(schema) for m in get_fallback_llms(role)]
    if not fallbacks:
        return primary
    return primary.with_fallbacks(fallbacks)


def clear_llm_cache() -> None:
    """Test/dev helper to reset cached model instances."""
    get_llm.cache_clear()
    get_fallback_llms.cache_clear()

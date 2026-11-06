"""
Centralized AI and LLM configuration.

Each logical AI role can have its own provider, API key, base URL, primary
model, and ordered fallback chain.  The new configuration is role-isolated:

    DEFAULT      -> AI_DEFAULT_*
    COACH        -> AI_COACH_*
    REASONING    -> AI_REASONING_*
    LIGHTWEIGHT  -> AI_LIGHTWEIGHT_*
    VERIFICATION -> AI_VERIFICATION_*

Each fallback uses the same role prefix, for example:
AI_COACH_FALLBACK_1_PROVIDER
AI_COACH_FALLBACK_1_API_KEY
AI_COACH_FALLBACK_1_BASE_URL
AI_COACH_FALLBACK_1_MODEL

Legacy AI_PROVIDER / AI_API_KEY / AI_BASE_URL settings remain supported only
when a role-specific primary configuration is not present. Legacy global
AI_FALLBACK_<n>_* settings are also supported for backward compatibility, but
new role-specific fallback settings take precedence.
"""
from __future__ import annotations

import copy
import os
from enum import Enum
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_ENV_PATH = _PROJECT_ROOT / ".env"
if _ENV_PATH.is_file():
    load_dotenv(dotenv_path=_ENV_PATH)
else:
    load_dotenv()


class ModelRole(str, Enum):
    """Logical roles used by the AI subsystem."""

    DEFAULT = "DEFAULT"
    COACH = "COACH"
    REASONING = "REASONING"
    LIGHTWEIGHT = "LIGHTWEIGHT"
    VERIFICATION = "VERIFICATION"


SUPPORTED_PROVIDERS = (
    "openai",
    "openai_compatible",
    "nvidia",
    "nvidia_nim",
    "anthropic",
)

PROVIDERS_REQUIRING_BASE_URL = (
    "openai_compatible",
    "nvidia",
    "nvidia_nim",
)

_DEFAULT_MODELS: dict[ModelRole, str] = {
    ModelRole.DEFAULT: "gpt-4o-mini",
    ModelRole.COACH: "gpt-4o-mini",
    ModelRole.REASONING: "gpt-4o-mini",
    ModelRole.LIGHTWEIGHT: "gpt-4o-mini",
    ModelRole.VERIFICATION: "gpt-4o-mini",
}

_PROVIDER_DEFAULT_FALLBACKS: dict[str, str] = {
    "openai": "gpt-4o-mini",
    "openai_compatible": "gpt-4o-mini",
    "nvidia": "meta/llama-3.1-8b-instruct",
    "nvidia_nim": "meta/llama-3.1-8b-instruct",
    "anthropic": "claude-3-5-haiku-20241022",
}

MAX_FALLBACK_SLOTS = 5


class AIConfigError(ValueError):
    """Raised when AI configuration is invalid or incomplete."""


def _get_clean_env(name: str) -> Optional[str]:
    value = os.getenv(name)
    if value is None:
        return None
    value = value.strip()
    return value if value else None


def _mask_secret(secret: Optional[str]) -> str:
    return "[CONFIGURED]" if secret else "[NOT SET]"


def _role_prefix(role: ModelRole) -> str:
    return f"AI_{role.value}"


def _has_any_role_primary_setting(role: ModelRole) -> bool:
    prefix = _role_prefix(role)
    return any(
        _get_clean_env(f"{prefix}_{suffix}")
        for suffix in ("PROVIDER", "API_KEY", "BASE_URL", "MODEL")
    )


class ModelConfig:
    """Resolved configuration for one logical AI role.

    New role-specific primary settings are preferred. If no role-specific
    primary setting exists, the old global AI_PROVIDER / AI_API_KEY /
    AI_BASE_URL / AI_MODEL_* settings are used for backward compatibility.
    """

    def __init__(self, role: ModelRole = ModelRole.COACH):
        self.role = role
        role_prefix = _role_prefix(role)
        role_specific = _has_any_role_primary_setting(role)
        self._legacy_mode = not role_specific

        if role_specific:
            raw_provider = _get_clean_env(f"{role_prefix}_PROVIDER") or "openai"
            self.provider = raw_provider.lower()
            self.api_key = _get_clean_env(f"{role_prefix}_API_KEY")
            self.base_url = _get_clean_env(f"{role_prefix}_BASE_URL")
            model = _get_clean_env(f"AI_MODEL_{role.value}")
        else:
            raw_provider = _get_clean_env("AI_PROVIDER") or "openai"
            self.provider = raw_provider.lower()
            self.api_key = _get_clean_env("AI_API_KEY")
            self.base_url = _get_clean_env("AI_BASE_URL")
            model = _get_clean_env(f"AI_MODEL_{role.value}")

        provider_fallback = _PROVIDER_DEFAULT_FALLBACKS.get(
            self.provider, _DEFAULT_MODELS[role]
        )
        self.model = model or _get_clean_env("AI_MODEL_DEFAULT") or provider_fallback

        default_temp = "0.2" if role == ModelRole.REASONING else "0.5"
        raw_temp = (
            _get_clean_env(f"AI_TEMPERATURE_{role.value}")
            or _get_clean_env("AI_TEMPERATURE_DEFAULT")
            or default_temp
        )
        try:
            self.temperature = float(raw_temp)
        except (ValueError, TypeError) as exc:
            raise AIConfigError(
                f"AI configuration error:\nInvalid temperature value '{raw_temp}'. Must be a valid float."
            ) from exc

        raw_timeout = _get_clean_env("AI_TIMEOUT")
        if raw_timeout is not None:
            try:
                self.timeout = float(raw_timeout)
            except ValueError as exc:
                raise AIConfigError(
                    f"AI configuration error:\nInvalid AI_TIMEOUT value '{raw_timeout}'. Must be a number."
                ) from exc
        else:
            self.timeout = 60.0

        raw_retries = _get_clean_env("AI_MAX_RETRIES")
        if raw_retries is not None:
            try:
                self.max_retries = int(raw_retries)
            except ValueError as exc:
                raise AIConfigError(
                    f"AI configuration error:\nInvalid AI_MAX_RETRIES value '{raw_retries}'. Must be an integer."
                ) from exc
        else:
            self.max_retries = 2

    def validate(self) -> None:
        if self.provider not in SUPPORTED_PROVIDERS:
            supported = ", ".join(SUPPORTED_PROVIDERS)
            provider_env = (
                f"AI_{self.role.value}_PROVIDER"
                if not self._legacy_mode
                else "AI_PROVIDER"
            )
            raise AIConfigError(
                f"AI configuration error:\nUnknown {provider_env} '{self.provider}'. "
                f"Supported: {supported}."
            )

        if not self.api_key:
            if self._legacy_mode:
                raise AIConfigError(
                    f"AI configuration error:\nAI_API_KEY is required when AI_PROVIDER={self.provider}"
                )
            raise AIConfigError(
                f"AI configuration error:\nAPI key is required for AI_{self.role.value}_API_KEY when provider={self.provider}"
            )

        if self.provider in PROVIDERS_REQUIRING_BASE_URL and not self.base_url:
            if self._legacy_mode:
                raise AIConfigError(
                    f"AI configuration error:\nAI_BASE_URL is required when AI_PROVIDER={self.provider}"
                )
            raise AIConfigError(
                f"AI configuration error:\nBase URL is required for AI_{self.role.value}_BASE_URL when provider={self.provider}"
            )

    def __repr__(self) -> str:
        return (
            f"ModelConfig(role={self.role.value}, provider='{self.provider}', "
            f"model='{self.model}', temperature={self.temperature}, "
            f"api_key={_mask_secret(self.api_key)}, base_url={self.base_url!r}, "
            f"timeout={self.timeout}, max_retries={self.max_retries})"
        )

    def __str__(self) -> str:
        return (
            f"Role: {self.role.value} | Provider: {self.provider} | Model: {self.model} | "
            f"API Key: {_mask_secret(self.api_key)} | Base URL: {self.base_url or '[None]'}"
        )


def validate_ai_config(role: ModelRole = ModelRole.COACH) -> ModelConfig:
    config = ModelConfig(role)
    config.validate()
    return config


def _legacy_fallback_configs(role: ModelRole) -> list[ModelConfig]:
    """Read the old global fallback format for backward compatibility."""
    primary = ModelConfig(role)
    configs: list[ModelConfig] = []

    for n in range(1, MAX_FALLBACK_SLOTS + 1):
        prefix = f"AI_FALLBACK_{n}_"
        provider = _get_clean_env(f"{prefix}PROVIDER")
        api_key = _get_clean_env(f"{prefix}API_KEY")
        base_url = _get_clean_env(f"{prefix}BASE_URL")
        model = _get_clean_env(f"{prefix}MODEL_{role.value}") or _get_clean_env(f"{prefix}MODEL")

        if not any((provider, api_key, base_url, model)):
            continue
        if not model:
            raise AIConfigError(
                f"AI configuration error:\n{prefix}MODEL is required when other {prefix}* variables are set"
            )

        cfg = copy.copy(primary)
        cfg.model = model
        if provider or base_url:
            if not api_key:
                raise AIConfigError(
                    f"AI configuration error:\n{prefix}API_KEY is required when {prefix}PROVIDER "
                    f"or {prefix}BASE_URL is set"
                )
            cfg.provider = (provider or primary.provider).lower()
            cfg.api_key = api_key
            cfg.base_url = base_url
        elif api_key:
            cfg.api_key = api_key
        cfg.validate()
        configs.append(cfg)

    return configs


def get_fallback_configs(role: ModelRole = ModelRole.COACH) -> list[ModelConfig]:
    """Return the independent fallback chain for ``role``.

    Each configured slot must define its own provider, API key, base URL and
    model. This prevents credentials from one role/provider being reused by a
    different fallback endpoint.
    """
    role_prefix = _role_prefix(role)
    role_has_fallbacks = any(
        _get_clean_env(f"{role_prefix}_FALLBACK_{n}_{suffix}")
        for n in range(1, MAX_FALLBACK_SLOTS + 1)
        for suffix in ("PROVIDER", "API_KEY", "BASE_URL", "MODEL")
    )

    if not role_has_fallbacks:
        return _legacy_fallback_configs(role)

    configs: list[ModelConfig] = []
    for n in range(1, MAX_FALLBACK_SLOTS + 1):
        prefix = f"{role_prefix}_FALLBACK_{n}_"
        provider = _get_clean_env(f"{prefix}PROVIDER")
        api_key = _get_clean_env(f"{prefix}API_KEY")
        base_url = _get_clean_env(f"{prefix}BASE_URL")
        model = _get_clean_env(f"{prefix}MODEL")

        if not any((provider, api_key, base_url, model)):
            continue

        missing = [
            f"{prefix}{name}"
            for name, value in (
                ("PROVIDER", provider),
                ("API_KEY", api_key),
                ("BASE_URL", base_url),
                ("MODEL", model),
            ) if not value
        ]
        if missing:
            raise AIConfigError(
                "AI configuration error:\n"
                f"{prefix} requires: {', '.join(missing)}"
            )

        cfg = copy.copy(ModelConfig(role))
        cfg.provider = provider.lower()
        cfg.api_key = api_key
        cfg.base_url = base_url
        cfg.model = model
        try:
            cfg.validate()
        except AIConfigError as exc:
            raise AIConfigError(f"{exc} (in {prefix} settings)") from exc
        configs.append(cfg)

    return configs

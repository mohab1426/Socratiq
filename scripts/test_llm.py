#!/usr/bin/env python3
"""
Manual smoke test for the real LLM configuration.

Usage:
    python scripts/test_llm.py

Verifies:
- Loads .env file
- Validates configured AI provider and credentials
- Instantiates the configured LLM (ModelRole.COACH)
- Sends a single lightweight test prompt
- Prints the response cleanly without exposing any secrets or API keys
"""
from __future__ import annotations

import sys
from pathlib import Path

# Ensure project root is in sys.path
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from ai.config import AIConfigError, ModelRole, validate_ai_config
from ai.models.llm import get_llm


def run_llm_smoke_test() -> int:
    print("==================================================")
    print("The Socratic Class - Real LLM Smoke Test")
    print("==================================================")

    # 1. Validate configuration
    try:
        config = validate_ai_config(ModelRole.COACH)
        print(f"Provider:    {config.provider}")
        print(f"Model:       {config.model}")
        print(f"Base URL:    {config.base_url or '[Default/Official]'}")
        print(f"Temperature: {config.temperature}")
        print(f"Timeout:     {config.timeout}s")
        print("API Key:     [CONFIGURED]")
        print("Configuration status: VALID\n")
    except AIConfigError as err:
        print("\n[Configuration Incomplete or Invalid]")
        print(f"{err}\n")
        print("To run real LLM calls, please edit .env and configure your AI provider and API key.")
        return 1
    except Exception as exc:
        print(f"\nUnexpected configuration error: {exc}")
        return 1

    # 2. Instantiate LLM and send minimal test prompt
    print("Instantiating configured LLM...")
    try:
        llm = get_llm(ModelRole.COACH)
    except Exception as exc:
        print(f"Error initializing model client: {exc}")
        return 1

    test_prompt = "Say 'The Socratic Class is ready!' in 7 words or less."
    print(f"Sending test prompt: {test_prompt!r}")

    try:
        response = llm.invoke(test_prompt)
        response_text = response.content if hasattr(response, "content") else str(response)
        print("\n--- Response Received ---")
        print(response_text.strip())
        print("-------------------------\n")
        print("SUCCESS: Real LLM smoke test passed!")
        return 0
    except Exception as exc:
        print("\n[LLM Execution Failed]")
        print(f"Error communicating with provider endpoint: {exc}")
        print("\nPlease check your API key, base URL, network access, or provider service status.")
        return 2


if __name__ == "__main__":
    sys.exit(run_llm_smoke_test())

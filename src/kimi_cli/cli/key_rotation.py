"""API key rotation for Kimi's Anthropic-compatible endpoint.

Discovers API keys from multiple sources, validates them, and rotates
to avoid rate-limited keys.
"""

from __future__ import annotations

import hashlib
import json
import time
from pathlib import Path
from typing import Any

import httpx
import tomlkit

# How long to cool down a rate-limited key (seconds)
_RATE_LIMIT_COOLDOWN = 300  # 5 minutes

# Validation endpoint
_MODELS_URL = "https://api.kimi.com/coding/v1/models"

# Default state directory
_DEFAULT_STATE_DIR = Path.home() / ".claude-kimigas"


def _key_hash(key: str) -> str:
    """Return a short SHA-256 hash prefix for a key (no plaintext in state)."""
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def _discover_keys_from_accounts() -> list[str]:
    """Scan ~/.kimi-accounts/*/config.toml for api_key fields."""
    accounts_dir = Path.home() / ".kimi-accounts"
    if not accounts_dir.is_dir():
        return []

    keys: list[str] = []
    for account_dir in sorted(accounts_dir.iterdir()):
        config_file = account_dir / "config.toml"
        if not config_file.is_file():
            continue
        try:
            doc = tomlkit.loads(config_file.read_text())
        except Exception:
            continue

        # Look for api_key in any [providers.*] section
        providers = doc.get("providers", {})
        for _name, provider in providers.items():
            if not isinstance(provider, dict):
                continue
            api_key = provider.get("api_key", "")
            if api_key and isinstance(api_key, str) and api_key.startswith("sk-"):
                keys.append(api_key)
    return keys


def _discover_all_keys(explicit_key: str | None = None) -> list[str]:
    """Combine all key sources, deduplicated by hash.

    Priority order:
      1. Explicit --api-key flag
      2. KIMI_API_KEYS env var (colon-separated)
      3. KIMI_API_KEY env var
      4. Account discovery (~/.kimi-accounts/*)
    """
    import os

    candidates: list[str] = []

    if explicit_key:
        candidates.append(explicit_key)

    env_keys = os.getenv("KIMI_API_KEYS", "")
    if env_keys:
        candidates.extend(k.strip() for k in env_keys.split(":") if k.strip())

    env_key = os.getenv("KIMI_API_KEY", "")
    if env_key:
        candidates.append(env_key)

    candidates.extend(_discover_keys_from_accounts())

    # Deduplicate by hash, preserving order
    seen: set[str] = set()
    unique: list[str] = []
    for key in candidates:
        h = _key_hash(key)
        if h not in seen:
            seen.add(h)
            unique.append(key)
    return unique


def _load_state(state_dir: Path) -> dict[str, Any]:
    """Load rotation state from key-rotation.json."""
    state_file = state_dir / "key-rotation.json"
    if state_file.is_file():
        try:
            return json.loads(state_file.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_state(state_dir: Path, state: dict[str, Any]) -> None:
    """Save rotation state to key-rotation.json."""
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / "key-rotation.json"
    state_file.write_text(json.dumps(state, indent=2))


def _validate_key(key: str) -> str | None:
    """Quick validation: GET /v1/models with 5s timeout.

    Returns None if OK, error string if failed (429, 401, etc).
    """
    try:
        resp = httpx.get(
            _MODELS_URL,
            headers={"Authorization": f"Bearer {key}"},
            timeout=5.0,
        )
        if resp.status_code == 200:
            return None
        return f"HTTP {resp.status_code}"
    except httpx.TimeoutException:
        return "timeout"
    except Exception as e:
        return str(e)


def select_best_key(
    explicit_key: str | None = None,
    state_dir: Path | None = None,
) -> tuple[str, int]:
    """Select the best available API key using LRU rotation.

    Returns:
        Tuple of (selected_key, total_keys_available).

    Raises:
        RuntimeError: If no valid keys are found.
    """
    if state_dir is None:
        state_dir = _DEFAULT_STATE_DIR

    keys = _discover_all_keys(explicit_key)
    if not keys:
        raise RuntimeError(
            "No Kimi API keys found. Provide via:\n"
            "  --api-key flag, KIMI_API_KEY env var, or ~/.kimi-accounts/*/config.toml"
        )

    # Single key — skip rotation logic
    if len(keys) == 1:
        return keys[0], 1

    state = _load_state(state_dir)
    now = time.time()

    # Filter out rate-limited keys (within cooldown window)
    rate_limited: dict[str, float] = state.get("rate_limited", {})
    available = [
        k for k in keys
        if now - rate_limited.get(_key_hash(k), 0) > _RATE_LIMIT_COOLDOWN
    ]

    # If all keys are rate-limited, use all of them (pick LRU)
    if not available:
        available = keys

    # LRU: pick the key least recently used
    last_used: dict[str, float] = state.get("last_used", {})
    available.sort(key=lambda k: last_used.get(_key_hash(k), 0))
    selected = available[0]

    # Validate the selected key
    error = _validate_key(selected)
    if error:
        # Mark as rate-limited and try next
        rate_limited[_key_hash(selected)] = now
        state["rate_limited"] = rate_limited
        _save_state(state_dir, state)

        # Try remaining keys
        for fallback in available[1:]:
            fb_error = _validate_key(fallback)
            if fb_error is None:
                last_used[_key_hash(fallback)] = now
                state["last_used"] = last_used
                _save_state(state_dir, state)
                return fallback, len(keys)
            rate_limited[_key_hash(fallback)] = now

        state["rate_limited"] = rate_limited
        _save_state(state_dir, state)

        # All keys failed validation — fall back to LRU pick anyway
        # (validation endpoint might be down but key still works)
        selected = available[0]

    # Record usage
    last_used[_key_hash(selected)] = now
    state["last_used"] = last_used
    _save_state(state_dir, state)

    return selected, len(keys)

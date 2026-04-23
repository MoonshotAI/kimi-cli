from __future__ import annotations

import asyncio
import json
import os
import platform
import random
import socket
import sys
import tempfile
import time
import uuid
import webbrowser
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, cast

import aiohttp
import keyring
from pydantic import SecretStr

from kimi_cli.auth import KIMI_CODE_PLATFORM_ID
from kimi_cli.auth.platforms import (
    ModelInfo,
    get_platform_by_id,
    list_models,
    managed_model_key,
    managed_provider_key,
)
from kimi_cli.config import (
    Config,
    LLMModel,
    LLMProvider,
    MoonshotFetchConfig,
    MoonshotSearchConfig,
    OAuthRef,
    save_config,
)
from kimi_cli.constant import VERSION
from kimi_cli.share import get_share_dir
from kimi_cli.utils.aiohttp import new_client_session
from kimi_cli.utils.logging import logger

if TYPE_CHECKING:
    from kimi_cli.soul.agent import Runtime


KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
KIMI_CODE_OAUTH_KEY = "oauth/kimi-code"
DEFAULT_OAUTH_HOST = "https://auth.kimi.com"
KEYRING_SERVICE = "kimi-code"
REFRESH_INTERVAL_SECONDS = 60
MIN_REFRESH_THRESHOLD_SECONDS = 300
REFRESH_THRESHOLD_RATIO = 0.5
UNAUTHORIZED_REFRESH_RETRY_COOLDOWN_SECONDS = 300
_CROSS_PROCESS_LOCK_RETRIES = 5
_RETRYABLE_REFRESH_STATUSES = {429, 500, 502, 503, 504}


def _refresh_threshold(expires_in: float) -> float:
    """Return the dynamic refresh threshold in seconds."""
    if expires_in > 0:
        return max(MIN_REFRESH_THRESHOLD_SECONDS, expires_in * REFRESH_THRESHOLD_RATIO)
    return MIN_REFRESH_THRESHOLD_SECONDS


class OAuthError(RuntimeError):
    """OAuth flow error."""


class OAuthUnauthorized(OAuthError):
    """OAuth credentials rejected."""


class _RetryableRefreshError(OAuthError):
    """Transient HTTP error during token refresh (5xx / 429)."""


class OAuthDeviceExpired(OAuthError):
    """Device authorization expired."""


OAuthEventKind = Literal["info", "error", "waiting", "verification_url", "success"]


@dataclass(slots=True, frozen=True)
class OAuthEvent:
    type: OAuthEventKind
    message: str
    data: dict[str, Any] | None = None

    def __str__(self) -> str:
        return self.message

    @property
    def json(self) -> str:
        payload: dict[str, Any] = {"type": self.type, "message": self.message}
        if self.data is not None:
            payload["data"] = self.data
        return json.dumps(payload, ensure_ascii=False)


@dataclass(slots=True)
class OAuthToken:
    access_token: str
    refresh_token: str
    expires_at: float
    scope: str
    token_type: str
    expires_in: float = 0.0

    @classmethod
    def from_response(cls, payload: dict[str, Any]) -> OAuthToken:
        expires_in = float(payload["expires_in"])
        return cls(
            access_token=str(payload["access_token"]),
            refresh_token=str(payload["refresh_token"]),
            expires_at=time.time() + expires_in,
            scope=str(payload["scope"]),
            token_type=str(payload["token_type"]),
            expires_in=expires_in,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "scope": self.scope,
            "token_type": self.token_type,
            "expires_in": self.expires_in,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> OAuthToken:
        expires_at_value = payload.get("expires_at")
        return cls(
            access_token=str(payload.get("access_token") or ""),
            refresh_token=str(payload.get("refresh_token") or ""),
            expires_at=float(expires_at_value) if expires_at_value is not None else 0.0,
            scope=str(payload.get("scope") or ""),
            token_type=str(payload.get("token_type") or ""),
            expires_in=float(payload.get("expires_in") or 0),
        )


@dataclass(slots=True)
class _RejectedRefreshState:
    refresh_token: str
    retry_after: float


# Process-wide tombstone for refresh tokens that the server has rejected.
#
# Intentionally module-level rather than per-OAuthManager: OAuth credentials
# are a process-wide resource (all managers in this process share the same
# credentials file), so all managers should see the same "recently rejected"
# state.  Without this, one manager's rejection would leave the persisted
# token visible to the next manager that loads from disk, and we'd re-issue
# the same dead refresh request and re-shadow a configured api_key fallback.
#
# Cross-process sharing is unnecessary — each process discovers the rejection
# independently on its first attempt, and the tombstone auto-clears when the
# on-disk refresh_token differs from the rejected one (i.e. another process
# successfully rotated, or /login atomically rewrote the file).
_REJECTED_REFRESH_TOKENS: dict[str, _RejectedRefreshState] = {}


@dataclass(slots=True)
class DeviceAuthorization:
    user_code: str
    device_code: str
    verification_uri: str
    verification_uri_complete: str
    expires_in: int | None
    interval: int


def _oauth_host() -> str:
    return os.getenv("KIMI_CODE_OAUTH_HOST") or os.getenv("KIMI_OAUTH_HOST") or DEFAULT_OAUTH_HOST


def _device_id_path() -> Path:
    return get_share_dir() / "device_id"


def _ensure_private_file(path: Path) -> None:
    with suppress(OSError):
        os.chmod(path, 0o600)


def _device_model() -> str:
    system = platform.system()
    arch = platform.machine() or ""
    if system == "Darwin":
        version = platform.mac_ver()[0] or platform.release()
        if version and arch:
            return f"macOS {version} {arch}"
        if version:
            return f"macOS {version}"
        return f"macOS {arch}".strip()
    if system == "Windows":
        release = platform.release()
        if release == "10":
            try:
                build = sys.getwindowsversion().build  # type: ignore[attr-defined]
            except Exception:
                build = None
            if build and build >= 22000:
                release = "11"
        if release and arch:
            return f"Windows {release} {arch}"
        if release:
            return f"Windows {release}"
        return f"Windows {arch}".strip()
    if system:
        version = platform.release()
        if version and arch:
            return f"{system} {version} {arch}"
        if version:
            return f"{system} {version}"
        return f"{system} {arch}".strip()
    return "Unknown"


def get_device_id() -> str:
    path = _device_id_path()
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    device_id = uuid.uuid4().hex
    path.write_text(device_id, encoding="utf-8")
    _ensure_private_file(path)
    from kimi_cli.telemetry import track

    track("first_launch")
    return device_id


def _ascii_header_value(value: str, *, fallback: str = "unknown") -> str:
    try:
        value.encode("ascii")
        return value.strip()
    except UnicodeEncodeError:
        sanitized = value.encode("ascii", errors="ignore").decode("ascii").strip()
        return sanitized or fallback


def _common_headers() -> dict[str, str]:
    device_name = platform.node() or socket.gethostname()
    device_model = _device_model()
    headers = {
        "X-Msh-Platform": "kimi_cli",
        "X-Msh-Version": VERSION,
        "X-Msh-Device-Name": device_name,
        "X-Msh-Device-Model": device_model,
        "X-Msh-Os-Version": platform.version(),
        "X-Msh-Device-Id": get_device_id(),
    }
    return {key: _ascii_header_value(value) for key, value in headers.items()}


def _credentials_dir() -> Path:
    path = get_share_dir() / "credentials"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _credentials_path(key: str) -> Path:
    name = key.removeprefix("oauth/").split("/")[-1] or key
    return _credentials_dir() / f"{name}.json"


def _credentials_lock_path(key: str) -> Path:
    name = key.removeprefix("oauth/").split("/")[-1] or key
    return _credentials_dir() / f"{name}.lock"


class _CrossProcessLock:
    """File-based lock that coordinates token refresh across kimi-cli processes.

    Uses fcntl.flock on Unix and msvcrt.locking on Windows.
    """

    def __init__(self, key: str) -> None:
        self._path = _credentials_lock_path(key)
        self._fd: int | None = None

    def _acquire(self) -> bool:
        """Acquire the lock.

        Returns ``True`` if locked, ``False`` on contention.
        Raises ``OSError`` if the lock file cannot be opened (permanent failure).
        """
        self._fd = os.open(str(self._path), os.O_CREAT | os.O_RDWR, 0o600)
        try:
            if sys.platform == "win32":
                import msvcrt

                # msvcrt.locking requires bytes to exist at the lock position.
                if os.fstat(self._fd).st_size == 0:
                    os.write(self._fd, b"\0")
                    os.lseek(self._fd, 0, os.SEEK_SET)
                msvcrt.locking(self._fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            os.close(self._fd)
            self._fd = None
            return False

    def release(self) -> None:
        if self._fd is not None:
            try:
                if sys.platform == "win32":
                    import msvcrt

                    with suppress(OSError):
                        os.lseek(self._fd, 0, os.SEEK_SET)
                        msvcrt.locking(self._fd, msvcrt.LK_UNLCK, 1)
            finally:
                with suppress(OSError):
                    os.close(self._fd)
                self._fd = None

    async def acquire_with_retry(self) -> bool:
        for _attempt in range(_CROSS_PROCESS_LOCK_RETRIES):
            try:
                if self._acquire():
                    return True
            except OSError:
                # Cannot open/create the lock file (permissions, read-only FS, etc.).
                # Permanent failure — skip backoff and fall back to unlocked refresh.
                return False
            await asyncio.sleep(1 + random.random())
            # After waiting, re-check if the token was refreshed by the holder.
        try:
            return self._acquire()
        except OSError:
            return False

    async def __aenter__(self) -> bool:
        return await self.acquire_with_retry()

    async def __aexit__(self, *args: object) -> None:
        self.release()


def _load_from_keyring(key: str) -> OAuthToken | None:
    try:
        raw = keyring.get_password(KEYRING_SERVICE, key)
    except Exception as exc:
        logger.warning("Failed to read token from keyring: {error}", error=exc)
        return None
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    payload = cast(dict[str, Any], payload)
    return OAuthToken.from_dict(payload)


def _delete_from_keyring(key: str) -> None:
    try:
        keyring.delete_password(KEYRING_SERVICE, key)
    except Exception:
        return


def _load_from_file(key: str) -> OAuthToken | None:
    path = _credentials_path(key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(payload, dict):
        return None
    payload = cast(dict[str, Any], payload)
    return OAuthToken.from_dict(payload)


def _save_to_file(key: str, token: OAuthToken) -> None:
    path = _credentials_path(key)
    fd, tmp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        data = json.dumps(token.to_dict(), ensure_ascii=False).encode("utf-8")
        written = os.write(fd, data)
        if written != len(data):
            raise OSError(f"Short write: {written}/{len(data)} bytes")
        os.fsync(fd)
        os.close(fd)
        fd = -1
        with suppress(OSError):
            os.chmod(tmp_path, 0o600)
        os.replace(tmp_path, path)
    except BaseException:
        if fd >= 0:
            with suppress(OSError):
                os.close(fd)
        with suppress(OSError):
            os.unlink(tmp_path)
        raise


def _delete_from_file(key: str) -> None:
    path = _credentials_path(key)
    if path.exists():
        path.unlink()


def load_tokens(ref: OAuthRef) -> OAuthToken | None:
    file_token = _load_from_file(ref.key)
    if file_token is not None:
        return file_token
    if ref.storage != "keyring":
        return None
    token = _load_from_keyring(ref.key)
    if token is None:
        return None
    try:
        _save_to_file(ref.key, token)
    except OSError as exc:
        logger.warning("Failed to migrate token from keyring to file: {error}", error=exc)
    else:
        with suppress(Exception):
            _delete_from_keyring(ref.key)
    return token


def save_tokens(ref: OAuthRef, token: OAuthToken) -> OAuthRef:
    if ref.storage == "keyring":
        logger.warning("Keyring storage is deprecated; saving OAuth tokens to file.")
        ref = OAuthRef(storage="file", key=ref.key)
    _save_to_file(ref.key, token)
    return ref


def delete_tokens(ref: OAuthRef) -> None:
    if ref.storage == "keyring":
        _delete_from_keyring(ref.key)
    _delete_from_file(ref.key)


async def request_device_authorization() -> DeviceAuthorization:
    async with (
        new_client_session() as session,
        session.post(
            f"{_oauth_host().rstrip('/')}/api/oauth/device_authorization",
            data={"client_id": KIMI_CODE_CLIENT_ID},
            headers=_common_headers(),
        ) as response,
    ):
        data = await response.json(content_type=None)
        status = response.status
    if status != 200:
        raise OAuthError(f"Device authorization failed: {data}")
    return DeviceAuthorization(
        user_code=str(data["user_code"]),
        device_code=str(data["device_code"]),
        verification_uri=str(data.get("verification_uri") or ""),
        verification_uri_complete=str(data["verification_uri_complete"]),
        expires_in=int(data.get("expires_in") or 0) or None,
        interval=int(data.get("interval") or 5),
    )


async def _request_device_token(auth: DeviceAuthorization) -> tuple[int, dict[str, Any]]:
    try:
        async with (
            new_client_session() as session,
            session.post(
                f"{_oauth_host().rstrip('/')}/api/oauth/token",
                data={
                    "client_id": KIMI_CODE_CLIENT_ID,
                    "device_code": auth.device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
                headers=_common_headers(),
            ) as response,
        ):
            data_any: Any = await response.json(content_type=None)
            status = response.status
    except aiohttp.ClientError as exc:
        raise OAuthError("Token polling request failed.") from exc
    if not isinstance(data_any, dict):
        raise OAuthError("Unexpected token polling response.")
    data = cast(dict[str, Any], data_any)
    if status >= 500:
        raise OAuthError(f"Token polling server error: {status}.")
    return status, data


async def refresh_token(refresh_token: str, *, max_retries: int = 3) -> OAuthToken:
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            async with (
                new_client_session() as session,
                session.post(
                    f"{_oauth_host().rstrip('/')}/api/oauth/token",
                    data={
                        "client_id": KIMI_CODE_CLIENT_ID,
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                    },
                    headers=_common_headers(),
                ) as response,
            ):
                status = response.status
                data: dict[str, Any]
                try:
                    data = await response.json(content_type=None)
                except (json.JSONDecodeError, aiohttp.ContentTypeError):
                    data = {}
            if status in (401, 403):
                raise OAuthUnauthorized(
                    data.get("error_description") or "Token refresh unauthorized."
                )
            if status != 200:
                desc = data.get("error_description") or f"Token refresh failed (HTTP {status})."
                if status in _RETRYABLE_REFRESH_STATUSES:
                    raise _RetryableRefreshError(desc)
                raise OAuthError(desc)
            return OAuthToken.from_response(data)
        except OAuthUnauthorized:
            raise
        except (aiohttp.ClientError, TimeoutError, OSError, _RetryableRefreshError) as exc:
            last_exc = exc
            if attempt < max_retries - 1:
                await asyncio.sleep(2**attempt)
                logger.warning(
                    "Token refresh attempt {attempt} failed, retrying: {error}",
                    attempt=attempt + 1,
                    error=exc,
                )
    raise OAuthError("Token refresh failed after retries.") from last_exc


def _select_default_model_and_thinking(models: list[ModelInfo]) -> tuple[ModelInfo, bool] | None:
    if not models:
        return None
    selected_model = models[0]
    capabilities = selected_model.capabilities
    thinking = "thinking" in capabilities or "always_thinking" in capabilities
    return selected_model, thinking


def _apply_kimi_code_config(
    config: Config,
    *,
    models: list[ModelInfo],
    selected_model: ModelInfo,
    thinking: bool,
    oauth_ref: OAuthRef,
) -> None:
    platform = get_platform_by_id(KIMI_CODE_PLATFORM_ID)
    if platform is None:
        raise OAuthError("Kimi Code platform not found.")

    provider_key = managed_provider_key(platform.id)
    config.providers[provider_key] = LLMProvider(
        type="kimi",
        base_url=platform.base_url,
        api_key=SecretStr(""),
        oauth=oauth_ref,
    )

    for key, model in list(config.models.items()):
        if model.provider == provider_key:
            del config.models[key]

    for model_info in models:
        capabilities = model_info.capabilities or None
        config.models[managed_model_key(platform.id, model_info.id)] = LLMModel(
            provider=provider_key,
            model=model_info.id,
            max_context_size=model_info.context_length,
            capabilities=capabilities,
            display_name=model_info.display_name,
        )

    config.default_model = managed_model_key(platform.id, selected_model.id)
    config.default_thinking = thinking

    if platform.search_url:
        config.services.moonshot_search = MoonshotSearchConfig(
            base_url=platform.search_url,
            api_key=SecretStr(""),
            oauth=oauth_ref,
        )

    if platform.fetch_url:
        config.services.moonshot_fetch = MoonshotFetchConfig(
            base_url=platform.fetch_url,
            api_key=SecretStr(""),
            oauth=oauth_ref,
        )


async def login_kimi_code(
    config: Config, *, open_browser: bool = True
) -> AsyncIterator[OAuthEvent]:
    if not config.is_from_default_location:
        yield OAuthEvent(
            "error",
            "Login requires the default config file; restart without --config/--config-file.",
        )
        return

    platform = get_platform_by_id(KIMI_CODE_PLATFORM_ID)
    if platform is None:
        yield OAuthEvent("error", "Kimi Code platform is unavailable.")
        return

    auth: DeviceAuthorization
    token: OAuthToken | None = None
    while True:
        try:
            auth = await request_device_authorization()
        except Exception as exc:
            yield OAuthEvent("error", f"Login failed: {exc}")
            return

        yield OAuthEvent(
            "info",
            "Please visit the following URL to finish authorization.",
        )
        yield OAuthEvent(
            "verification_url",
            f"Verification URL: {auth.verification_uri_complete}",
            data={
                "verification_url": auth.verification_uri_complete,
                "user_code": auth.user_code,
            },
        )
        if open_browser:
            try:
                webbrowser.open(auth.verification_uri_complete)
            except Exception as exc:
                logger.warning("Failed to open browser: {error}", error=exc)

        interval = max(auth.interval, 1)
        printed_wait = False
        try:
            while True:
                status, data = await _request_device_token(auth)
                if status == 200 and "access_token" in data:
                    token = OAuthToken.from_response(data)
                    break
                error_code = str(data.get("error") or "unknown_error")
                if error_code == "expired_token":
                    raise OAuthDeviceExpired("Device code expired.")
                error_description = str(data.get("error_description") or "")
                if not printed_wait:
                    yield OAuthEvent(
                        "waiting",
                        f"Waiting for user authorization...: {error_description.strip()}",
                        data={
                            "error": error_code,
                            "error_description": error_description,
                        },
                    )
                    printed_wait = True
                await asyncio.sleep(interval)
        except OAuthDeviceExpired:
            yield OAuthEvent("info", "Device code expired, restarting login...")
            continue
        except Exception as exc:
            yield OAuthEvent("error", f"Login failed: {exc}")
            return
        break

    assert token is not None

    oauth_ref = OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY)
    oauth_ref = save_tokens(oauth_ref, token)

    try:
        models = await list_models(platform, token.access_token)
    except Exception as exc:
        logger.error("Failed to get models: {error}", error=exc)
        yield OAuthEvent("error", f"Failed to get models: {exc}")
        return

    if not models:
        yield OAuthEvent("error", "No models available for the selected platform.")
        return

    selection = _select_default_model_and_thinking(models)
    if selection is None:
        return
    selected_model, thinking = selection

    _apply_kimi_code_config(
        config,
        models=models,
        selected_model=selected_model,
        thinking=thinking,
        oauth_ref=oauth_ref,
    )
    save_config(config)
    yield OAuthEvent("success", "Logged in successfully.")
    return


async def logout_kimi_code(config: Config) -> AsyncIterator[OAuthEvent]:
    if not config.is_from_default_location:
        yield OAuthEvent(
            "error",
            "Logout requires the default config file; restart without --config/--config-file.",
        )
        return

    delete_tokens(OAuthRef(storage="keyring", key=KIMI_CODE_OAUTH_KEY))
    delete_tokens(OAuthRef(storage="file", key=KIMI_CODE_OAUTH_KEY))

    provider_key = managed_provider_key(KIMI_CODE_PLATFORM_ID)
    if provider_key in config.providers:
        del config.providers[provider_key]

    removed_default = False
    for key, model in list(config.models.items()):
        if model.provider != provider_key:
            continue
        del config.models[key]
        if config.default_model == key:
            removed_default = True

    if removed_default:
        config.default_model = ""

    config.services.moonshot_search = None
    config.services.moonshot_fetch = None

    save_config(config)
    yield OAuthEvent("success", "Logged out successfully.")
    return


class OAuthManager:
    def __init__(self, config: Config) -> None:
        self._config = config
        # Cache access tokens only; refresh tokens are always read from persisted storage.
        self._access_tokens: dict[str, str] = {}
        self._refresh_lock = asyncio.Lock()
        self._migrate_oauth_storage()
        self._load_initial_tokens()

    def _iter_oauth_refs(self) -> list[OAuthRef]:
        refs: list[OAuthRef] = []
        for provider in self._config.providers.values():
            if provider.oauth:
                refs.append(provider.oauth)
        for service in (
            self._config.services.moonshot_search,
            self._config.services.moonshot_fetch,
        ):
            if service and service.oauth:
                refs.append(service.oauth)
        return refs

    def _migrate_oauth_storage(self) -> None:
        migrated_keys: set[str] = set()
        changed = False

        def _migrate_ref(ref: OAuthRef) -> OAuthRef:
            nonlocal changed
            if ref.storage != "keyring":
                return ref
            if ref.key not in migrated_keys:
                load_tokens(ref)
                migrated_keys.add(ref.key)
            changed = True
            return OAuthRef(storage="file", key=ref.key)

        for provider in self._config.providers.values():
            if provider.oauth:
                provider.oauth = _migrate_ref(provider.oauth)

        for service in (
            self._config.services.moonshot_search,
            self._config.services.moonshot_fetch,
        ):
            if service and service.oauth:
                service.oauth = _migrate_ref(service.oauth)

        if changed and self._config.is_from_default_location:
            save_config(self._config)

    def _load_initial_tokens(self) -> None:
        for ref in self._iter_oauth_refs():
            token = load_tokens(ref)
            if token and not self._should_suppress_persisted_token(ref, token):
                self._cache_access_token(ref, token)

    def _rejected_refresh_state(
        self, ref: OAuthRef, refresh_token: str | None
    ) -> _RejectedRefreshState | None:
        if not refresh_token:
            return None
        state = _REJECTED_REFRESH_TOKENS.get(ref.key)
        if state and state.refresh_token != refresh_token:
            _REJECTED_REFRESH_TOKENS.pop(ref.key, None)
            return None
        return state

    def _should_suppress_persisted_token(self, ref: OAuthRef, token: OAuthToken) -> bool:
        return self._rejected_refresh_state(ref, token.refresh_token) is not None

    def _can_retry_rejected_refresh_token(self, ref: OAuthRef, refresh_token: str | None) -> bool:
        state = self._rejected_refresh_state(ref, refresh_token)
        return state is None or time.time() >= state.retry_after

    def _mark_refresh_token_rejected(self, ref: OAuthRef, refresh_token: str) -> None:
        if not refresh_token:
            return
        _REJECTED_REFRESH_TOKENS[ref.key] = _RejectedRefreshState(
            refresh_token=refresh_token,
            retry_after=time.time() + UNAUTHORIZED_REFRESH_RETRY_COOLDOWN_SECONDS,
        )

    def _clear_rejected_refresh_token(self, ref: OAuthRef) -> None:
        _REJECTED_REFRESH_TOKENS.pop(ref.key, None)

    def _cache_access_token(self, ref: OAuthRef, token: OAuthToken) -> None:
        if not token.access_token:
            self._access_tokens.pop(ref.key, None)
            return
        self._access_tokens[ref.key] = token.access_token

    def get_cached_access_token(self, key: str) -> str | None:
        """Get a cached access token by key, or None if not available."""
        return self._access_tokens.get(key)

    def common_headers(self) -> dict[str, str]:
        return _common_headers()

    def resolve_api_key(self, api_key: SecretStr, oauth: OAuthRef | None) -> str:
        if oauth:
            token = self._access_tokens.get(oauth.key)
            if token is None:
                persisted = load_tokens(oauth)
                if persisted and not self._should_suppress_persisted_token(oauth, persisted):
                    self._cache_access_token(oauth, persisted)
                    token = self._access_tokens.get(oauth.key)
            if token:
                return token
            logger.warning(
                "OAuth ref present (key={key}) but no access token resolved; "
                "falling back to configured api_key",
                key=oauth.key,
            )
        return api_key.get_secret_value()

    def _kimi_code_ref(self) -> OAuthRef | None:
        provider_key = managed_provider_key(KIMI_CODE_PLATFORM_ID)
        provider = self._config.providers.get(provider_key)
        if provider and provider.oauth:
            return provider.oauth
        for service in (
            self._config.services.moonshot_search,
            self._config.services.moonshot_fetch,
        ):
            if service and service.oauth and service.oauth.key == KIMI_CODE_OAUTH_KEY:
                return service.oauth
        return None

    async def ensure_fresh(self, runtime: Runtime | None = None, *, force: bool = False) -> None:
        """Load persisted tokens, cache them, and refresh if close to expiry.

        Args:
            runtime: When provided the live LLM client's API key is updated
                in-place.  Pass ``None`` for lightweight callers (e.g. title
                generation) that only need the internal cache to be current.
            force: When True, skip the expiry-threshold check and always
                attempt a refresh.  Used after receiving a 401 from the server.
        """
        ref = self._kimi_code_ref()
        if ref is None:
            return
        token = load_tokens(ref)
        if token is None:
            return
        if self._should_suppress_persisted_token(ref, token):
            self._access_tokens.pop(ref.key, None)
            self._apply_access_token(runtime, "")
            if not self._can_retry_rejected_refresh_token(ref, token.refresh_token):
                if force:
                    raise OAuthUnauthorized("Refresh token was recently rejected.")
                return
        else:
            self._cache_access_token(ref, token)
            if token.access_token:
                self._apply_access_token(runtime, token.access_token)
        await self._refresh_tokens(ref, token, runtime, force=force)

    @asynccontextmanager
    async def refreshing(self, runtime: Runtime) -> AsyncIterator[None]:
        stop_event = asyncio.Event()

        async def _runner() -> None:
            try:
                while True:
                    wall_before = time.time()
                    try:
                        await asyncio.wait_for(
                            stop_event.wait(),
                            timeout=REFRESH_INTERVAL_SECONDS,
                        )
                        return
                    except TimeoutError:
                        pass
                    elapsed = time.time() - wall_before
                    force = elapsed > REFRESH_INTERVAL_SECONDS * 2
                    if force:
                        logger.info(
                            "Detected possible sleep/wake ({elapsed:.0f}s elapsed), "
                            "forcing token refresh.",
                            elapsed=elapsed,
                        )
                    try:
                        await self.ensure_fresh(runtime, force=force)
                    except Exception as exc:
                        logger.warning(
                            "Failed to refresh OAuth token in background: {error}",
                            error=exc,
                        )
            except asyncio.CancelledError:
                pass

        await self.ensure_fresh(runtime)
        refresh_task = asyncio.create_task(_runner())
        try:
            yield
        finally:
            stop_event.set()
            refresh_task.cancel()
            with suppress(asyncio.CancelledError):
                await refresh_task

    async def _refresh_tokens(
        self,
        ref: OAuthRef,
        token: OAuthToken,
        runtime: Runtime | None,
        *,
        force: bool = False,
    ) -> None:
        # Always prefer persisted tokens before refresh to avoid stale cache
        # when multiple sessions might have already rotated the refresh token.
        persisted = load_tokens(ref)
        if persisted and not self._should_suppress_persisted_token(ref, persisted):
            self._cache_access_token(ref, persisted)
        current_token = persisted or token
        if not current_token.refresh_token:
            return
        async with self._refresh_lock:
            # Re-check persisted token inside the in-process lock.
            persisted = load_tokens(ref)
            if persisted and not self._should_suppress_persisted_token(ref, persisted):
                self._cache_access_token(ref, persisted)
            current = persisted or current_token
            if not force:
                now = time.time()
                if (
                    current.expires_at
                    and current.expires_at > now
                    and current.expires_at - now >= _refresh_threshold(current.expires_in)
                ):
                    return
            refresh_token_value = current.refresh_token
            if not refresh_token_value:
                return
            if self._should_suppress_persisted_token(
                ref, current
            ) and not self._can_retry_rejected_refresh_token(ref, refresh_token_value):
                self._access_tokens.pop(ref.key, None)
                self._apply_access_token(runtime, "")
                if force:
                    raise OAuthUnauthorized("Refresh token was recently rejected.")
                return

            # Acquire cross-process file lock to coordinate with other
            # kimi-cli instances (terminal, VS Code, web).
            xlock = _CrossProcessLock(ref.key)
            acquired = await xlock.acquire_with_retry()
            try:
                if acquired:
                    # Triple-check after acquiring the lock — another process
                    # may have refreshed while we waited.
                    locked_token = load_tokens(ref)
                    if locked_token and locked_token.refresh_token != refresh_token_value:
                        self._clear_rejected_refresh_token(ref)
                        self._cache_access_token(ref, locked_token)
                        self._apply_access_token(runtime, locked_token.access_token)
                        return
                    if not force and locked_token:
                        remaining = locked_token.expires_at - time.time()
                        if locked_token.expires_at and remaining >= _refresh_threshold(
                            locked_token.expires_in
                        ):
                            self._clear_rejected_refresh_token(ref)
                            self._cache_access_token(ref, locked_token)
                            self._apply_access_token(runtime, locked_token.access_token)
                            return
                else:
                    logger.warning("Could not acquire cross-process lock for token refresh")

                try:
                    refreshed = await refresh_token(refresh_token_value)
                except OAuthUnauthorized as exc:
                    # Give a concurrent instance time to persist its rotated token.
                    await asyncio.sleep(1)
                    latest = load_tokens(ref)
                    if latest and latest.refresh_token != refresh_token_value:
                        self._clear_rejected_refresh_token(ref)
                        self._cache_access_token(ref, latest)
                        self._apply_access_token(runtime, latest.access_token)
                        return
                    # delete_tokens(ref) would remove whatever the ref points
                    # to on disk right now, not "the refresh_token that just
                    # got 401".  A concurrent OAuthManager (another process,
                    # or another manager in this process — app.py:199,
                    # web/api/sessions.py:817, plugin paths) may have
                    # legitimately rotated and written a valid new token into
                    # this file between the load_tokens check above and here,
                    # and we'd wipe it.  Clearing the in-memory cache is
                    # enough; a short in-process tombstone prevents the same
                    # rejected refresh_token from being immediately retried or
                    # preferred over a configured static api_key fallback, and
                    # /login still atomically overwrites the file.
                    self._mark_refresh_token_rejected(ref, refresh_token_value)
                    self._access_tokens.pop(ref.key, None)
                    self._apply_access_token(runtime, "")
                    if force:
                        raise
                    logger.warning(
                        "OAuth credentials rejected: {error}",
                        error=exc,
                    )
                    from kimi_cli.telemetry import track

                    track("oauth_refresh", success=False, reason="unauthorized")
                    return
                except Exception as exc:
                    if force:
                        raise
                    logger.warning("Failed to refresh OAuth token: {error}", error=exc)
                    from kimi_cli.telemetry import track

                    track("oauth_refresh", success=False, reason="network_or_other")
                    return
                self._clear_rejected_refresh_token(ref)
                save_tokens(ref, refreshed)
                self._cache_access_token(ref, refreshed)
                self._apply_access_token(runtime, refreshed.access_token)
                from kimi_cli.telemetry import track

                track("oauth_refresh", success=True)
            finally:
                xlock.release()

    def _apply_access_token(self, runtime: Runtime | None, access_token: str) -> None:
        if runtime is None:
            return
        provider_key = managed_provider_key(KIMI_CODE_PLATFORM_ID)
        if runtime.llm is None or runtime.llm.model_config is None:
            return
        if runtime.llm.model_config.provider != provider_key:
            return
        from kosong.chat_provider.kimi import Kimi

        assert isinstance(runtime.llm.chat_provider, Kimi), "Expected Kimi chat provider"
        provider = runtime.config.providers.get(provider_key)
        fallback_api_key = provider.api_key.get_secret_value() if provider else ""
        runtime.llm.chat_provider.client.api_key = access_token or fallback_api_key


if __name__ == "__main__":
    from rich import print

    print(_common_headers())

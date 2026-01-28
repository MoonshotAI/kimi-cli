from __future__ import annotations

import asyncio
import json
import os
import platform
import socket
import sys
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
REFRESH_THRESHOLD_SECONDS = 300


class OAuthError(RuntimeError):
    """OAuth flow error."""


class OAuthUnauthorized(OAuthError):
    """OAuth credentials rejected."""


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

    @classmethod
    def from_response(cls, payload: dict[str, Any]) -> OAuthToken:
        expires_in = float(payload["expires_in"])
        return cls(
            access_token=str(payload["access_token"]),
            refresh_token=str(payload["refresh_token"]),
            expires_at=time.time() + expires_in,
            scope=str(payload["scope"]),
            token_type=str(payload["token_type"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
            "scope": self.scope,
            "token_type": self.token_type,
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
        )


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
    return device_id


def _common_headers() -> dict[str, str]:
    device_name = platform.node() or socket.gethostname()
    device_model = _device_model()
    return {
        "X-Msh-Platform": "kimi_cli",
        "X-Msh-Version": VERSION,
        "X-Msh-Device-Name": device_name,
        "X-Msh-Device-Model": device_model,
        "X-Msh-Os-Version": platform.version(),
        "X-Msh-Device-Id": get_device_id(),
    }


def _credentials_dir() -> Path:
    path = get_share_dir() / "credentials"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _credentials_path(key: str) -> Path:
    name = key.removeprefix("oauth/").split("/")[-1] or key
    return _credentials_dir() / f"{name}.json"


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


def _save_to_keyring(key: str, token: OAuthToken) -> bool:
    try:
        keyring.set_password(KEYRING_SERVICE, key, json.dumps(token.to_dict()))
        return True
    except Exception as exc:
        logger.warning("Failed to write token to keyring: {error}", error=exc)
        return False


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
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict):
        return None
    payload = cast(dict[str, Any], payload)
    return OAuthToken.from_dict(payload)


def _save_to_file(key: str, token: OAuthToken) -> None:
    path = _credentials_path(key)
    path.write_text(json.dumps(token.to_dict(), ensure_ascii=False), encoding="utf-8")
    _ensure_private_file(path)


def _delete_from_file(key: str) -> None:
    path = _credentials_path(key)
    if path.exists():
        path.unlink()


def load_tokens(ref: OAuthRef) -> OAuthToken | None:
    if ref.storage == "keyring":
        token = _load_from_keyring(ref.key)
        if token is not None:
            return token
    return _load_from_file(ref.key)


def save_tokens(ref: OAuthRef, token: OAuthToken) -> OAuthRef:
    if ref.storage == "keyring":
        if _save_to_keyring(ref.key, token):
            return ref
        logger.warning("Keyring unavailable, falling back to file storage.")
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


async def refresh_token(refresh_token: str) -> OAuthToken:
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
        data = await response.json(content_type=None)
        status = response.status
    if status in (401, 403):
        raise OAuthUnauthorized(data.get("error_description") or "Token refresh unauthorized.")
    if status != 200:
        raise OAuthError(data.get("error_description") or "Token refresh failed.")
    return OAuthToken.from_response(data)


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

    oauth_ref = OAuthRef(storage="keyring", key=KIMI_CODE_OAUTH_KEY)
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
        self._tokens: dict[str, OAuthToken] = {}
        self._refresh_lock = asyncio.Lock()
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

    def _load_initial_tokens(self) -> None:
        for ref in self._iter_oauth_refs():
            token = load_tokens(ref)
            if token:
                self._tokens[ref.key] = token

    def common_headers(self) -> dict[str, str]:
        return _common_headers()

    def resolve_api_key(self, api_key: SecretStr, oauth: OAuthRef | None) -> str:
        if oauth:
            token = self._tokens.get(oauth.key)
            if token is None:
                token = load_tokens(oauth)
                if token:
                    self._tokens[oauth.key] = token
            if token and token.access_token:
                return token.access_token
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

    async def ensure_fresh(self, runtime: Runtime) -> None:
        ref = self._kimi_code_ref()
        if ref is None:
            return
        token = self._tokens.get(ref.key) or load_tokens(ref)
        if token is None:
            return
        self._tokens[ref.key] = token
        await self._refresh_tokens(ref, token, runtime)

    @asynccontextmanager
    async def refreshing(self, runtime: Runtime) -> AsyncIterator[None]:
        stop_event = asyncio.Event()

        async def _runner() -> None:
            try:
                while True:
                    try:
                        await asyncio.wait_for(
                            stop_event.wait(),
                            timeout=REFRESH_INTERVAL_SECONDS,
                        )
                        return
                    except TimeoutError:
                        pass
                    try:
                        await self.ensure_fresh(runtime)
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
        runtime: Runtime,
    ) -> None:
        current_token = self._tokens.get(ref.key) or token
        if not current_token.refresh_token:
            return
        async with self._refresh_lock:
            current = self._tokens.get(ref.key) or current_token
            now = time.time()
            if (
                current.expires_at
                and current.expires_at > now
                and current.expires_at - now >= REFRESH_THRESHOLD_SECONDS
            ):
                return
            refresh_token_value = current.refresh_token
            if not refresh_token_value:
                return
            try:
                refreshed = await refresh_token(refresh_token_value)
            except OAuthUnauthorized as exc:
                logger.warning(
                    "OAuth credentials rejected, deleting stored tokens: {error}",
                    error=exc,
                )
                self._tokens.pop(ref.key, None)
                delete_tokens(ref)
                self._apply_access_token(runtime, "")
                return
            except Exception as exc:
                logger.warning("Failed to refresh OAuth token: {error}", error=exc)
                return
            self._tokens[ref.key] = refreshed
            save_tokens(ref, refreshed)
            self._apply_access_token(runtime, refreshed.access_token)

    def _apply_access_token(self, runtime: Runtime, access_token: str) -> None:
        provider_key = managed_provider_key(KIMI_CODE_PLATFORM_ID)
        if runtime.llm is None or runtime.llm.model_config is None:
            return
        if runtime.llm.model_config.provider != provider_key:
            return
        from kosong.chat_provider.kimi import Kimi

        assert isinstance(runtime.llm.chat_provider, Kimi), "Expected Kimi chat provider"
        runtime.llm.chat_provider.client.api_key = access_token


if __name__ == "__main__":
    from rich import print

    print(_common_headers())

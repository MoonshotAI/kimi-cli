"""
Observability configuration.

This module handles configuration parsing from environment variables,
config files, and CLI arguments.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from kimi_cli.config import ObservabilityConfig as PydanticObservabilityConfig

ExportTarget = Literal["none", "console", "otlp", "file"]
OTLPProtocol = Literal["grpc", "http"]


@dataclass(frozen=True, slots=True)
class ObservabilitySettings:
    """Observability settings from config file."""

    enabled: bool = False
    export_target: ExportTarget = "none"
    otlp_endpoint: str = "http://localhost:4317"
    otlp_protocol: OTLPProtocol = "grpc"
    otlp_headers: dict[str, str] = field(default_factory=lambda: {})
    file_path: str = ""
    sampling_rate: float = 1.0
    session_based_trace: bool = False
    log_content: bool = False

    @classmethod
    def from_pydantic(cls, config: PydanticObservabilityConfig) -> ObservabilitySettings:
        """Create settings from a Pydantic config object."""
        return cls(
            enabled=config.enabled,
            export_target=config.export_target,
            otlp_endpoint=config.otlp_endpoint,
            otlp_protocol=config.otlp_protocol,
            otlp_headers=dict(config.otlp_headers),
            file_path=config.file_path,
            sampling_rate=config.sampling_rate,
            session_based_trace=config.session_based_trace,
            log_content=config.log_content,
        )


@dataclass(frozen=True, slots=True)
class ObservabilityConfig:
    """
    Resolved observability configuration.

    Priority: CLI args > Environment variables > Config file settings
    """

    enabled: bool
    export_target: ExportTarget
    otlp_endpoint: str
    otlp_protocol: OTLPProtocol
    otlp_headers: dict[str, str]
    file_path: str
    sampling_rate: float
    session_based_trace: bool
    log_content: bool

    @classmethod
    def from_settings(
        cls,
        settings: ObservabilitySettings | None = None,
        *,
        # CLI argument overrides
        cli_enabled: bool | None = None,
        cli_export_target: ExportTarget | None = None,
        cli_otlp_endpoint: str | None = None,
    ) -> ObservabilityConfig:
        """
        Create config by merging settings with environment variables and CLI args.

        Priority: CLI args > Environment variables > Config file settings
        """
        settings = settings or ObservabilitySettings()

        def env_bool(key: str, default: bool) -> bool:
            val = os.environ.get(key)
            if val is None:
                return default
            return val.lower() in ("true", "1", "yes", "on")

        def env_float(key: str, default: float) -> float:
            val = os.environ.get(key)
            if val is None:
                return default
            try:
                return float(val)
            except ValueError:
                return default

        def env_str(key: str, default: str) -> str:
            return os.environ.get(key, default)

        enabled = settings.enabled
        if os.environ.get("KIMI_TELEMETRY_ENABLED") is not None:
            enabled = env_bool("KIMI_TELEMETRY_ENABLED", enabled)
        if cli_enabled is not None:
            enabled = cli_enabled

        export_target = settings.export_target
        env_target = os.environ.get("KIMI_TELEMETRY_EXPORT_TARGET")
        if env_target in ("none", "console", "otlp", "file"):
            export_target = env_target  # type: ignore[assignment]
        if cli_export_target is not None:
            export_target = cli_export_target

        otlp_endpoint = env_str("KIMI_TELEMETRY_OTLP_ENDPOINT", settings.otlp_endpoint)
        if cli_otlp_endpoint is not None:
            otlp_endpoint = cli_otlp_endpoint

        otlp_protocol = settings.otlp_protocol
        env_protocol = os.environ.get("KIMI_TELEMETRY_OTLP_PROTOCOL")
        if env_protocol in ("grpc", "http"):
            otlp_protocol = env_protocol  # type: ignore[assignment]

        otlp_headers = dict(settings.otlp_headers)
        env_headers = os.environ.get("KIMI_TELEMETRY_OTLP_HEADERS")
        if env_headers:
            for pair in env_headers.split(","):
                if "=" in pair:
                    key, value = pair.split("=", 1)
                    otlp_headers[key.strip()] = value.strip()

        file_path = env_str("KIMI_TELEMETRY_FILE_PATH", settings.file_path)

        sampling_rate = env_float("KIMI_TELEMETRY_SAMPLING_RATE", settings.sampling_rate)
        sampling_rate = max(0.0, min(1.0, sampling_rate))

        session_based_trace = env_bool("KIMI_TELEMETRY_SESSION_TRACE", settings.session_based_trace)
        log_content = env_bool("KIMI_TELEMETRY_LOG_CONTENT", settings.log_content)

        return cls(
            enabled=enabled,
            export_target=export_target,
            otlp_endpoint=otlp_endpoint,
            otlp_protocol=otlp_protocol,
            otlp_headers=otlp_headers,
            file_path=file_path,
            sampling_rate=sampling_rate,
            session_based_trace=session_based_trace,
            log_content=log_content,
        )

    def is_effectively_enabled(self) -> bool:
        """Check if observability is effectively enabled (enabled and has valid target)."""
        return self.enabled and self.export_target != "none"

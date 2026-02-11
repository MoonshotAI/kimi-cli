"""Unit tests for ACP version negotiation."""

from __future__ import annotations

import dataclasses

from kimi_cli.acp.version import (
    CURRENT_VERSION,
    MIN_PROTOCOL_VERSION,
    SUPPORTED_VERSIONS,
    negotiate_version,
)


def test_negotiate_current_version():
    """Client sends protocol_version=1 → server returns v1."""
    result = negotiate_version(1)
    assert result.protocol_version == 1
    assert result is CURRENT_VERSION


def test_negotiate_future_version():
    """Client sends protocol_version=99 → server returns the highest supported version."""
    result = negotiate_version(99)
    max_supported = max(SUPPORTED_VERSIONS.keys())
    assert result.protocol_version == max_supported
    assert result is SUPPORTED_VERSIONS[max_supported]


def test_negotiate_zero_version():
    """Client sends protocol_version=0 (below minimum) → server returns CURRENT_VERSION."""
    result = negotiate_version(0)
    assert result is CURRENT_VERSION


def test_negotiate_negative_version():
    """Client sends negative protocol_version → server returns CURRENT_VERSION."""
    result = negotiate_version(-1)
    assert result is CURRENT_VERSION


def test_version_spec_immutable():
    """CURRENT_VERSION is a frozen dataclass and cannot be mutated."""
    assert dataclasses.is_dataclass(CURRENT_VERSION)
    assert CURRENT_VERSION.__dataclass_params__.frozen  # type: ignore[attr-defined]


def test_supported_versions_contains_current():
    """SUPPORTED_VERSIONS includes at least the CURRENT_VERSION."""
    assert CURRENT_VERSION.protocol_version in SUPPORTED_VERSIONS
    assert SUPPORTED_VERSIONS[CURRENT_VERSION.protocol_version] is CURRENT_VERSION


def test_min_protocol_version_consistency():
    """MIN_PROTOCOL_VERSION is the smallest key in SUPPORTED_VERSIONS."""
    assert min(SUPPORTED_VERSIONS.keys()) == MIN_PROTOCOL_VERSION

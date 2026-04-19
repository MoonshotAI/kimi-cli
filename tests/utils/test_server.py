"""Tests for kimi_cli.utils.server shared utilities."""

from __future__ import annotations

import pytest

from kimi_cli.utils.server import (
    find_available_port,
    format_url,
    get_address_family,
    get_network_addresses,
    is_local_host,
)

# ---------------------------------------------------------------------------
# format_url — IPv4 / IPv6 / hostname
# ---------------------------------------------------------------------------


class TestFormatUrl:
    def test_ipv4(self) -> None:
        assert format_url("127.0.0.1", 5495) == "http://127.0.0.1:5495"

    def test_hostname(self) -> None:
        assert format_url("localhost", 8080) == "http://localhost:8080"

    def test_ipv6_loopback(self) -> None:
        assert format_url("::1", 5495) == "http://[::1]:5495"

    def test_ipv6_all_interfaces(self) -> None:
        assert format_url("::", 3000) == "http://[::]:3000"

    def test_ipv6_full(self) -> None:
        assert format_url("fe80::1", 443) == "http://[fe80::1]:443"

    def test_zero_zero_zero_zero(self) -> None:
        """0.0.0.0 is IPv4 — no brackets."""
        assert format_url("0.0.0.0", 5495) == "http://0.0.0.0:5495"


# ---------------------------------------------------------------------------
# is_local_host
# ---------------------------------------------------------------------------


class TestIsLocalHost:
    def test_localhost(self) -> None:
        assert is_local_host("localhost") is True

    def test_ipv4_loopback(self) -> None:
        assert is_local_host("127.0.0.1") is True

    def test_ipv6_loopback(self) -> None:
        assert is_local_host("::1") is True

    def test_all_interfaces(self) -> None:
        assert is_local_host("0.0.0.0") is False

    def test_private_ip(self) -> None:
        assert is_local_host("192.168.1.1") is False


# ---------------------------------------------------------------------------
# get_address_family
# ---------------------------------------------------------------------------


class TestGetAddressFamily:
    def test_ipv4(self) -> None:
        import socket

        assert get_address_family("127.0.0.1") == socket.AF_INET

    def test_hostname(self) -> None:
        import socket

        assert get_address_family("localhost") == socket.AF_INET

    def test_ipv6(self) -> None:
        import socket

        assert get_address_family("::1") == socket.AF_INET6

    def test_zero_zero(self) -> None:
        import socket

        assert get_address_family("0.0.0.0") == socket.AF_INET


# ---------------------------------------------------------------------------
# find_available_port
# ---------------------------------------------------------------------------


class TestFindAvailablePort:
    def test_finds_port(self) -> None:
        port = find_available_port("127.0.0.1", 19876, max_attempts=5)
        assert 19876 <= port <= 19880

    def test_invalid_max_attempts(self) -> None:
        with pytest.raises(ValueError, match="max_attempts"):
            find_available_port("127.0.0.1", 5000, max_attempts=0)

    def test_invalid_port(self) -> None:
        with pytest.raises(ValueError, match="start_port"):
            find_available_port("127.0.0.1", 0)


# ---------------------------------------------------------------------------
# get_network_addresses
# ---------------------------------------------------------------------------


class TestGetNetworkAddresses:
    def test_returns_list(self) -> None:
        result = get_network_addresses()
        assert isinstance(result, list)

    def test_no_loopback(self) -> None:
        for addr in get_network_addresses():
            assert not addr.startswith("127.")

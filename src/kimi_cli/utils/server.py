"""Shared utilities for kimi vis and kimi web server startup."""

from __future__ import annotations

import importlib
import socket
import textwrap


def get_address_family(host: str) -> socket.AddressFamily:
    """Return AF_INET6 for IPv6 addresses, AF_INET for IPv4 and hostnames."""
    return socket.AF_INET6 if ":" in host else socket.AF_INET


def format_url(host: str, port: int) -> str:
    """Build ``http://host:port``, bracketing IPv6 literals per RFC 2732."""
    if ":" in host:
        return f"http://[{host}]:{port}"
    return f"http://{host}:{port}"


def is_local_host(host: str) -> bool:
    """Check whether *host* resolves to a loopback address."""
    return host in {"127.0.0.1", "localhost", "::1"}


def find_available_port(host: str, start_port: int, max_attempts: int = 10) -> int:
    """Find an available port starting from *start_port*.

    Raises ``RuntimeError`` if no port is available within the range.
    """
    if max_attempts <= 0:
        raise ValueError("max_attempts must be positive")
    if start_port < 1 or start_port > 65535:
        raise ValueError("start_port must be between 1 and 65535")

    family = get_address_family(host)
    for offset in range(max_attempts):
        port = start_port + offset
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    raise RuntimeError(
        f"Cannot find available port in range {start_port}-{start_port + max_attempts - 1}"
    )


def _get_interface_addrs_ioctl() -> list[str]:
    """Enumerate IPv4 addresses via socket.if_nameindex + ioctl (Linux).

    This fallback covers virtual interfaces (e.g. Tailscale, WireGuard,
    Docker bridges) that ``getaddrinfo`` and the default-route heuristic
    often miss.
    """
    addresses: list[str] = []
    try:
        import fcntl
        import struct

        SIOCGIFADDR = 0x8915
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            for _, ifname in socket.if_nameindex():
                try:
                    ifreq = struct.pack(
                        "16sH14s",
                        ifname[:15].encode("utf-8"),
                        socket.AF_INET,
                        b"\x00" * 14,
                    )
                    res = fcntl.ioctl(s.fileno(), SIOCGIFADDR, ifreq)
                    ip = socket.inet_ntoa(res[20:24])
                    if ip and not ip.startswith("127.") and ip not in addresses:
                        addresses.append(ip)
                except OSError:
                    continue
    except Exception:
        pass
    return addresses


def get_network_addresses() -> list[str]:
    """Get non-loopback IPv4 addresses for this machine."""
    addresses: list[str] = []

    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if isinstance(ip, str) and not ip.startswith("127.") and ip not in addresses:
                addresses.append(ip)
    except OSError:
        pass

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
        if ip and not ip.startswith("127.") and ip not in addresses:
            addresses.append(ip)
    except OSError:
        pass

    try:
        netifaces = importlib.import_module("netifaces")
        for interface in netifaces.interfaces():
            addrs = netifaces.ifaddresses(interface)
            if netifaces.AF_INET in addrs:
                for addr_info in addrs[netifaces.AF_INET]:
                    addr = addr_info.get("addr")
                    if addr and not addr.startswith("127.") and addr not in addresses:
                        addresses.append(addr)
    except (ImportError, Exception):
        pass

    # Fallback: ioctl enumeration covers virtual interfaces (Tailscale,
    # WireGuard, etc.) that the methods above may miss.
    for addr in _get_interface_addrs_ioctl():
        if addr not in addresses:
            addresses.append(addr)

    return addresses


def print_banner(lines: list[str]) -> None:
    """Print a boxed banner with tag conventions (<center>, <nowrap>, <hr>)."""
    processed: list[str] = []
    for line in lines:
        if line == "<hr>":
            processed.append(line)
        elif not line:
            processed.append("")
        elif line.startswith("<center>") or line.startswith("<nowrap>"):
            processed.append(line)
        else:
            processed.extend(textwrap.wrap(line, width=78))

    def strip_tags(s: str) -> str:
        return s.removeprefix("<center>").removeprefix("<nowrap>")

    content_lines = [strip_tags(line) for line in processed if line != "<hr>"]
    width = max(60, *(len(line) for line in content_lines))
    top = "+" + "=" * (width + 2) + "+"

    print(top)
    for line in processed:
        if line == "<hr>":
            print("|" + "-" * (width + 2) + "|")
        elif line.startswith("<center>"):
            content = line.removeprefix("<center>")
            print(f"| {content.center(width)} |")
        elif line.startswith("<nowrap>"):
            content = line.removeprefix("<nowrap>")
            print(f"| {content.ljust(width)} |")
        else:
            print(f"| {line.ljust(width)} |")
    print(top)

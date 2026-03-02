from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ACPVersionSpec:
    """Describes one supported ACP protocol version."""

    protocol_version: int  # negotiation integer (currently 1)
    spec_tag: str  # ACP spec tag (e.g. "v0.10.8")
    sdk_version: str  # corresponding SDK version (e.g. "0.8.0")


CURRENT_VERSION = ACPVersionSpec(
    protocol_version=1,
    spec_tag="v0.10.8",
    sdk_version="0.8.0",
)

SUPPORTED_VERSIONS: dict[int, ACPVersionSpec] = {
    1: CURRENT_VERSION,
}

MIN_PROTOCOL_VERSION = 1


def negotiate_version(client_protocol_version: int) -> ACPVersionSpec:
    """Negotiate the protocol version with the client.

    Returns the highest server-supported version that does not exceed the
    client's requested version.  If the client version is lower than
    ``MIN_PROTOCOL_VERSION`` the server still returns its own current
    version so the client can decide whether to disconnect.
    """
    if client_protocol_version < MIN_PROTOCOL_VERSION:
        return CURRENT_VERSION

    # Find the highest supported version <= client version
    best: ACPVersionSpec | None = None
    for ver, spec in SUPPORTED_VERSIONS.items():
        if ver <= client_protocol_version and (best is None or ver > best.protocol_version):
            best = spec

    return best if best is not None else CURRENT_VERSION

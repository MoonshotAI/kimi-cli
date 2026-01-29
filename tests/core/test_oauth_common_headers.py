from __future__ import annotations

from kimi_cli.auth import oauth


def test_common_headers_unicode_hostname_is_ascii_safe(monkeypatch) -> None:
    # Simulate a Unicode hostname like the user's prompt `andrewlouis@🏢`.
    monkeypatch.setattr(oauth.platform, "node", lambda: "🏢")
    monkeypatch.setattr(oauth.socket, "gethostname", lambda: "🏢")
    monkeypatch.setattr(oauth, "get_device_id", lambda: "test-device-id")

    headers = oauth._common_headers()
    headers["X-Msh-Device-Name"].encode("ascii")
    assert headers["X-Msh-Device-Name"] == "?"

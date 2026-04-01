"""Verify that index.html is served with no-cache headers to prevent stale-asset 404s after upgrades."""

from __future__ import annotations

from starlette.testclient import TestClient

from kimi_cli.web.app import create_app


def _make_client() -> TestClient:
    app = create_app(session_token="test-token")
    client = TestClient(app)
    client.cookies.set("session_token", "test-token")
    return client


def test_index_html_has_no_cache_header() -> None:
    """index.html must not be heuristically cached by browsers.

    Without an explicit Cache-Control header the browser may serve a stale
    index.html after a CLI upgrade, causing 404s for hashed assets that no
    longer exist on disk (see #1602).
    """
    client = _make_client()
    resp = client.get("/")
    assert resp.status_code == 200
    cc = resp.headers.get("cache-control", "")
    assert "no-cache" in cc or "no-store" in cc, (
        f"Expected Cache-Control with no-cache/no-store for index.html, got: {cc!r}"
    )


def test_hashed_asset_has_immutable_cache_header() -> None:
    """Hashed assets under /assets/ should be cached aggressively."""
    client = _make_client()
    # Pick any hashed asset that exists in the static dir
    import os
    from pathlib import Path

    assets_dir = (
        Path(__file__).resolve().parents[2] / "src" / "kimi_cli" / "web" / "static" / "assets"
    )
    if not assets_dir.exists():
        return  # skip if assets not built
    # Find a JS or CSS file
    for entry in os.listdir(assets_dir):
        if entry.endswith((".js", ".css")):
            resp = client.get(f"/assets/{entry}")
            assert resp.status_code == 200
            cc = resp.headers.get("cache-control", "")
            assert "max-age" in cc or "immutable" in cc, (
                f"Expected long-lived Cache-Control for hashed asset {entry}, got: {cc!r}"
            )
            break


def test_api_path_with_assets_segment_not_cached_as_immutable() -> None:
    """API paths containing 'assets/' must NOT receive immutable cache headers.

    Regression guard: before the fix, any URL with '/assets/' as a substring
    (e.g. /api/sessions/.../files/.../assets/logo.png) would be stamped with
    a one-year immutable cache, breaking file previews after edits.
    """
    client = _make_client()
    resp = client.get("/api/sessions/fake-id/files/src/assets/logo.png")
    cc = resp.headers.get("cache-control", "")
    assert "immutable" not in cc, (
        f"API file path with 'assets/' segment should not get immutable cache, got: {cc!r}"
    )

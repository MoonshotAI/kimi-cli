from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi.testclient import TestClient

from kimi_cli.web import app as web_app


def test_web_static_js_uses_javascript_mime_when_system_mapping_is_plain_text(
    monkeypatch,
    tmp_path: Path,
) -> None:
    static_dir = tmp_path / "static"
    assets_dir = static_dir / "assets"
    assets_dir.mkdir(parents=True)
    (assets_dir / "index-test.js").write_text("console.log('ok')\n", encoding="utf-8")
    (static_dir / "index.html").write_text(
        '<script type="module" src="/assets/index-test.js"></script>',
        encoding="utf-8",
    )

    monkeypatch.setattr(web_app, "STATIC_DIR", static_dir)

    original_js_mime = mimetypes.guess_type("index-test.js")[0]
    mimetypes.add_type("text/plain", ".js")
    try:
        with TestClient(web_app.create_app()) as client:
            response = client.get("/assets/index-test.js")
    finally:
        if original_js_mime is not None:
            mimetypes.add_type(original_js_mime, ".js")

    assert response.status_code == 200
    assert response.headers["content-type"].split(";")[0] == "text/javascript"

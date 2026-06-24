"""Kimi Code CLI Web Interface."""

import importlib

from . import _safe_imports as _safe_imports

_ = _safe_imports
_app = importlib.import_module("kimi_cli.web.app")
create_app = _app.create_app
run_web_server = _app.run_web_server

__all__ = ["create_app", "run_web_server"]

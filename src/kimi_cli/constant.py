from __future__ import annotations

import importlib.metadata

NAME = importlib.metadata.metadata("kimi-cli")["Name"]
VERSION = importlib.metadata.version("kimi-cli")
USER_AGENT = f"KimiCLI/{VERSION}"

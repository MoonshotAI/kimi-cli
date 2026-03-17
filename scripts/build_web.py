from __future__ import annotations

from pathlib import Path

from kimi_cli.utils.web_build import build_web_ui


def main() -> int:
    return build_web_ui(Path(__file__).resolve().parents[1])


if __name__ == "__main__":
    raise SystemExit(main())
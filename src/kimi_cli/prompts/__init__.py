from pathlib import Path

INIT = (Path(__file__).parent / "init.md").read_text(encoding="utf-8")
COMPACT = (Path(__file__).parent / "compact.md").read_text(encoding="utf-8")

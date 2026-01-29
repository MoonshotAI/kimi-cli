from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB_DIR = ROOT / "web"
DIST_DIR = WEB_DIR / "dist"
NODE_MODULES = WEB_DIR / "node_modules"
STATIC_DIR = ROOT / "src" / "kimi_cli" / "web" / "static"

STRICT_VERSION = os.environ.get("KIMI_WEB_STRICT_VERSION", "").lower() in {"1", "true", "yes"}


def read_pyproject_version() -> str:
    with (ROOT / "pyproject.toml").open("rb") as handle:
        data = tomllib.load(handle)
    return str(data["project"]["version"])


def find_version_in_dist(version: str) -> bool:
    search_suffixes = {".js", ".css", ".html", ".map"}
    version_with_prefix = f"v{version}"
    found_plain = False

    for path in DIST_DIR.rglob("*"):
        if not path.is_file() or path.suffix not in search_suffixes:
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if version_with_prefix in content:
            return True
        if version in content:
            found_plain = True

    return found_plain


def main() -> int:
    if shutil.which("npm") is None:
        print("npm not found. Install Node.js (npm) to build the web UI.", file=sys.stderr)
        return 1

    expected_version = read_pyproject_version()
    explicit_expected = os.environ.get("KIMI_WEB_EXPECT_VERSION")
    if explicit_expected and explicit_expected != expected_version:
        print(
            f"web version mismatch: pyproject={expected_version}, expected={explicit_expected}",
            file=sys.stderr,
        )
        return 1

    if not NODE_MODULES.exists():
        result = subprocess.run(
            ["npm", "--prefix", str(WEB_DIR), "ci"],
            check=False,
        )
        if result.returncode != 0:
            return result.returncode

    result = subprocess.run(["npm", "--prefix", str(WEB_DIR), "run", "build"], check=False)
    if result.returncode != 0:
        return result.returncode

    if not DIST_DIR.exists():
        print("web/dist not found after build. Check the web build output.", file=sys.stderr)
        return 1
    if STRICT_VERSION and not find_version_in_dist(expected_version):
        print(
            f"web version not found in build output; expected version {expected_version}",
            file=sys.stderr,
        )
        return 1

    if STATIC_DIR.exists():
        shutil.rmtree(STATIC_DIR)
    STATIC_DIR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(DIST_DIR, STATIC_DIR)

    print(f"Synced web UI to {STATIC_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

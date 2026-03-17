from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path


def resolve_npm() -> str | None:
    candidates = ["npm"]
    if os.name == "nt":
        candidates.extend(["npm.cmd", "npm.exe", "npm.bat"])
    for candidate in candidates:
        npm = shutil.which(candidate)
        if npm:
            return npm
    return None


def run_npm(npm: str, args: list[str]) -> int:
    try:
        result = subprocess.run([npm, *args], check=False)
    except FileNotFoundError:
        print(
            "npm not found or failed to execute. Install Node.js (npm) and ensure it is on PATH.",
            file=sys.stderr,
        )
        return 1
    return int(result.returncode)


def build_web_ui(root: Path) -> int:
    web_dir = root / "web"
    dist_dir = web_dir / "dist"
    node_modules = web_dir / "node_modules"
    static_dir = root / "src" / "kimi_cli" / "web" / "static"

    strict_version = os.environ.get("KIMI_WEB_STRICT_VERSION", "").lower() in {
        "1",
        "true",
        "yes",
    }

    required_web_type_files = (
        node_modules / "vite" / "client.d.ts",
        node_modules / "@types" / "node" / "index.d.ts",
    )

    npm = resolve_npm()
    if npm is None:
        print("npm not found. Install Node.js (npm) to build the web UI.", file=sys.stderr)
        return 1

    pyproject = root / "pyproject.toml"
    if not pyproject.exists():
        print(f"pyproject.toml not found under {root}", file=sys.stderr)
        return 1

    with pyproject.open("rb") as handle:
        project_data = tomllib.load(handle)
    expected_version = str(project_data["project"]["version"])

    explicit_expected = os.environ.get("KIMI_WEB_EXPECT_VERSION")
    if explicit_expected and explicit_expected != expected_version:
        print(
            f"web version mismatch: pyproject={expected_version}, expected={explicit_expected}",
            file=sys.stderr,
        )
        return 1

    def has_required_web_type_files() -> bool:
        return all(path.is_file() for path in required_web_type_files)

    needs_install = (not node_modules.exists()) or (not has_required_web_type_files())
    if needs_install:
        if node_modules.exists():
            print("web dependencies are incomplete; reinstalling with devDependencies...")
        returncode = run_npm(npm, ["--prefix", str(web_dir), "ci", "--include=dev"])
        if returncode != 0:
            return returncode

    returncode = run_npm(npm, ["--prefix", str(web_dir), "run", "build"])
    if returncode != 0:
        return returncode

    if not dist_dir.exists():
        print("web/dist not found after build. Check the web build output.", file=sys.stderr)
        return 1

    def find_version_in_dist(version: str) -> bool:
        search_suffixes = {".js", ".css", ".html", ".map"}
        version_with_prefix = f"v{version}"
        found_plain = False

        for path in dist_dir.rglob("*"):
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

    if strict_version and not find_version_in_dist(expected_version):
        print(
            f"web version not found in build output; expected version {expected_version}",
            file=sys.stderr,
        )
        return 1

    if static_dir.exists():
        shutil.rmtree(static_dir)
    static_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(dist_dir, static_dir)

    print(f"Synced web UI to {static_dir}")
    return 0
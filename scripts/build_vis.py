from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VIS_DIR = ROOT / "vis"
DIST_DIR = VIS_DIR / "dist"
NODE_MODULES = VIS_DIR / "node_modules"
STATIC_DIR = ROOT / "src" / "kimi_cli" / "vis" / "static"


REQUIRED_VIS_TYPE_FILES = (
    NODE_MODULES / "vite" / "client.d.ts",
    NODE_MODULES / "typescript" / "lib" / "typescript.d.ts",
)


def has_required_vis_type_files() -> bool:
    return all(path.is_file() for path in REQUIRED_VIS_TYPE_FILES)


def resolve_npm() -> str | None:
    candidates = ["npm"]
    if os.name == "nt":
        candidates.extend(["npm.cmd", "npm.exe", "npm.bat"])
    for candidate in candidates:
        npm = shutil.which(candidate)
        if npm:
            return npm
    return None


def check_node_version() -> bool:
    """Vite 7 requires Node.js ^20.19.0 || >=22.12.0."""
    node = shutil.which("node")
    if not node:
        return False
    try:
        result = subprocess.run([node, "--version"], capture_output=True, text=True, check=False)
        version = result.stdout.strip().lstrip("v")
        parts = [int(x) for x in version.split(".")[:3]]
        major, minor = parts[0], parts[1] if len(parts) > 1 else 0
        ok = (major == 20 and minor >= 19) or (major >= 22 and (major > 22 or minor >= 12))
        if not ok:
            print(
                f"Node.js ^20.19.0 or >=22.12.0 required (Vite 7), found v{version}",
                file=sys.stderr,
            )
            return False
    except Exception:
        pass
    return True


def run_npm(npm: str, args: list[str]) -> int:
    try:
        result = subprocess.run([npm, *args], check=False)
    except FileNotFoundError:
        print(
            "npm not found or failed to execute. Install Node.js (npm) and ensure it is on PATH.",
            file=sys.stderr,
        )
        return 1
    return result.returncode


def main() -> int:
    npm = resolve_npm()
    if npm is None:
        print("npm not found. Install Node.js (npm) to build the vis UI.", file=sys.stderr)
        return 1

    if not check_node_version():
        return 1

    needs_install = (not NODE_MODULES.exists()) or (not has_required_vis_type_files())
    if needs_install:
        if NODE_MODULES.exists():
            print("vis dependencies are incomplete; reinstalling with devDependencies...")
        returncode = run_npm(npm, ["--prefix", str(VIS_DIR), "ci", "--include=dev"])
        if returncode != 0:
            return returncode

    returncode = run_npm(npm, ["--prefix", str(VIS_DIR), "run", "build"])
    if returncode != 0:
        return returncode

    if not DIST_DIR.exists():
        print("vis/dist not found after build. Check the vis build output.", file=sys.stderr)
        return 1

    if STATIC_DIR.exists():
        shutil.rmtree(STATIC_DIR)
    STATIC_DIR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(DIST_DIR, STATIC_DIR)

    print(f"Synced vis UI to {STATIC_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

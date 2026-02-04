from __future__ import annotations

import argparse
import re
import sys
import tomllib
from pathlib import Path


def load_cargo_version(cargo_path: Path) -> str:
    data = tomllib.loads(cargo_path.read_text(encoding="utf-8"))
    version = None
    package = data.get("package")
    if isinstance(package, dict):
        version = package.get("version")
    if not version:
        workspace = data.get("workspace")
        if isinstance(workspace, dict):
            workspace_package = workspace.get("package")
            if isinstance(workspace_package, dict):
                version = workspace_package.get("version")
    if not isinstance(version, str) or not version:
        raise ValueError(f"Missing package version in {cargo_path}")
    return version


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate tag version against Cargo.toml.")
    parser.add_argument("--cargo-toml", type=Path, required=True)
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()

    semver_re = re.compile(r"^\d+\.\d+\.\d+$")
    if not semver_re.match(args.expected_version):
        print(
            f"error: expected version must include patch (x.y.z): {args.expected_version}",
            file=sys.stderr,
        )
        return 1

    cargo_version = load_cargo_version(args.cargo_toml)
    if not semver_re.match(cargo_version):
        print(
            "error: cargo version must include patch (x.y.z): "
            f"{args.cargo_toml} has {cargo_version}",
            file=sys.stderr,
        )
        return 1
    if cargo_version != args.expected_version:
        print(
            "error: version mismatch: "
            f"{args.cargo_toml} has {cargo_version}, expected {args.expected_version}",
            file=sys.stderr,
        )
        return 1
    print(f"ok: {args.cargo_toml} matches expected version {args.expected_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

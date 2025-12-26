from __future__ import annotations

import argparse
import sys
import tomllib
from pathlib import Path


def load_project_version(pyproject_path: Path) -> str:
    with pyproject_path.open("rb") as handle:
        data = tomllib.load(handle)

    project = data.get("project")
    if not isinstance(project, dict):
        raise ValueError(f"Missing [project] table in {pyproject_path}")

    version = project.get("version")
    if not isinstance(version, str) or not version:
        raise ValueError(f"Missing project.version in {pyproject_path}")

    return version


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate tag version against pyproject.")
    parser.add_argument("--pyproject", type=Path, required=True)
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()

    try:
        project_version = load_project_version(args.pyproject)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if project_version != args.expected_version:
        print(
            "error: version mismatch: "
            f"{args.pyproject} has {project_version}, expected {args.expected_version}",
            file=sys.stderr,
        )
        return 1

    print(f"ok: {args.pyproject} matches expected version {args.expected_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

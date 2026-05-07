from __future__ import annotations

import argparse
import re
import tomllib
from pathlib import Path

VERSION_PART_RE = re.compile(r"^\d+$")


def read_project_version(pyproject_path: Path) -> str:
    data = tomllib.loads(pyproject_path.read_text(encoding="utf-8"))
    version = data.get("project", {}).get("version")
    if not isinstance(version, str) or not version:
        raise ValueError(f"Missing project.version in {pyproject_path}")
    return version


def parse_fixed_file_version(version: str) -> tuple[int, int, int, int]:
    public_version = version.split("+", 1)[0].split("-", 1)[0]
    parts = public_version.split(".")
    if not 1 <= len(parts) <= 4 or any(not VERSION_PART_RE.match(part) for part in parts):
        raise ValueError(f"Version must start with numeric dot-separated parts: {version}")
    return (*[int(part) for part in parts], *([0] * (4 - len(parts))))  # type: ignore[return-value]


def render_version_info(version: str) -> str:
    fixed_version = parse_fixed_file_version(version)
    fixed = ", ".join(str(part) for part in fixed_version)
    return f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({fixed}),
    prodvers=({fixed}),
    mask=0x3f,
    flags=0x0,
    OS=0x40004,
    fileType=0x1,
    subtype=0x0,
    date=(0, 0),
  ),
  kids=[
    StringFileInfo([
      StringTable(
        "040904B0",
        [
          StringStruct("CompanyName", "Moonshot AI"),
          StringStruct("FileDescription", "Kimi Code CLI"),
          StringStruct("FileVersion", "{version}"),
          StringStruct("InternalName", "kimi"),
          StringStruct("OriginalFilename", "kimi.exe"),
          StringStruct("ProductName", "Kimi Code CLI"),
          StringStruct("ProductVersion", "{version}"),
        ],
      )
    ]),
    VarFileInfo([VarStruct("Translation", [1033, 1200])]),
  ],
)
"""


def write_version_info(pyproject_path: Path, output_path: Path) -> Path:
    version = read_project_version(pyproject_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(render_version_info(version), encoding="utf-8")
    return output_path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate PyInstaller Windows version info.")
    parser.add_argument("--pyproject", type=Path, default=Path("pyproject.toml"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    write_version_info(args.pyproject, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

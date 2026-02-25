from __future__ import annotations

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

hiddenimports = collect_submodules("kimi_cli.tools")

# Collect dateparser data files if they exist.
# The timezone cache file is generated lazily on first use, so it may not exist
# in a fresh environment. We only include it if it's already been generated.
_dateparser_datas = collect_data_files(
    "dateparser",
    includes=["**/*.pkl"],
)
# Filter out non-existent paths
_dateparser_datas = [(src, dst) for src, dst in _dateparser_datas if Path(src).exists()]

datas = (
    collect_data_files(
        "kimi_cli",
        includes=[
            "agents/**/*.yaml",
            "agents/**/*.md",
            "deps/bin/**",
            "prompts/**/*.md",
            "skills/**",
            "tools/**/*.md",
            "web/static/**",
            "CHANGELOG.md",
        ],
        excludes=[
            "tools/*.md",
        ],
    )
    + _dateparser_datas
    + collect_data_files(
        "fastmcp",
        includes=["../fastmcp-*.dist-info/*"],
    )
)

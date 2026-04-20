from __future__ import annotations

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

from kimi_cli.cli._lazy_group import LazySubcommandGroup

lazy_cli_hiddenimports = [
    module_name
    for module_name, _attribute_name, _help_text in (LazySubcommandGroup.lazy_subcommands.values())
]

hiddenimports = collect_submodules("kimi_cli.tools") + lazy_cli_hiddenimports + ["setproctitle"]
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
            "vis/static/**",
            "CHANGELOG.md",
        ],
        excludes=[
            "tools/*.md",
        ],
    )
    + collect_data_files(
        "dateparser",
        includes=["**/*.pkl"],
    )
    + collect_data_files(
        "fastmcp",
        includes=["../fastmcp-*.dist-info/*"],
    )
)

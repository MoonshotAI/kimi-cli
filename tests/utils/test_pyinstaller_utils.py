from __future__ import annotations

import platform
import sys
from pathlib import Path

from inline_snapshot import snapshot


def test_pyinstaller_datas():
    from kimi_cli.utils.pyinstaller import datas

    project_root = Path(__file__).parent.parent.parent
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    site_packages = f".venv/lib/python{python_version}/site-packages"
    rg_binary = "rg.exe" if platform.system() == "Windows" else "rg"
    has_rg_binary = (project_root / "src/kimi_cli/deps/bin" / rg_binary).exists()
    datas = [
        (
            Path(path)
            .relative_to(project_root)
            .as_posix()
            .replace(".venv/Lib/site-packages", site_packages),
            Path(dst).as_posix(),
        )
        for path, dst in datas
    ]

    datas = [(p, d) for p, d in datas if "web/static" not in d and "vis/static" not in d]

    expected_datas = [
        (
            f"{site_packages}/dateparser/data/dateparser_tz_cache.pkl",
            "dateparser/data",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-2.12.5.dist-info/INSTALLER",
            "fastmcp/../fastmcp-2.12.5.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-2.12.5.dist-info/METADATA",
            "fastmcp/../fastmcp-2.12.5.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-2.12.5.dist-info/RECORD",
            "fastmcp/../fastmcp-2.12.5.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-2.12.5.dist-info/REQUESTED",
            "fastmcp/../fastmcp-2.12.5.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-2.12.5.dist-info/WHEEL",
            "fastmcp/../fastmcp-2.12.5.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-2.12.5.dist-info/entry_points.txt",
            "fastmcp/../fastmcp-2.12.5.dist-info",
        ),
        (
            f"{site_packages}/fastmcp/../fastmcp-2.12.5.dist-info/licenses/LICENSE",
            "fastmcp/../fastmcp-2.12.5.dist-info/licenses",
        ),
        (
            "src/kimi_cli/CHANGELOG.md",
            "kimi_cli",
        ),
        ("src/kimi_cli/agents/default/agent.yaml", "kimi_cli/agents/default"),
        ("src/kimi_cli/agents/default/coder.yaml", "kimi_cli/agents/default"),
        ("src/kimi_cli/agents/default/explore.yaml", "kimi_cli/agents/default"),
        ("src/kimi_cli/agents/default/plan.yaml", "kimi_cli/agents/default"),
        ("src/kimi_cli/agents/default/system.md", "kimi_cli/agents/default"),
        ("src/kimi_cli/agents/okabe/agent.yaml", "kimi_cli/agents/okabe"),
        ("src/kimi_cli/prompts/compact.md", "kimi_cli/prompts"),
        ("src/kimi_cli/prompts/init.md", "kimi_cli/prompts"),
        (
            "src/kimi_cli/skills/kimi-cli-help/SKILL.md",
            "kimi_cli/skills/kimi-cli-help",
        ),
        (
            "src/kimi_cli/skills/skill-creator/SKILL.md",
            "kimi_cli/skills/skill-creator",
        ),
        ("src/kimi_cli/tools/agent/description.md", "kimi_cli/tools/agent"),
        ("src/kimi_cli/tools/ask_user/description.md", "kimi_cli/tools/ask_user"),
        (
            "src/kimi_cli/tools/dmail/dmail.md",
            "kimi_cli/tools/dmail",
        ),
        ("src/kimi_cli/tools/background/list.md", "kimi_cli/tools/background"),
        ("src/kimi_cli/tools/background/output.md", "kimi_cli/tools/background"),
        ("src/kimi_cli/tools/background/stop.md", "kimi_cli/tools/background"),
        (
            "src/kimi_cli/tools/file/glob.md",
            "kimi_cli/tools/file",
        ),
        (
            "src/kimi_cli/tools/file/grep.md",
            "kimi_cli/tools/file",
        ),
        (
            "src/kimi_cli/tools/file/read.md",
            "kimi_cli/tools/file",
        ),
        (
            "src/kimi_cli/tools/file/read_media.md",
            "kimi_cli/tools/file",
        ),
        (
            "src/kimi_cli/tools/file/replace.md",
            "kimi_cli/tools/file",
        ),
        (
            "src/kimi_cli/tools/file/write.md",
            "kimi_cli/tools/file",
        ),
        ("src/kimi_cli/tools/plan/description.md", "kimi_cli/tools/plan"),
        ("src/kimi_cli/tools/plan/enter_description.md", "kimi_cli/tools/plan"),
        ("src/kimi_cli/tools/shell/bash.md", "kimi_cli/tools/shell"),
        (
            "src/kimi_cli/tools/think/think.md",
            "kimi_cli/tools/think",
        ),
        (
            "src/kimi_cli/tools/todo/set_todo_list.md",
            "kimi_cli/tools/todo",
        ),
        (
            "src/kimi_cli/tools/web/fetch.md",
            "kimi_cli/tools/web",
        ),
        (
            "src/kimi_cli/tools/web/search.md",
            "kimi_cli/tools/web",
        ),
    ]
    if has_rg_binary:
        expected_datas.append((f"src/kimi_cli/deps/bin/{rg_binary}", "kimi_cli/deps/bin"))

    assert sorted(datas) == sorted(expected_datas)


def test_pyinstaller_hiddenimports():
    from kimi_cli.utils.pyinstaller import hiddenimports

    assert sorted(hiddenimports) == snapshot(
        [
            "kimi_cli._build_info",
            "kimi_cli.cli.export",
            "kimi_cli.cli.info",
            "kimi_cli.cli.mcp",
            "kimi_cli.cli.plugin",
            "kimi_cli.cli.vis",
            "kimi_cli.cli.web",
            "kimi_cli.tools",
            "kimi_cli.tools.agent",
            "kimi_cli.tools.ask_user",
            "kimi_cli.tools.background",
            "kimi_cli.tools.display",
            "kimi_cli.tools.dmail",
            "kimi_cli.tools.file",
            "kimi_cli.tools.file.glob",
            "kimi_cli.tools.file.grep_local",
            "kimi_cli.tools.file.plan_mode",
            "kimi_cli.tools.file.read",
            "kimi_cli.tools.file.read_media",
            "kimi_cli.tools.file.replace",
            "kimi_cli.tools.file.utils",
            "kimi_cli.tools.file.write",
            "kimi_cli.tools.plan",
            "kimi_cli.tools.plan.enter",
            "kimi_cli.tools.plan.heroes",
            "kimi_cli.tools.shell",
            "kimi_cli.tools.test",
            "kimi_cli.tools.think",
            "kimi_cli.tools.todo",
            "kimi_cli.tools.utils",
            "kimi_cli.tools.web",
            "kimi_cli.tools.web.fetch",
            "kimi_cli.tools.web.search",
            "setproctitle",
        ]
    )


def test_pyinstaller_hiddenimports_include_lazy_cli_subcommands():
    from kimi_cli.cli._lazy_group import LazySubcommandGroup
    from kimi_cli.utils.pyinstaller import hiddenimports

    expected_hiddenimports = {
        module_name
        for module_name, _attribute_name, _help_text in LazySubcommandGroup.lazy_subcommands.values()
    }

    assert expected_hiddenimports <= set(hiddenimports)

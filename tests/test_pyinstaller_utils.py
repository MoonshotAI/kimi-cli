from __future__ import annotations

import platform
import sys
from pathlib import Path

from inline_snapshot import snapshot


def test_pyinstaller_datas():
    from gitrekt_cli.utils.pyinstaller import datas

    project_root = Path(__file__).parent.parent
    python_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    site_packages = f".venv/lib/python{python_version}/site-packages"
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

    assert sorted(datas) == snapshot(
        [
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
                "src/gitrekt_cli/CHANGELOG.md",
                "gitrekt_cli",
            ),
            ("src/gitrekt_cli/agents/default/agent.yaml", "gitrekt_cli/agents/default"),
            ("src/gitrekt_cli/agents/default/sub.yaml", "gitrekt_cli/agents/default"),
            ("src/gitrekt_cli/agents/default/system.md", "gitrekt_cli/agents/default"),
            ("src/gitrekt_cli/agents/okabe/agent.yaml", "gitrekt_cli/agents/okabe"),
            (
                f"src/gitrekt_cli/deps/bin/{'rg.exe' if platform.system() == 'Windows' else 'rg'}",
                "gitrekt_cli/deps/bin",
            ),
            ("src/gitrekt_cli/prompts/compact.md", "gitrekt_cli/prompts"),
            ("src/gitrekt_cli/prompts/init.md", "gitrekt_cli/prompts"),
            (
                "src/gitrekt_cli/skills/Gitrekt-cli-help/SKILL.md",
                "gitrekt_cli/skills/Gitrekt-cli-help",
            ),
            (
                "src/gitrekt_cli/skills/skill-creator/SKILL.md",
                "gitrekt_cli/skills/skill-creator",
            ),
            (
                "src/gitrekt_cli/tools/dmail/dmail.md",
                "gitrekt_cli/tools/dmail",
            ),
            (
                "src/gitrekt_cli/tools/file/glob.md",
                "gitrekt_cli/tools/file",
            ),
            (
                "src/gitrekt_cli/tools/file/grep.md",
                "gitrekt_cli/tools/file",
            ),
            (
                "src/gitrekt_cli/tools/file/read.md",
                "gitrekt_cli/tools/file",
            ),
            (
                "src/gitrekt_cli/tools/file/replace.md",
                "gitrekt_cli/tools/file",
            ),
            (
                "src/gitrekt_cli/tools/file/write.md",
                "gitrekt_cli/tools/file",
            ),
            ("src/gitrekt_cli/tools/multiagent/create.md", "gitrekt_cli/tools/multiagent"),
            ("src/gitrekt_cli/tools/multiagent/task.md", "gitrekt_cli/tools/multiagent"),
            ("src/gitrekt_cli/tools/shell/bash.md", "gitrekt_cli/tools/shell"),
            ("src/gitrekt_cli/tools/shell/powershell.md", "gitrekt_cli/tools/shell"),
            (
                "src/gitrekt_cli/tools/think/think.md",
                "gitrekt_cli/tools/think",
            ),
            (
                "src/gitrekt_cli/tools/todo/set_todo_list.md",
                "gitrekt_cli/tools/todo",
            ),
            (
                "src/gitrekt_cli/tools/web/fetch.md",
                "gitrekt_cli/tools/web",
            ),
            (
                "src/gitrekt_cli/tools/web/search.md",
                "gitrekt_cli/tools/web",
            ),
        ]
    )


def test_pyinstaller_hiddenimports():
    from gitrekt_cli.utils.pyinstaller import hiddenimports

    assert sorted(hiddenimports) == snapshot(
        [
            "gitrekt_cli.tools",
            "gitrekt_cli.tools.display",
            "gitrekt_cli.tools.dmail",
            "gitrekt_cli.tools.file",
            "gitrekt_cli.tools.file.glob",
            "gitrekt_cli.tools.file.grep_local",
            "gitrekt_cli.tools.file.read",
            "gitrekt_cli.tools.file.replace",
            "gitrekt_cli.tools.file.utils",
            "gitrekt_cli.tools.file.write",
            "gitrekt_cli.tools.multiagent",
            "gitrekt_cli.tools.multiagent.create",
            "gitrekt_cli.tools.multiagent.task",
            "gitrekt_cli.tools.shell",
            "gitrekt_cli.tools.test",
            "gitrekt_cli.tools.think",
            "gitrekt_cli.tools.todo",
            "gitrekt_cli.tools.utils",
            "gitrekt_cli.tools.web",
            "gitrekt_cli.tools.web.fetch",
            "gitrekt_cli.tools.web.search",
        ]
    )

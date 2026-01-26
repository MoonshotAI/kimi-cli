import importlib.util
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import typer


def _default_acp_command() -> list[str]:
    argv0 = sys.argv[0]
    if argv0:
        resolved = shutil.which(argv0)
        resolved_path = Path(resolved).expanduser() if resolved else Path(argv0).expanduser()
        if (
            resolved_path.exists()
            and resolved_path.suffix != ".py"
            and not resolved_path.name.startswith(("python", "pypy"))
        ):
            return [str(resolved_path), "acp"]

    return [sys.executable, "-m", "kimi_cli.cli", "acp"]


def _default_toad_command() -> list[str]:
    if sys.version_info < (3, 14):
        typer.echo("`kimi term` requires Python 3.14+ because Toad requires it.", err=True)
        raise typer.Exit(code=1)
    if importlib.util.find_spec("toad") is None:
        typer.echo(
            "Toad dependency is missing. Install kimi-cli with Python 3.14+ to use `kimi term`.",
            err=True,
        )
        raise typer.Exit(code=1)
    return [sys.executable, "-m", "toad.cli"]


def _extract_project_dir(extra_args: list[str]) -> Path | None:
    work_dir: str | None = None
    idx = 0
    while idx < len(extra_args):
        arg = extra_args[idx]
        if arg in ("--work-dir", "-w"):
            if idx + 1 < len(extra_args):
                work_dir = extra_args[idx + 1]
                idx += 2
                continue
        elif arg.startswith("--work-dir=") or arg.startswith("-w="):
            work_dir = arg.split("=", 1)[1]
        elif arg.startswith("-w") and len(arg) > 2:
            work_dir = arg[2:]
        idx += 1

    if not work_dir:
        return None

    return Path(work_dir).expanduser().resolve()


def run_term(ctx: typer.Context) -> None:
    extra_args = list(ctx.args)
    acp_args = _default_acp_command()
    acp_command = shlex.join(acp_args)
    toad_parts = _default_toad_command()
    args = [*toad_parts, "acp", acp_command]
    project_dir = _extract_project_dir(extra_args)
    if project_dir is not None:
        args.append(str(project_dir))

    result = subprocess.run(args)
    if result.returncode != 0:
        raise typer.Exit(code=result.returncode)

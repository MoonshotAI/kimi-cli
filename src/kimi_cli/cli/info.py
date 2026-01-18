from __future__ import annotations

import json
import platform
from typing import Annotated, TypedDict

import typer

from kimi_cli.constant import VERSION


class InfoData(TypedDict):
    kimi_cli_version: str
    agent_spec_versions: list[str]
    wire_protocol_version: str
    python_version: str


def _collect_info() -> InfoData:
    from kimi_cli.agentspec import SUPPORTED_AGENT_SPEC_VERSIONS
    from kimi_cli.ui.wire.protocol import WIRE_PROTOCOL_VERSION

    return {
        "kimi_cli_version": VERSION,
        "agent_spec_versions": [str(version) for version in SUPPORTED_AGENT_SPEC_VERSIONS],
        "wire_protocol_version": WIRE_PROTOCOL_VERSION,
        "python_version": platform.python_version(),
    }


def _emit_info(json_output: bool) -> None:
    info = _collect_info()
    if json_output:
        typer.echo(json.dumps(info, ensure_ascii=False))
        return

    agent_versions_text = ", ".join(str(version) for version in info["agent_spec_versions"])

    lines = [
        f"kimi-cli version: {info['kimi_cli_version']}",
        f"agent spec versions: {agent_versions_text}",
        f"wire protocol: {info['wire_protocol_version']}",
        f"python version: {info['python_version']}",
    ]
    for line in lines:
        typer.echo(line)


cli = typer.Typer(help="Show version and protocol information.")


@cli.callback(invoke_without_command=True)
def info(
    json_output: Annotated[
        bool,
        typer.Option(
            "--json",
            help="Output information as JSON.",
        ),
    ] = False,
):
    """Show version and protocol information."""
    _emit_info(json_output)

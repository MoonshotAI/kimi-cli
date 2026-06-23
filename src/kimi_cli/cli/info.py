from __future__ import annotations

import json
import platform
from typing import Annotated, TypedDict

import typer


class InfoData(TypedDict):
    kimi_cli_version: str
    agent_spec_versions: list[str]
    wire_protocol_version: str
    python_version: str


def _collect_info() -> InfoData:
    from kimi_cli.agentspec import SUPPORTED_AGENT_SPEC_VERSIONS
    from kimi_cli.constant import get_version
    from kimi_cli.wire.protocol import WIRE_PROTOCOL_VERSION

    return {
        "kimi_cli_version": get_version(),
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


def sdk_setup_text() -> str:
    """Return Kimi Agent SDK / Wire setup instructions."""
    text = """
Welcome to Kimi Code CLI!

# Wire SDK Setup
## Prerequisites
```
pip install kimi-cli-agent-sdk
```
Or install from GitHub for the latest development version:
```
pip install git+https://github.com/moonshotai/kimi-sdk.git
```

## Usage example
```python
from kimi_cli.agent import KimiCLI

async def main():
    async with KimiCLI.connect() as wire:
        # Send commands to Kimi CLI
        await wire.send_message({
            "method": "chat",
            "params": {
                "messages": [{"role": "user", "content": "Hello, Kimi!"}]
            }
        })
        
        # Wait for responses
        async for response in wire.messages():
            print(response)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
```

For more information, check out the official documentation.
""".strip()
    return text


@cli.command()
def print_sdk_setup():
    """Print Kimi Agent SDK / Wire setup instructions"""
    typer.echo(sdk_setup_text())


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

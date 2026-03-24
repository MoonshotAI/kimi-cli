from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any, Literal, cast

from kimi_cli import logger


@dataclass
class HookResult:
    """Result of a single hook execution."""
    action: Literal["allow", "block"] = "allow"
    reason: str = ""
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0
    timed_out: bool = False


async def run_hook(
    command: str,
    input_data: dict[str, Any],
    *,
    timeout: int = 30,
    cwd: str | None = None,
) -> HookResult:
    """Execute a single hook command. Fail-open: errors/timeouts -> allow."""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=json.dumps(input_data).encode()),
                timeout=timeout,
            )
        except TimeoutError:
            proc.kill()
            await proc.wait()
            logger.warning("Hook timed out after {}s: {}", timeout, command)
            return HookResult(action="allow", timed_out=True)
    except Exception as e:
        logger.warning("Hook failed: {}: {}", command, e)
        return HookResult(action="allow", stderr=str(e))

    stdout = stdout_bytes.decode(errors="replace")
    stderr = stderr_bytes.decode(errors="replace")
    exit_code = proc.returncode or 0

    # Exit 2 = block
    if exit_code == 2:
        return HookResult(
            action="block",
            reason=stderr.strip(),
            stdout=stdout,
            stderr=stderr,
            exit_code=2,
        )

    # Exit 0 + JSON stdout = structured decision
    if exit_code == 0 and stdout.strip():
        try:
            raw = json.loads(stdout)
            if isinstance(raw, dict):
                parsed = cast(dict[str, Any], raw)
                hook_output = cast(dict[str, Any], parsed.get("hookSpecificOutput", {}))
                if hook_output.get("permissionDecision") == "deny":
                    return HookResult(
                        action="block",
                        reason=str(hook_output.get("permissionDecisionReason", "")),
                        stdout=stdout, stderr=stderr, exit_code=0,
                    )
        except (json.JSONDecodeError, TypeError):
            pass

    return HookResult(action="allow", stdout=stdout, stderr=stderr, exit_code=exit_code)

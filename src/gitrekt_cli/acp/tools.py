import asyncio
from contextlib import suppress

import acp
from kaos import get_current_kaos
from kaos.local import local_kaos
from kosong.tooling import CallableTool2, ToolReturnValue

from gitrekt_cli.soul.agent import Runtime
from gitrekt_cli.soul.approval import Approval
from gitrekt_cli.soul.toolset import GitrektToolset
from gitrekt_cli.tools.shell import Params as ShellParams
from gitrekt_cli.tools.shell import Shell
from gitrekt_cli.tools.utils import ToolRejectedError, ToolResultBuilder
from gitrekt_cli.wire.types import DisplayBlock


def replace_tools(
    client_capabilities: acp.schema.ClientCapabilities,
    acp_conn: acp.Client,
    acp_session_id: str,
    toolset: GitrektToolset,
    runtime: Runtime,
) -> None:
    current_kaos = get_current_kaos().name
    if current_kaos not in (local_kaos.name, "acp"):
        # Only replace tools when running locally or under ACPKaos.
        return

    if client_capabilities.terminal and (shell_tool := toolset.find(Shell)):
        # Replace the Shell tool with the ACP Terminal tool if supported.
        toolset.add(
            Terminal(
                shell_tool,
                acp_conn,
                acp_session_id,
                runtime.approval,
            )
        )


class HideOutputDisplayBlock(DisplayBlock):
    """A special DisplayBlock that indicates output should be hidden in ACP clients."""

    type: str = "acp/hide_output"


class Terminal(CallableTool2[ShellParams]):
    def __init__(
        self,
        shell_tool: Shell,
        acp_conn: acp.Client,
        acp_session_id: str,
        approval: Approval,
    ) -> None:
        # Use the `name`, `description`, and `params` from the existing Shell tool,
        # so that when this is added to the toolset, it replaces the original Shell tool.
        super().__init__(shell_tool.name, shell_tool.description, shell_tool.params)
        self._acp_conn = acp_conn
        self._acp_session_id = acp_session_id
        self._approval = approval

    async def __call__(self, params: ShellParams) -> ToolReturnValue:
        from gitrekt_cli.acp.session import get_current_acp_tool_call_id_or_none

        builder = ToolResultBuilder()
        # Hide tool output because we use `TerminalToolCallContent` which already streams output
        # directly to the user.
        builder.display(HideOutputDisplayBlock())

        if not params.command:
            return builder.error("Command cannot be empty.", brief="Empty command")

        if not await self._approval.request(
            self.name,
            "run shell command",
            f"Run command `{params.command}`",
        ):
            return ToolRejectedError()

        timeout_seconds = float(params.timeout)
        timeout_label = f"{timeout_seconds:g}s"
        terminal: acp.TerminalHandle | None = None
        exit_status: (
            acp.schema.WaitForTerminalExitResponse | acp.schema.TerminalExitStatus | None
        ) = None
        timed_out = False

        try:
            term = await self._acp_conn.create_terminal(
                command=params.command,
                session_id=self._acp_session_id,
                output_byte_limit=builder.max_chars,
            )
            # FIXME: update ACP sdk for the fix
            assert isinstance(term, acp.TerminalHandle), (
                "Expected TerminalHandle from create_terminal"
            )
            terminal = term

            acp_tool_call_id = get_current_acp_tool_call_id_or_none()
            assert acp_tool_call_id, "Expected to have an ACP tool call ID in context"
            await self._acp_conn.session_update(
                session_id=self._acp_session_id,
                update=acp.schema.ToolCallProgress(
                    session_update="tool_call_update",
                    tool_call_id=acp_tool_call_id,
                    status="in_progress",
                    content=[
                        acp.schema.TerminalToolCallContent(
                            type="terminal",
                            terminal_id=terminal.id,
                        )
                    ],
                ),
            )

            try:
                async with asyncio.timeout(timeout_seconds):
                    exit_status = await terminal.wait_for_exit()
            except TimeoutError:
                timed_out = True
                await terminal.kill()

            output_response = await terminal.current_output()
            builder.write(output_response.output)
            if output_response.exit_status:
                exit_status = output_response.exit_status

            exit_code = exit_status.exit_code if exit_status else None
            exit_signal = exit_status.signal if exit_status else None

            truncated_note = (
                " Output was truncated by the client output limit."
                if output_response.truncated
                else ""
            )

            if timed_out:
                return builder.error(
                    f"Command killed by timeout ({timeout_label}){truncated_note}",
                    brief=f"Killed by timeout ({timeout_label})",
                )
            if exit_signal:
                return builder.error(
                    f"Command terminated by signal: {exit_signal}.{truncated_note}",
                    brief=f"Signal: {exit_signal}",
                )
            if exit_code not in (None, 0):
                return builder.error(
                    f"Command failed with exit code: {exit_code}.{truncated_note}",
                    brief=f"Failed with exit code: {exit_code}",
                )
            return builder.ok(f"Command executed successfully.{truncated_note}")
        finally:
            if terminal is not None:
                with suppress(Exception):
                    await terminal.release()

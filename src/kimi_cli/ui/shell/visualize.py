import asyncio
from contextlib import asynccontextmanager, suppress

from kosong.base.message import ContentPart, TextPart, ThinkPart, ToolCall, ToolCallPart
from kosong.tooling import ToolResult

from kimi_cli.soul import StatusSnapshot
from kimi_cli.ui.shell.console import console
from kimi_cli.ui.shell.keyboard import listen_for_keyboard
from kimi_cli.ui.shell.liveview import StepLiveView, StepLiveViewWithMarkdown
from kimi_cli.wire import WireUISide
from kimi_cli.wire.message import (
    ApprovalRequest,
    CompactionBegin,
    CompactionEnd,
    StatusUpdate,
    StepBegin,
    StepInterrupted,
)


@asynccontextmanager
async def _keyboard_listener(step: StepLiveView):
    async def _keyboard():
        try:
            async for event in listen_for_keyboard():
                step.handle_keyboard_event(event)
        except asyncio.CancelledError:
            return

    task = asyncio.create_task(_keyboard())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


async def visualize(
    wire: WireUISide,
    *,
    initial_status: StatusSnapshot,
    cancel_event: asyncio.Event | None = None,
    markdown: bool = True,
):
    """
    A loop to consume agent events and visualize the agent behavior.

    Args:
        wire: Communication channel with the agent
        initial_status: Initial status snapshot
        cancel_event: Event that can be set (e.g., by ESC key) to cancel the run
    """

    latest_status = initial_status

    # expect a StepBegin
    assert isinstance(await wire.receive(), StepBegin)

    while True:
        # TODO: Maybe we can always have a StepLiveView here.
        #       No need to recreate for each step.
        LiveView = StepLiveViewWithMarkdown if markdown else StepLiveView
        with LiveView(latest_status, cancel_event) as step:
            async with _keyboard_listener(step):
                # spin the moon at the beginning of each step
                with console.status("", spinner="moon"):
                    msg = await wire.receive()

                if isinstance(msg, CompactionBegin):
                    with console.status("[cyan]Compacting...[/cyan]"):
                        msg = await wire.receive()
                    if isinstance(msg, StepInterrupted):
                        break
                    assert isinstance(msg, CompactionEnd)
                    continue

                # visualization loop for one step
                while True:
                    match msg:
                        case TextPart(text=text):
                            step.append_text(text, mode="text")
                        case ThinkPart(think=think):
                            step.append_text(think, mode="think")
                        case ContentPart():
                            # TODO: support more content parts
                            step.append_text(f"[{msg.__class__.__name__}]")
                        case ToolCall():
                            step.append_tool_call(msg)
                        case ToolCallPart():
                            step.append_tool_call_part(msg)
                        case ToolResult():
                            step.append_tool_result(msg)
                        case ApprovalRequest():
                            step.request_approval(msg)
                        case StatusUpdate(status=status):
                            latest_status = status
                            step.update_status(latest_status)
                        case _:
                            break  # break the step loop
                    msg = await wire.receive()

                # cleanup the step live view
                if isinstance(msg, StepInterrupted):
                    step.interrupt()
                else:
                    step.finish()

        if isinstance(msg, StepInterrupted):
            # for StepInterrupted, the visualization loop should end immediately
            break

        assert isinstance(msg, StepBegin), "expect a StepBegin"
        # start a new step

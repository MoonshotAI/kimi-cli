"""Bottom dynamic area rendering package.

This package contains all components for the terminal's bottom dynamic area:
event-driven streaming view, interactive overlays (approval, question, btw),
input routing, and renderable blocks.

All public names are re-exported here so external imports remain stable:
    from kimi_cli.ui.shell.visualize import visualize, _PromptLiveView, ...
"""

# pyright: reportPrivateUsage=false
from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any

# Re-export Rich Live for test monkeypatching
from rich.live import Live as Live  # noqa: F401

# --- Re-exports (keep all existing import paths working) -------------------
# Console (re-exported for test monkeypatching compatibility)
from kimi_cli.ui.shell.console import console as console  # noqa: F401
from kimi_cli.ui.shell.keyboard import KeyEvent as KeyEvent  # noqa: F401
from kimi_cli.ui.shell.prompt import CustomPromptSession, UserInput

# Approval panel (moved from ui/shell/approval_panel.py)
from kimi_cli.ui.shell.visualize._approval_panel import (
    ApprovalPromptDelegate as ApprovalPromptDelegate,
)
from kimi_cli.ui.shell.visualize._approval_panel import (
    ApprovalRequestPanel as ApprovalRequestPanel,
)
from kimi_cli.ui.shell.visualize._approval_panel import (
    show_approval_in_pager as show_approval_in_pager,
)

# Renderable blocks (+ helper functions used by tests)
from kimi_cli.ui.shell.visualize._blocks import (
    _ContentBlock as _ContentBlock,
)
from kimi_cli.ui.shell.visualize._blocks import (
    _estimate_tokens as _estimate_tokens,
)
from kimi_cli.ui.shell.visualize._blocks import (
    _find_committed_boundary as _find_committed_boundary,
)
from kimi_cli.ui.shell.visualize._blocks import (
    _NotificationBlock as _NotificationBlock,
)
from kimi_cli.ui.shell.visualize._blocks import (
    _StatusBlock as _StatusBlock,
)
from kimi_cli.ui.shell.visualize._blocks import (
    _tail_lines as _tail_lines,
)
from kimi_cli.ui.shell.visualize._blocks import (
    _ToolCallBlock as _ToolCallBlock,
)
from kimi_cli.ui.shell.visualize._blocks import (
    _truncate_to_display_width as _truncate_to_display_width,
)

# BTW panel
from kimi_cli.ui.shell.visualize._btw_panel import (
    _BtwModalDelegate as _BtwModalDelegate,
)

# Input routing
from kimi_cli.ui.shell.visualize._input_router import (
    InputAction as InputAction,
)
from kimi_cli.ui.shell.visualize._input_router import (
    classify_input as classify_input,
)

# Interactive view
from kimi_cli.ui.shell.visualize._interactive import (
    BtwRunner,
    _PromptLiveView,
)

# Base view
from kimi_cli.ui.shell.visualize._live_view import (
    _keyboard_listener as _keyboard_listener,
)
from kimi_cli.ui.shell.visualize._live_view import (
    _LiveView,
)

# Question panel (moved from ui/shell/question_panel.py)
from kimi_cli.ui.shell.visualize._question_panel import (
    QuestionPromptDelegate as QuestionPromptDelegate,
)
from kimi_cli.ui.shell.visualize._question_panel import (
    QuestionRequestPanel as QuestionRequestPanel,
)
from kimi_cli.ui.shell.visualize._question_panel import (
    prompt_other_input as prompt_other_input,
)
from kimi_cli.ui.shell.visualize._question_panel import (
    show_question_body_in_pager as show_question_body_in_pager,
)

# Wire types and utils (re-exported for test compatibility)
from kimi_cli.utils.aioqueue import QueueShutDown as QueueShutDown  # noqa: F401
from kimi_cli.wire import WireUISide
from kimi_cli.wire.types import ContentPart, StatusUpdate
from kimi_cli.wire.types import TurnEnd as TurnEnd  # noqa: F401

# --- Factory function ------------------------------------------------------


async def visualize(
    wire: WireUISide,
    *,
    initial_status: StatusUpdate,
    cancel_event: asyncio.Event | None = None,
    prompt_session: CustomPromptSession | None = None,
    steer: Callable[[str | list[ContentPart]], None] | None = None,
    btw_runner: BtwRunner | None = None,
    bind_running_input: Callable[[Callable[[UserInput], None], Callable[[], None]], None]
    | None = None,
    unbind_running_input: Callable[[], None] | None = None,
    on_view_ready: Callable[[Any], None] | None = None,
    on_view_closed: Callable[[], None] | None = None,
):
    """A loop to consume agent events and visualize the agent behavior.

    Creates either a ``_LiveView`` (Rich Live, non-interactive) or a
    ``_PromptLiveView`` (prompt_toolkit, interactive) depending on whether
    a prompt session is provided.
    """
    if prompt_session is not None and steer is not None:
        view = _PromptLiveView(
            initial_status,
            prompt_session=prompt_session,
            steer=steer,
            btw_runner=btw_runner,
            cancel_event=cancel_event,
        )
        prompt_session.attach_running_prompt(view)

        def _cancel_running_input() -> None:
            if cancel_event is not None:
                cancel_event.set()

        if bind_running_input is not None:
            bind_running_input(view.handle_local_input, _cancel_running_input)
    else:
        view = _LiveView(initial_status, cancel_event)
    if on_view_ready is not None:
        on_view_ready(view)
    try:
        await view.visualize_loop(wire)
    finally:
        if prompt_session is not None and steer is not None:
            if unbind_running_input is not None:
                unbind_running_input()
            if isinstance(view, _PromptLiveView):
                prompt_session.detach_running_prompt(view)
        if on_view_closed is not None:
            on_view_closed()

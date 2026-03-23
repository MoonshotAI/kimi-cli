from __future__ import annotations

from collections.abc import Callable
from typing import NamedTuple

from prompt_toolkit.application.run_in_terminal import run_in_terminal
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyPressEvent
from rich.console import Group, RenderableType
from rich.markup import escape
from rich.padding import Padding
from rich.panel import Panel
from rich.text import Text

from kimi_cli.ui.shell.console import console, render_to_ansi
from kimi_cli.ui.shell.keyboard import KeyEvent
from kimi_cli.utils.diff import format_unified_diff
from kimi_cli.utils.rich.syntax import KimiSyntax
from kimi_cli.wire.types import (
    ApprovalRequest,
    ApprovalResponse,
    BriefDisplayBlock,
    DiffDisplayBlock,
    ShellDisplayBlock,
)

# Truncation limits for approval request display
MAX_PREVIEW_LINES = 4


class ApprovalContentBlock(NamedTuple):
    """A pre-rendered content block for approval request with line count."""

    text: str
    lines: int
    style: str = ""
    lexer: str = ""


class ApprovalRequestPanel:
    FEEDBACK_OPTION_INDEX = 3

    def __init__(self, request: ApprovalRequest):
        self.request = request
        self.options: list[tuple[str, ApprovalResponse.Kind]] = [
            ("Approve once", "approve"),
            ("Approve for this session", "approve_for_session"),
            ("Reject", "reject"),
            ("Reject, tell the model what to do instead", "reject"),
        ]
        self.selected_index = 0

        # Pre-render all content blocks with line counts
        self._content_blocks: list[ApprovalContentBlock] = []
        last_diff_path: str | None = None

        # Handle description (only if no display blocks)
        if request.description and not request.display:
            text = request.description.rstrip("\n")
            self._content_blocks.append(ApprovalContentBlock(text=text, lines=text.count("\n") + 1))

        # Handle display blocks
        for block in request.display:
            if isinstance(block, DiffDisplayBlock):
                # File path or ellipsis
                if block.path != last_diff_path:
                    self._content_blocks.append(
                        ApprovalContentBlock(text=block.path, lines=1, style="bold")
                    )
                    last_diff_path = block.path
                else:
                    self._content_blocks.append(
                        ApprovalContentBlock(text="⋮", lines=1, style="dim")
                    )
                # Diff content
                diff_text = format_unified_diff(
                    block.old_text,
                    block.new_text,
                    block.path,
                    include_file_header=False,
                ).rstrip("\n")
                self._content_blocks.append(
                    ApprovalContentBlock(
                        text=diff_text, lines=diff_text.count("\n") + 1, lexer="diff"
                    )
                )
            elif isinstance(block, ShellDisplayBlock):
                text = block.command.rstrip("\n")
                self._content_blocks.append(
                    ApprovalContentBlock(
                        text=text, lines=text.count("\n") + 1, lexer=block.language
                    )
                )
                last_diff_path = None
            elif isinstance(block, BriefDisplayBlock) and block.text:
                text = block.text.rstrip("\n")
                self._content_blocks.append(
                    ApprovalContentBlock(text=text, lines=text.count("\n") + 1, style="grey50")
                )
                last_diff_path = None

        self._total_lines = sum(b.lines for b in self._content_blocks)
        self.has_expandable_content = self._total_lines > MAX_PREVIEW_LINES

    def render(self, *, feedback_text: str | None = None) -> RenderableType:
        """Render the approval menu as a bordered panel."""
        content_lines: list[RenderableType] = [
            Text.from_markup(
                "[yellow]"
                f"{escape(self.request.sender)} is requesting approval to "
                f"{escape(self.request.action)}:[/yellow]"
            )
        ]
        content_lines.extend(self._render_source_metadata_lines())
        content_lines.append(Text(""))

        # Render content with line budget
        remaining = MAX_PREVIEW_LINES
        for block in self._content_blocks:
            if remaining <= 0:
                break
            content_lines.append(self._render_block(block, remaining))
            remaining -= min(block.lines, remaining)

        if self.has_expandable_content:
            content_lines.append(Text("... (truncated, ctrl-e to expand)", style="dim italic"))

        lines: list[RenderableType] = []
        if content_lines:
            lines.append(Padding(Group(*content_lines), (0, 0, 0, 1)))

        # Whether inline feedback input is active
        show_inline_feedback = feedback_text is not None and self.is_feedback_selected

        # Add menu options with number key labels
        if lines:
            lines.append(Text(""))
        for i, (option_text, _) in enumerate(self.options):
            num = i + 1
            is_feedback_option = i == self.FEEDBACK_OPTION_INDEX
            if i == self.selected_index:
                if is_feedback_option and show_inline_feedback:
                    input_display = escape(feedback_text) if feedback_text else ""
                    lines.append(
                        Text.from_markup(
                            f"[cyan]\u2192 \\[{num}] Reject: {input_display}\u2588[/cyan]"
                        )
                    )
                else:
                    lines.append(Text(f"\u2192 [{num}] {option_text}", style="cyan"))
            else:
                lines.append(Text(f"  [{num}] {option_text}", style="grey50"))

        # Keyboard hints
        lines.append(Text(""))
        if show_inline_feedback:
            hint = "  Type your feedback, then press Enter to submit."
        else:
            hint = "  \u25b2/\u25bc select  1/2/3/4 choose  \u21b5 confirm"
            if self.has_expandable_content:
                hint += "  ctrl-e expand"
        lines.append(Text(hint, style="dim"))

        return Panel(
            Group(*lines),
            border_style="bold yellow",
            title="[bold yellow]\u26a0 ACTION REQUIRED[/bold yellow]",
            title_align="left",
            padding=(0, 1),
        )

    def render_for_terminal(self) -> RenderableType:
        """Render the approval request for a blocking terminal prompt."""
        content_lines: list[RenderableType] = [
            Text.from_markup(
                "[yellow]"
                f"{escape(self.request.sender)} is requesting approval to "
                f"{escape(self.request.action)}:[/yellow]"
            ),
        ]
        content_lines.extend(self._render_source_metadata_lines())
        content_lines.append(Text(""))

        for block in self._content_blocks:
            content_lines.append(self._render_block(block))

        if self._content_blocks:
            content_lines.append(Text(""))
        for i, (option_text, _) in enumerate(self.options, start=1):
            content_lines.append(Text(f"[{i}] {option_text}", style="grey50"))

        return Panel(
            Group(*content_lines),
            border_style="bold yellow",
            title="[bold yellow]Background Approval Required[/bold yellow]",
            title_align="left",
            padding=(0, 1),
        )

    def _render_block(
        self, block: ApprovalContentBlock, max_lines: int | None = None
    ) -> RenderableType:
        """Render a content block, optionally truncated."""
        text = block.text
        if max_lines is not None and block.lines > max_lines:
            text = "\n".join(text.split("\n")[:max_lines])

        if block.lexer:
            return KimiSyntax(text, block.lexer)
        return Text(text, style=block.style)

    def render_full(self) -> list[RenderableType]:
        """Render full content for pager (no truncation)."""
        return [self._render_block(block) for block in self._content_blocks]

    def _render_source_metadata_lines(self) -> list[RenderableType]:
        lines: list[RenderableType] = []
        if self.request.subagent_type is not None or self.request.agent_id is not None:
            if self.request.subagent_type is not None and self.request.agent_id is not None:
                subagent_text = f"{self.request.subagent_type} ({self.request.agent_id})"
            elif self.request.subagent_type is not None:
                subagent_text = self.request.subagent_type
            else:
                assert self.request.agent_id is not None
                subagent_text = self.request.agent_id
            lines.append(Text(f"Subagent: {subagent_text}", style="grey50"))
        if self.request.source_description:
            lines.append(Text(f"Task: {self.request.source_description}", style="grey50"))
        return lines

    def move_up(self):
        """Move selection up."""
        self.selected_index = (self.selected_index - 1) % len(self.options)

    def move_down(self):
        """Move selection down."""
        self.selected_index = (self.selected_index + 1) % len(self.options)

    @property
    def is_feedback_selected(self) -> bool:
        return self.selected_index == self.FEEDBACK_OPTION_INDEX

    def get_selected_response(self) -> ApprovalResponse.Kind:
        """Get the approval response based on selected option."""
        return self.options[self.selected_index][1]


def show_approval_in_pager(panel: ApprovalRequestPanel) -> None:
    """Show the full approval request content in a pager."""
    with console.screen(), console.pager(styles=True):
        console.print(
            Text.from_markup(
                "[yellow]⚠ "
                f"{escape(panel.request.sender)} is requesting approval to "
                f"{escape(panel.request.action)}:[/yellow]"
            )
        )
        console.print()

        for renderable in panel.render_full():
            console.print(renderable)


def render_approval_request_for_terminal(request: ApprovalRequest) -> RenderableType:
    return ApprovalRequestPanel(request).render_for_terminal()


class ApprovalPromptDelegate:
    modal_priority = 20
    _KEY_MAP: dict[str, KeyEvent] = {
        "up": KeyEvent.UP,
        "down": KeyEvent.DOWN,
        "enter": KeyEvent.ENTER,
        "1": KeyEvent.NUM_1,
        "2": KeyEvent.NUM_2,
        "3": KeyEvent.NUM_3,
        "4": KeyEvent.NUM_4,
        "escape": KeyEvent.ESCAPE,
        "c-c": KeyEvent.ESCAPE,
        "c-d": KeyEvent.ESCAPE,
    }

    def __init__(
        self,
        request: ApprovalRequest,
        *,
        on_response: Callable[[ApprovalRequest, ApprovalResponse.Kind, str], None],
        buffer_text_provider: Callable[[], str] | None = None,
    ) -> None:
        self._panel = ApprovalRequestPanel(request)
        self._on_response = on_response
        self._buffer_text_provider = buffer_text_provider
        self._feedback_draft: str = ""

    @property
    def request(self) -> ApprovalRequest:
        return self._panel.request

    def set_request(self, request: ApprovalRequest) -> None:
        self._panel = ApprovalRequestPanel(request)
        self._feedback_draft = ""

    def _is_inline_feedback_active(self) -> bool:
        return self._panel.is_feedback_selected and self._buffer_text_provider is not None

    def render_running_prompt_body(self, columns: int) -> ANSI:
        feedback_text: str | None = None
        if self._is_inline_feedback_active():
            feedback_text = self._buffer_text_provider() if self._buffer_text_provider else ""
        body = render_to_ansi(
            self._panel.render(feedback_text=feedback_text),
            columns=columns,
        ).rstrip("\n")
        return ANSI(body)

    def running_prompt_placeholder(self) -> str | None:
        return None

    def running_prompt_allows_text_input(self) -> bool:
        return self._is_inline_feedback_active()

    def running_prompt_hides_input_buffer(self) -> bool:
        return True

    def running_prompt_accepts_submission(self) -> bool:
        return False

    def should_handle_running_prompt_key(self, key: str) -> bool:
        if key == "c-e":
            return self._panel.has_expandable_content
        if self._is_inline_feedback_active():
            return key in {"enter", "escape", "c-c", "c-d", "up", "down"}
        return key in {
            "up",
            "down",
            "enter",
            "1",
            "2",
            "3",
            "4",
            "escape",
            "c-c",
            "c-d",
            "c-e",
        }

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        if key == "c-e":
            event.app.create_background_task(self._show_panel_in_pager())
            return

        # Inline feedback mode: user is typing in the "Reject + feedback" field
        if self._is_inline_feedback_active():
            mapped = self._KEY_MAP.get(key)
            if key == "enter" or mapped == KeyEvent.ENTER:
                text = event.current_buffer.text.strip()
                if text:
                    self._clear_buffer(event.current_buffer)
                    self._feedback_draft = ""
                    self._panel.request.resolve("reject")
                    self._on_response(self._panel.request, "reject", text)
                # Empty enter: do nothing (keep editing)
                return
            if mapped == KeyEvent.ESCAPE:
                self._clear_buffer(event.current_buffer)
                self._feedback_draft = ""
                self._panel.request.resolve("reject")
                self._on_response(self._panel.request, "reject", "")
                return
            if mapped in {KeyEvent.UP, KeyEvent.DOWN}:
                self._feedback_draft = event.current_buffer.text
                self._clear_buffer(event.current_buffer)
                if mapped == KeyEvent.UP:
                    self._panel.move_up()
                else:
                    self._panel.move_down()
                return
            return

        mapped = self._KEY_MAP.get(key)
        if mapped is None:
            return
        match mapped:
            case KeyEvent.UP:
                self._panel.move_up()
                self._maybe_restore_feedback_draft(event.current_buffer)
            case KeyEvent.DOWN:
                self._panel.move_down()
                self._maybe_restore_feedback_draft(event.current_buffer)
            case KeyEvent.ENTER:
                self._submit_current_request(event.current_buffer)
            case KeyEvent.ESCAPE:
                self._panel.request.resolve("reject")
                self._on_response(self._panel.request, "reject", "")
            case KeyEvent.NUM_1 | KeyEvent.NUM_2 | KeyEvent.NUM_3 | KeyEvent.NUM_4:
                num_map = {
                    KeyEvent.NUM_1: 0,
                    KeyEvent.NUM_2: 1,
                    KeyEvent.NUM_3: 2,
                    KeyEvent.NUM_4: 3,
                }
                idx = num_map[mapped]
                if idx < len(self._panel.options):
                    self._panel.selected_index = idx
                    if not self._is_inline_feedback_active():
                        self._submit_current_request(event.current_buffer)
            case _:
                pass

    async def _show_panel_in_pager(self) -> None:
        await run_in_terminal(lambda: show_approval_in_pager(self._panel))

    def _maybe_restore_feedback_draft(self, buffer: Buffer) -> None:
        if self._is_inline_feedback_active() and self._feedback_draft:
            buffer.set_document(
                Document(text=self._feedback_draft, cursor_position=len(self._feedback_draft)),
                bypass_readonly=True,
            )

    @staticmethod
    def _clear_buffer(buffer: Buffer) -> None:
        if buffer.text:
            buffer.set_document(Document(text="", cursor_position=0), bypass_readonly=True)

    def _submit_current_request(self, buffer: Buffer) -> None:
        self._clear_buffer(buffer)
        self._feedback_draft = ""
        response = self._panel.get_selected_response()
        self._panel.request.resolve(response)
        self._on_response(self._panel.request, response, "")

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
from kimi_cli.utils.rich.diff_render import (
    collect_diff_hunks,
    render_diff_panel,
    render_diff_preview,
    render_diff_summary_panel,
    render_diff_summary_preview,
)
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


def _render_feedback_with_cursor(text: str, cursor: int | None) -> Text:
    if cursor is None or cursor >= len(text):
        return Text(text + "\u2588")
    cursor = max(cursor, 0)
    return Text.assemble(
        Text(text[:cursor]),
        Text(text[cursor], style="reverse"),
        Text(text[cursor + 1 :]),
    )


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

        # Pre-render content for the preview.
        # All blocks (diff and non-diff) are rendered in original display order
        # into a single list of renderables to preserve interleaving.
        self._preview_renderables: list[RenderableType] = []
        self._has_diff = False
        self._non_diff_truncated = False
        # Legacy content blocks for non-diff blocks (used by render_full fallback)
        self._content_blocks: list[ApprovalContentBlock] = []

        # Line budget for non-diff blocks
        non_diff_budget = MAX_PREVIEW_LINES

        # Handle description (only if no display blocks)
        if request.description and not request.display:
            text = request.description.rstrip("\n")
            line_count = text.count("\n") + 1
            self._content_blocks.append(ApprovalContentBlock(text=text, lines=line_count))
            preview_text = text
            if line_count > non_diff_budget:
                preview_text = "\n".join(text.split("\n")[:non_diff_budget])
                self._non_diff_truncated = True
            self._preview_renderables.append(Text(preview_text))
            non_diff_budget -= min(line_count, non_diff_budget)

        # Handle display blocks — group consecutive same-file DiffDisplayBlocks
        display = request.display
        idx = 0
        while idx < len(display):
            block = display[idx]
            if isinstance(block, DiffDisplayBlock):
                path = block.path
                diff_blocks: list[DiffDisplayBlock] = []
                while idx < len(display):
                    b = display[idx]
                    if not isinstance(b, DiffDisplayBlock) or b.path != path:
                        break
                    diff_blocks.append(b)
                    idx += 1
                if any(b.is_summary for b in diff_blocks):
                    self._has_diff = True
                    self._preview_renderables.extend(render_diff_summary_preview(path, diff_blocks))
                else:
                    hunks, added, removed = collect_diff_hunks(diff_blocks)
                    if hunks:
                        self._has_diff = True
                        renderables, _remaining = render_diff_preview(
                            path,
                            hunks,
                            added,
                            removed,
                        )
                        self._preview_renderables.extend(renderables)
            elif isinstance(block, ShellDisplayBlock):
                text = block.command.rstrip("\n")
                line_count = text.count("\n") + 1
                self._content_blocks.append(
                    ApprovalContentBlock(text=text, lines=line_count, lexer=block.language)
                )
                if non_diff_budget > 0:
                    truncated = text
                    if line_count > non_diff_budget:
                        truncated = "\n".join(text.split("\n")[:non_diff_budget])
                        self._non_diff_truncated = True
                    self._preview_renderables.append(KimiSyntax(truncated, block.language))
                    non_diff_budget -= min(line_count, non_diff_budget)
                else:
                    self._non_diff_truncated = True
                idx += 1
            elif isinstance(block, BriefDisplayBlock) and block.text:
                text = block.text.rstrip("\n")
                line_count = text.count("\n") + 1
                self._content_blocks.append(
                    ApprovalContentBlock(text=text, lines=line_count, style="grey50")
                )
                if non_diff_budget > 0:
                    truncated = text
                    if line_count > non_diff_budget:
                        truncated = "\n".join(text.split("\n")[:non_diff_budget])
                        self._non_diff_truncated = True
                    self._preview_renderables.append(Text(truncated, style="grey50"))
                    non_diff_budget -= min(line_count, non_diff_budget)
                else:
                    self._non_diff_truncated = True
                idx += 1
            else:
                idx += 1

        # P1: diff pager always has context lines not shown in preview
        # P2: non-diff blocks may have been truncated
        self.has_expandable_content = self._has_diff or self._non_diff_truncated

    def render(
        self,
        *,
        feedback_text: str | None = None,
        feedback_cursor: int | None = None,
    ) -> RenderableType:
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

        # Render preview (diff + non-diff in original display order)
        content_lines.extend(self._preview_renderables)

        if self.has_expandable_content and self._non_diff_truncated:
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
                    input_display = _render_feedback_with_cursor(
                        feedback_text or "", feedback_cursor
                    )
                    lines.append(
                        Text.assemble(
                            Text(f"\u2192 [{num}] Reject: "),
                            input_display,
                            style="cyan",
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
            border_style="yellow",
            title="[bold]approval[/bold]",
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

        # Render display blocks with the unified diff renderer.
        display = panel.request.display
        rendered_any = False
        idx = 0
        while idx < len(display):
            block = display[idx]
            if isinstance(block, DiffDisplayBlock):
                path = block.path
                diff_blocks: list[DiffDisplayBlock] = []
                while idx < len(display):
                    b = display[idx]
                    if not isinstance(b, DiffDisplayBlock) or b.path != path:
                        break
                    diff_blocks.append(b)
                    idx += 1
                if any(b.is_summary for b in diff_blocks):
                    console.print(render_diff_summary_panel(path, diff_blocks))
                    rendered_any = True
                else:
                    hunks, added, removed = collect_diff_hunks(diff_blocks)
                    if hunks:
                        console.print(render_diff_panel(path, hunks, added, removed))
                        rendered_any = True
            elif isinstance(block, ShellDisplayBlock):
                console.print(KimiSyntax(block.command.rstrip("\n"), block.language))
                rendered_any = True
                idx += 1
            elif isinstance(block, BriefDisplayBlock) and block.text:
                console.print(Text(block.text.rstrip("\n"), style="grey50"))
                rendered_any = True
                idx += 1
            else:
                idx += 1

        # Fallback: if nothing was rendered (e.g. type mismatch after deserialization),
        # use legacy pre-rendered content blocks.
        if not rendered_any:
            for renderable in panel.render_full():
                console.print(renderable)


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
        buffer_state_provider: Callable[[], tuple[str, int]] | None = None,
        text_expander: Callable[[str], str] | None = None,
    ) -> None:
        self._panel = ApprovalRequestPanel(request)
        self._on_response = on_response
        self._buffer_state_provider = buffer_state_provider
        self._text_expander = text_expander
        self._feedback_draft: str = ""

    @property
    def request(self) -> ApprovalRequest:
        return self._panel.request

    def set_request(self, request: ApprovalRequest) -> None:
        self._panel = ApprovalRequestPanel(request)
        self._feedback_draft = ""

    def _is_inline_feedback_active(self) -> bool:
        return self._panel.is_feedback_selected and self._buffer_state_provider is not None

    def render_running_prompt_body(self, columns: int) -> ANSI:
        feedback_text: str | None = None
        feedback_cursor: int | None = None
        if self._is_inline_feedback_active() and self._buffer_state_provider is not None:
            feedback_text, feedback_cursor = self._buffer_state_provider()
        body = render_to_ansi(
            self._panel.render(
                feedback_text=feedback_text,
                feedback_cursor=feedback_cursor,
            ),
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
                    if self._text_expander is not None:
                        text = self._text_expander(text)
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

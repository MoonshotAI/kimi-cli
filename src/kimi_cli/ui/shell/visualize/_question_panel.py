from __future__ import annotations

from collections.abc import Callable

from prompt_toolkit import PromptSession
from prompt_toolkit.application.run_in_terminal import run_in_terminal
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.document import Document
from prompt_toolkit.formatted_text import ANSI
from prompt_toolkit.key_binding import KeyPressEvent
from rich.console import Group, RenderableType
from rich.markup import escape
from rich.panel import Panel
from rich.text import Text

from kimi_cli.ui.shell.console import console, render_to_ansi
from kimi_cli.ui.shell.keyboard import KeyEvent
from kimi_cli.utils.rich.markdown import Markdown
from kimi_cli.wire.types import QuestionRequest

OTHER_OPTION_LABEL = "Other"


class QuestionRequestPanel:
    """Renders structured questions for the user to answer interactively."""

    def __init__(self, request: QuestionRequest):
        self.request = request
        self._current_question_index = 0
        self._answers: dict[str, str] = {}
        self._saved_selections: dict[int, tuple[int, set[int]]] = {}
        self._other_drafts: dict[int, str] = {}
        self._selected_index = 0
        self._multi_selected: set[int] = set()
        self._body_text: str = ""
        self.has_expandable_content: bool = False
        self._setup_current_question()

    def _setup_current_question(self) -> None:
        q = self._current_question
        self._options = [(o.label, o.description) for o in q.options]
        other_label = q.other_label or OTHER_OPTION_LABEL
        other_desc = q.other_description or ""
        self._options.append((other_label, other_desc))
        idx = self._current_question_index
        if idx in self._saved_selections:
            saved_idx, saved_multi = self._saved_selections[idx]
            self._selected_index = min(saved_idx, len(self._options) - 1)
            self._multi_selected = saved_multi
        elif q.question in self._answers:
            answer = self._answers[q.question]
            if q.multi_select:
                answer_labels = [a.strip() for a in answer.split(", ")]
                known_labels = {label for label, _ in self._options[:-1]}
                self._multi_selected = set()
                for i, (label, _) in enumerate(self._options[:-1]):
                    if label in answer_labels:
                        self._multi_selected.add(i)
                if any(answer_label not in known_labels for answer_label in answer_labels):
                    self._multi_selected.add(len(self._options) - 1)
                self._selected_index = min(self._multi_selected) if self._multi_selected else 0
            else:
                for i, (label, _) in enumerate(self._options):
                    if label == answer:
                        self._selected_index = i
                        break
                else:
                    self._selected_index = len(self._options) - 1
                self._multi_selected = set()
        else:
            self._selected_index = 0
            self._multi_selected = set()
        self._recompute_body()

    def _recompute_body(self) -> None:
        body = self._current_question.body
        self._body_text = body.rstrip("\n") if body else ""
        self.has_expandable_content = bool(self._body_text)

    @property
    def _current_question(self):
        return self.request.questions[self._current_question_index]

    @property
    def is_other_selected(self) -> bool:
        return self._selected_index == len(self._options) - 1

    @property
    def is_multi_select(self) -> bool:
        return self._current_question.multi_select

    @property
    def current_question_text(self) -> str:
        return self._current_question.question

    def should_prompt_other_input(self) -> bool:
        if not self.is_multi_select:
            return self.is_other_selected
        other_idx = len(self._options) - 1
        return other_idx in self._multi_selected

    def select_index(self, index: int) -> bool:
        if not (0 <= index < len(self._options)):
            return False
        self._selected_index = index
        return True

    def render(self, *, other_input_text: str | None = None) -> RenderableType:
        q = self._current_question
        lines: list[RenderableType] = []

        if len(self.request.questions) > 1:
            tab_parts: list[str] = []
            for i, qi in enumerate(self.request.questions):
                label = escape(qi.header or f"Q{i + 1}")
                if i == self._current_question_index:
                    icon, style = "\u25cf", "bold cyan"
                elif qi.question in self._answers:
                    icon, style = "\u2713", "green"
                else:
                    icon, style = "\u25cb", "grey50"
                tab_parts.append(f"[{style}]({icon}) {label}[/{style}]")
            lines.append(Text.from_markup("  ".join(tab_parts)))
            lines.append(Text(""))

        lines.append(Text.from_markup(f"[yellow]? {escape(q.question)}[/yellow]"))
        if q.multi_select:
            lines.append(Text("  (SPACE to toggle, ENTER to submit)", style="dim italic"))
        lines.append(Text(""))

        if self._body_text:
            lines.append(
                Text.from_markup(
                    "[bold cyan]  \u25b6 Press ctrl-e to view full content[/bold cyan]"
                )
            )
            lines.append(Text(""))

        show_inline_input = other_input_text is not None and self.is_other_selected

        for i, (label, description) in enumerate(self._options):
            num = i + 1
            is_other = i == len(self._options) - 1
            if q.multi_select:
                checked = "\u2713" if i in self._multi_selected else " "
                prefix = f"\\[{checked}]"
                if i == self._selected_index:
                    option_line = Text.from_markup(f"[cyan]{prefix} {escape(label)}[/cyan]")
                else:
                    option_line = Text.from_markup(f"[grey50]{prefix} {escape(label)}[/grey50]")
            else:
                if i == self._selected_index:
                    if is_other and show_inline_input:
                        input_display = escape(other_input_text) if other_input_text else ""
                        option_line = Text.from_markup(
                            f"[cyan]\u2192 \\[{num}] {escape(label)}: {input_display}\u2588[/cyan]"
                        )
                    else:
                        option_line = Text.from_markup(
                            f"[cyan]\u2192 \\[{num}] {escape(label)}[/cyan]"
                        )
                else:
                    option_line = Text.from_markup(f"[grey50]  \\[{num}] {escape(label)}[/grey50]")
            lines.append(option_line)

            if description and not (is_other and show_inline_input):
                lines.append(Text(f"      {description}", style="dim"))

        if show_inline_input:
            lines.append(Text(""))
            lines.append(
                Text("  Type your answer, then press Enter to submit.", style="dim italic")
            )
        elif len(self.request.questions) > 1:
            lines.append(Text(""))
            lines.append(
                Text(
                    "  \u25c4/\u25ba switch question  "
                    "\u25b2/\u25bc select  \u21b5 submit  esc exit",
                    style="dim",
                )
            )

        return Panel(
            Group(*lines),
            border_style="grey50",
            title="[bold]question[/bold]",
            title_align="left",
            padding=(0, 1),
        )

    def save_other_draft(self, text: str) -> None:
        if text:
            self._other_drafts[self._current_question_index] = text
        else:
            self._other_drafts.pop(self._current_question_index, None)

    def get_other_draft(self) -> str:
        return self._other_drafts.get(self._current_question_index, "")

    def go_to(self, index: int) -> None:
        if index == self._current_question_index:
            return
        if not (0 <= index < len(self.request.questions)):
            return
        self._saved_selections[self._current_question_index] = (
            self._selected_index,
            set(self._multi_selected),
        )
        self._current_question_index = index
        self._setup_current_question()

    def next_tab(self) -> None:
        if self._current_question_index < len(self.request.questions) - 1:
            self.go_to(self._current_question_index + 1)

    def prev_tab(self) -> None:
        if self._current_question_index > 0:
            self.go_to(self._current_question_index - 1)

    def move_up(self) -> None:
        self._selected_index = (self._selected_index - 1) % len(self._options)

    def move_down(self) -> None:
        self._selected_index = (self._selected_index + 1) % len(self._options)

    def toggle_select(self) -> None:
        if not self.is_multi_select:
            return
        if self._selected_index in self._multi_selected:
            self._multi_selected.discard(self._selected_index)
        else:
            self._multi_selected.add(self._selected_index)

    def submit(self) -> bool:
        q = self._current_question
        if q.multi_select:
            other_idx = len(self._options) - 1
            if other_idx in self._multi_selected:
                return False
            selected_labels = [
                self._options[i][0] for i in sorted(self._multi_selected) if i < len(q.options)
            ]
            if not selected_labels:
                return False
            self._answers[q.question] = ", ".join(selected_labels)
        else:
            if self.is_other_selected:
                return False
            self._answers[q.question] = self._options[self._selected_index][0]
        self._saved_selections.pop(self._current_question_index, None)
        self._other_drafts.pop(self._current_question_index, None)
        return self._advance()

    def submit_other(self, text: str) -> bool:
        q = self._current_question
        if q.multi_select:
            other_idx = len(self._options) - 1
            selected_labels = [
                self._options[i][0]
                for i in sorted(self._multi_selected)
                if i < len(q.options) and i != other_idx
            ]
            if text:
                selected_labels.append(text)
            self._answers[q.question] = ", ".join(selected_labels) if selected_labels else text
        else:
            self._answers[q.question] = text
        self._saved_selections.pop(self._current_question_index, None)
        self._other_drafts.pop(self._current_question_index, None)
        return self._advance()

    def _advance(self) -> bool:
        total = len(self.request.questions)
        if len(self._answers) >= total:
            return True
        for offset in range(1, total + 1):
            idx = (self._current_question_index + offset) % total
            if self.request.questions[idx].question not in self._answers:
                self._current_question_index = idx
                self._setup_current_question()
                return False
        return True

    def get_answers(self) -> dict[str, str]:
        return self._answers

    def render_full_body(self) -> list[RenderableType]:
        if not self._body_text:
            return []
        return [Markdown(self._body_text)]


def show_question_body_in_pager(panel: QuestionRequestPanel) -> None:
    with console.screen(), console.pager(styles=True):
        console.print(Text.from_markup(f"[yellow]? {escape(panel.current_question_text)}[/yellow]"))
        console.print()
        for renderable in panel.render_full_body():
            console.print(renderable)


async def prompt_other_input(question_text: str) -> str:
    console.print(Text.from_markup(f"\n[yellow]? {escape(question_text)}[/yellow]"))
    console.print(Text("  Enter your answer:", style="dim"))
    try:
        session: PromptSession[str] = PromptSession()
        return (await session.prompt_async("  > ")).strip()
    except (EOFError, KeyboardInterrupt):
        return ""


class QuestionPromptDelegate:
    modal_priority = 10
    _KEY_MAP: dict[str, KeyEvent] = {
        "up": KeyEvent.UP,
        "down": KeyEvent.DOWN,
        "left": KeyEvent.LEFT,
        "right": KeyEvent.RIGHT,
        "tab": KeyEvent.TAB,
        "space": KeyEvent.SPACE,
        "enter": KeyEvent.ENTER,
        "escape": KeyEvent.ESCAPE,
        "c-c": KeyEvent.ESCAPE,
        "c-d": KeyEvent.ESCAPE,
        "1": KeyEvent.NUM_1,
        "2": KeyEvent.NUM_2,
        "3": KeyEvent.NUM_3,
        "4": KeyEvent.NUM_4,
        "5": KeyEvent.NUM_5,
        "6": KeyEvent.NUM_6,
    }

    def __init__(
        self,
        panel: QuestionRequestPanel,
        *,
        on_advance: Callable[[], QuestionRequestPanel | None],
        on_invalidate: Callable[[], None],
        buffer_text_provider: Callable[[], str] | None = None,
        text_expander: Callable[[str], str] | None = None,
    ) -> None:
        self._panel: QuestionRequestPanel | None = panel
        self._awaiting_other_input = False
        self._on_advance = on_advance
        self._on_invalidate = on_invalidate
        self._buffer_text_provider = buffer_text_provider
        self._text_expander = text_expander

    @property
    def panel(self) -> QuestionRequestPanel | None:
        return self._panel

    def set_panel(self, panel: QuestionRequestPanel | None) -> None:
        self._panel = panel
        self._awaiting_other_input = False

    def _is_inline_other_active(self) -> bool:
        return (
            self._panel is not None
            and self._panel.is_other_selected
            and self._buffer_text_provider is not None
            and not self._panel.is_multi_select
        )

    def render_running_prompt_body(self, columns: int) -> ANSI:
        if self._panel is None:
            return ANSI("")
        other_input_text: str | None = None
        if self._is_inline_other_active():
            other_input_text = self._buffer_text_provider() if self._buffer_text_provider else ""
        body = render_to_ansi(
            self._panel.render(other_input_text=other_input_text),
            columns=columns,
        ).rstrip("\n")
        return ANSI(body if body else "")

    def running_prompt_placeholder(self) -> str | None:
        return None

    def running_prompt_allows_text_input(self) -> bool:
        if self._awaiting_other_input:
            return True
        return self._is_inline_other_active()

    def running_prompt_hides_input_buffer(self) -> bool:
        return self._panel is not None

    def running_prompt_accepts_submission(self) -> bool:
        return self._panel is not None

    def should_handle_running_prompt_key(self, key: str) -> bool:
        if self._panel is None:
            return False
        if key == "c-e":
            return self._panel.has_expandable_content
        if self._awaiting_other_input:
            return key in {"enter", "escape", "c-c", "c-d"}
        if self._is_inline_other_active():
            return key in {"enter", "escape", "c-c", "c-d", "up", "down", "left", "right", "tab"}
        return key in {
            "up",
            "down",
            "left",
            "right",
            "tab",
            "space",
            "enter",
            "escape",
            "c-c",
            "c-d",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
        }

    def handle_running_prompt_key(self, key: str, event: KeyPressEvent) -> None:
        if key == "c-e":
            event.app.create_background_task(self._show_panel_in_pager())
            return
        if self._awaiting_other_input:
            if key == "enter":
                self._submit_other_input(event.current_buffer)
            else:
                self._clear_buffer(event.current_buffer)
                self._awaiting_other_input = False
                if self._panel is not None:
                    self._panel.request.resolve({})
                self._advance()
            self._on_invalidate()
            return

        if self._is_inline_other_active():
            mapped = self._KEY_MAP.get(key)
            if key == "enter" or mapped == KeyEvent.ENTER:
                text = event.current_buffer.text.strip()
                if text:
                    self._submit_other_input(event.current_buffer)
                self._on_invalidate()
                return
            if mapped == KeyEvent.ESCAPE:
                self._clear_buffer(event.current_buffer)
                if self._panel is not None:
                    self._panel.request.resolve({})
                self._advance()
                self._on_invalidate()
                return
            if mapped in {KeyEvent.UP, KeyEvent.DOWN, KeyEvent.LEFT, KeyEvent.RIGHT, KeyEvent.TAB}:
                self._save_and_clear_buffer(event.current_buffer)
                self._dispatch_keyboard_event(mapped)
                self._restore_draft_to_buffer(event.current_buffer)
                self._on_invalidate()
                return
            return

        mapped = self._KEY_MAP.get(key)
        if mapped is None:
            return
        if mapped in {KeyEvent.ENTER, KeyEvent.SPACE} and self._should_prompt_other_for_key(mapped):
            text = event.current_buffer.text.strip()
            if text:
                self._submit_other_input(event.current_buffer)
            else:
                self._clear_buffer(event.current_buffer)
                self._awaiting_other_input = True
            self._on_invalidate()
            return

        if mapped == KeyEvent.ESCAPE:
            if self._panel is not None:
                self._panel.request.resolve({})
            self._advance()
            self._on_invalidate()
            return

        if self._panel is not None:
            self._save_and_clear_buffer(event.current_buffer)
        self._dispatch_keyboard_event(mapped)
        self._restore_draft_to_buffer(event.current_buffer)
        self._on_invalidate()

    def _should_prompt_other_for_key(self, key: KeyEvent) -> bool:
        if self._panel is None or not self._panel.should_prompt_other_input():
            return False
        return key == KeyEvent.ENTER or (key == KeyEvent.SPACE and not self._panel.is_multi_select)

    def _dispatch_keyboard_event(self, event: KeyEvent) -> None:
        panel = self._panel
        if panel is None:
            return
        match event:
            case KeyEvent.UP:
                panel.move_up()
            case KeyEvent.DOWN:
                panel.move_down()
            case KeyEvent.LEFT:
                panel.prev_tab()
            case KeyEvent.RIGHT | KeyEvent.TAB:
                panel.next_tab()
            case KeyEvent.SPACE:
                if panel.is_multi_select:
                    panel.toggle_select()
                else:
                    self._try_submit()
            case KeyEvent.ENTER:
                self._try_submit()
            case (
                KeyEvent.NUM_1
                | KeyEvent.NUM_2
                | KeyEvent.NUM_3
                | KeyEvent.NUM_4
                | KeyEvent.NUM_5
                | KeyEvent.NUM_6
            ):
                num_map = {
                    KeyEvent.NUM_1: 0,
                    KeyEvent.NUM_2: 1,
                    KeyEvent.NUM_3: 2,
                    KeyEvent.NUM_4: 3,
                    KeyEvent.NUM_5: 4,
                    KeyEvent.NUM_6: 5,
                }
                idx = num_map[event]
                if panel.select_index(idx):
                    if panel.is_multi_select:
                        panel.toggle_select()
                    elif not panel.is_other_selected:
                        self._try_submit()
            case _:
                pass

    def _try_submit(self) -> None:
        if self._panel is None:
            return
        all_done = self._panel.submit()
        if all_done:
            self._panel.request.resolve(self._panel.get_answers())
            self._advance()

    def _submit_other_input(self, buffer: Buffer) -> None:
        if self._panel is None:
            self._clear_buffer(buffer)
            self._awaiting_other_input = False
            return
        text = buffer.text.strip()
        if self._text_expander is not None:
            text = self._text_expander(text)
        self._clear_buffer(buffer)
        self._awaiting_other_input = False
        all_done = self._panel.submit_other(text)
        if all_done:
            self._panel.request.resolve(self._panel.get_answers())
            self._advance()

    def _advance(self) -> None:
        next_panel = self._on_advance()
        self._panel = next_panel
        self._awaiting_other_input = False

    def _save_and_clear_buffer(self, buffer: Buffer) -> None:
        if self._panel is not None and buffer.text:
            self._panel.save_other_draft(buffer.text)
        self._clear_buffer(buffer)

    def _restore_draft_to_buffer(self, buffer: Buffer) -> None:
        if self._is_inline_other_active() and self._panel is not None:
            draft = self._panel.get_other_draft()
            if draft:
                buffer.set_document(
                    Document(text=draft, cursor_position=len(draft)),
                    bypass_readonly=True,
                )

    @staticmethod
    def _clear_buffer(buffer: Buffer) -> None:
        if buffer.text:
            buffer.set_document(Document(text="", cursor_position=0), bypass_readonly=True)

    async def _show_panel_in_pager(self) -> None:
        if self._panel is None:
            return
        panel = self._panel
        await run_in_terminal(lambda: show_question_body_in_pager(panel))
        self._on_invalidate()

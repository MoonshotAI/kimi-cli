"""Interactive session picker with directory scope toggle.

Provides a full-screen prompt_toolkit Application that lets the user browse
sessions for the current working directory or across all known directories,
toggled via ``Ctrl+A``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from kaos.path import KaosPath
from prompt_toolkit.application import Application
from prompt_toolkit.formatted_text import StyleAndTextTuples
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.layout import HSplit, Layout, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.styles import Style
from prompt_toolkit.widgets import Box, Frame, RadioList

from kimi_cli.session import Session
from kimi_cli.utils.datetime import format_relative_time

SessionScope = Literal["current", "all"]

_EMPTY_SESSION_ID = "__empty__"


def _shorten_work_dir(work_dir: str, max_len: int = 30) -> str:
    """Abbreviate a work directory path for display."""
    home = str(Path.home())
    if work_dir.startswith(home):
        work_dir = "~" + work_dir[len(home) :]
    if len(work_dir) <= max_len:
        return work_dir
    return "..." + work_dir[-(max_len - 3) :]


class SessionPickerApp:
    """Full-screen session picker with Ctrl+A directory scope toggle."""

    def __init__(
        self,
        *,
        work_dir: KaosPath,
        current_session: Session,
    ) -> None:
        self._work_dir = work_dir
        self._current_session = current_session
        self._scope: SessionScope = "current"
        self._sessions: list[Session] = []
        self._result: str | None = None

        self._radio_list = RadioList[str](
            values=[(_EMPTY_SESSION_ID, "Loading...")],
            default=_EMPTY_SESSION_ID,
            show_numbers=False,
            select_on_focus=True,
            open_character="",
            select_character=">",
            close_character="",
            show_cursor=False,
            show_scrollbar=False,
            container_style="class:task-list",
            checked_style="class:task-list.checked",
        )
        self._app = self._build_app()

    async def run(self) -> str | None:
        """Run the picker and return the selected session ID, or None."""
        await self._load_sessions()
        self._sync_radio_list()
        result = await self._app.run_async()
        if result is None:
            return None
        if result == _EMPTY_SESSION_ID:
            return None
        return result

    # ------------------------------------------------------------------
    # Data loading
    # ------------------------------------------------------------------

    async def _load_sessions(self) -> None:
        current = self._current_session

        if self._scope == "current":
            sessions = [s for s in await Session.list(self._work_dir) if s.id != current.id]
        else:
            sessions = [s for s in await Session.list_all() if s.id != current.id]

        await current.refresh()
        sessions.insert(0, current)
        self._sessions = sessions

    def _build_values(self) -> list[tuple[str, str]]:
        if not self._sessions:
            return [(_EMPTY_SESSION_ID, "No sessions found.")]

        current_id = self._current_session.id
        values: list[tuple[str, str]] = []
        for session in self._sessions:
            time_str = format_relative_time(session.updated_at)
            short_id = session.id[:8]
            marker = " (current)" if session.id == current_id else ""

            if self._scope == "all":
                wd = _shorten_work_dir(str(session.work_dir))
                label = f"{session.title} ({short_id}), {time_str}{marker} \u2014 {wd}"
            else:
                label = f"{session.title} ({short_id}), {time_str}{marker}"

            values.append((session.id, label))
        return values

    def _sync_radio_list(self) -> None:
        values = self._build_values()
        self._radio_list.values = values
        default = values[0][0]
        self._radio_list.current_value = default
        self._radio_list.current_values = [default]
        for idx, (val, _) in enumerate(values):
            if val == default:
                self._radio_list._selected_index = idx  # pyright: ignore[reportPrivateUsage]
                break

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _header_fragments(self) -> StyleAndTextTuples:
        scope_label = "current directory" if self._scope == "current" else "all directories"
        return [
            ("class:header.title", " SESSIONS "),
            ("class:header.meta", f" [{scope_label}] "),
        ]

    def _footer_fragments(self) -> StyleAndTextTuples:
        return [
            ("class:footer.key", " Ctrl+A "),
            ("class:footer.text", "toggle all directories  "),
            ("class:footer.key", " Enter "),
            ("class:footer.text", "select  "),
            ("class:footer.key", " Ctrl+C "),
            ("class:footer.text", "cancel "),
        ]

    def _build_app(self) -> Application[str | None]:
        kb = KeyBindings()

        @kb.add("escape")
        @kb.add("c-c")
        def _cancel(event: KeyPressEvent) -> None:
            event.app.exit(result=None)

        @kb.add("enter", eager=True)
        def _select(event: KeyPressEvent) -> None:
            value = self._radio_list.current_value
            event.app.exit(result=value)

        @kb.add("c-a")
        def _toggle_scope(event: KeyPressEvent) -> None:
            self._scope = "all" if self._scope == "current" else "current"
            event.app.create_background_task(self._reload_and_refresh(event.app))

        # Mark handlers as used
        _ = (_cancel, _select, _toggle_scope)

        header = Window(
            FormattedTextControl(self._header_fragments),
            height=1,
            style="class:header",
        )
        body = Frame(
            Box(self._radio_list, padding=1),
            title=lambda: " Sessions ",
        )
        footer = Window(
            FormattedTextControl(self._footer_fragments),
            height=1,
            style="class:footer",
        )

        return Application(
            layout=Layout(
                HSplit([header, body, footer]),
                focused_element=self._radio_list,
            ),
            key_bindings=kb,
            full_screen=True,
            erase_when_done=True,
            style=_session_picker_style(),
        )

    async def _reload_and_refresh(self, app: Application[str | None]) -> None:
        # Show loading state
        self._radio_list.values = [(_EMPTY_SESSION_ID, "Loading...")]
        self._radio_list.current_value = _EMPTY_SESSION_ID
        self._radio_list._selected_index = 0  # pyright: ignore[reportPrivateUsage]
        app.invalidate()

        await self._load_sessions()
        self._sync_radio_list()
        app.invalidate()


def _session_picker_style() -> Style:
    from kimi_cli.ui.theme import get_task_browser_style

    return get_task_browser_style()

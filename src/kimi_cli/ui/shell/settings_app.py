"""Interactive Settings TUI for /setting command."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Literal

from prompt_toolkit.application import Application
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import StyleAndTextTuples
from prompt_toolkit.key_binding import KeyBindings, KeyPressEvent
from prompt_toolkit.layout import HSplit, Layout, VSplit, Window
from prompt_toolkit.layout.controls import FormattedTextControl
from prompt_toolkit.widgets import Box, Frame, RadioList

from kimi_cli.config import load_config, save_config
from kimi_cli.exception import ConfigError
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.ui.theme import get_active_theme, get_task_browser_style

_SettingKey = Literal["model", "editor", "theme", "yolo", "plan_mode", "show_thinking_stream"]
_Mode = Literal["main", "edit"]

_FLASH_MESSAGE_SECONDS = 3.0


class _SettingItem:
    __slots__ = ("key", "name", "description", "value_fn")

    def __init__(
        self,
        key: _SettingKey,
        name: str,
        description: str,
        value_fn: Callable[[], str],
    ):
        self.key = key
        self.name = name
        self.description = description
        self.value_fn = value_fn


class SettingsApp:
    """Full-screen settings browser with inline editing for simple values."""

    def __init__(self, soul: KimiSoul, *, default_key: _SettingKey | None = None):
        self.soul = soul
        self.config = soul.runtime.config
        self.config_file = self.config.source_file
        self._mode: _Mode = "main"
        self._flash_message: str = ""
        self._flash_expires_at: float | None = None
        self.result_key: _SettingKey | None = None
        """If set, caller should open the interactive flow for this key."""
        self.needs_reload = False
        """Set to True when an in-app change (e.g. theme) requires a session reload."""
        self._edit_key: _SettingKey | None = None

        self._items = self._build_items()
        default = default_key if default_key is not None else self._items[0].key
        self._radio_list = RadioList(
            values=self._main_values(),
            default=default,
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

    # ------------------------------------------------------------------
    # Data
    # ------------------------------------------------------------------

    def _build_items(self) -> list[_SettingItem]:
        config = self.config
        soul = self.soul

        curr_model_cfg = soul.runtime.llm.model_config if soul.runtime.llm else None
        curr_model_name: str | None = None
        if curr_model_cfg is not None:
            for name, model_cfg in config.models.items():
                if model_cfg == curr_model_cfg:
                    curr_model_name = name
                    break

        def _model_value() -> str:
            thinking_label = "thinking on" if soul.thinking else "thinking off"
            model_label = curr_model_name or "none"
            return f"{model_label} ({thinking_label})"

        return [
            _SettingItem(
                "model",
                "Model",
                "Switch the default LLM model and thinking mode.",
                _model_value,
            ),
            _SettingItem(
                "editor",
                "Editor",
                "Default external editor for Ctrl-O.",
                lambda: config.default_editor or "auto-detect",
            ),
            _SettingItem(
                "theme",
                "Theme",
                "Terminal color theme (dark/light).",
                get_active_theme,
            ),
            _SettingItem(
                "yolo",
                "YOLO mode",
                "Auto-approve all actions without confirmation.",
                lambda: "on" if soul.runtime.approval.is_yolo() else "off",
            ),
            _SettingItem(
                "plan_mode",
                "Plan mode",
                "Read-only planning mode before implementation.",
                lambda: "on" if soul.plan_mode else "off",
            ),
            _SettingItem(
                "show_thinking_stream",
                "Show thinking stream",
                "Display model reasoning content in the terminal output.",
                lambda: "on" if config.show_thinking_stream else "off",
            ),
        ]

    def _main_values(self) -> list[tuple[str, str]]:
        lines: list[tuple[str, str]] = []
        for item in self._items:
            lines.append((item.key, f"{item.name:20} {item.value_fn()}"))
        return lines

    def _detail_text(self) -> str:
        key = self._radio_list.current_value
        for item in self._items:
            if item.key == key:
                return f"{item.description}\n\nCurrent value: {item.value_fn()}"
        return ""

    def _set_flash(self, text: str) -> None:
        self._flash_message = text
        self._flash_expires_at = time.time() + _FLASH_MESSAGE_SECONDS

    def _current_flash(self) -> str | None:
        if not self._flash_message:
            return None
        if self._flash_expires_at is not None and time.time() > self._flash_expires_at:
            self._flash_message = ""
            self._flash_expires_at = None
            return None
        return self._flash_message

    # ------------------------------------------------------------------
    # Editing logic
    # ------------------------------------------------------------------

    def _enter_edit_mode(self) -> None:
        key = self._radio_list.current_value
        if key in ("editor", "model"):
            # These need external interactive flows.
            self.result_key = key  # type: ignore[assignment]
            self._app.exit()
            return

        options: list[tuple[str, str]] = []
        if key == "theme":
            current = get_active_theme()
            options = [
                ("dark", "dark" + (" ← current" if current == "dark" else "")),
                ("light", "light" + (" ← current" if current == "light" else "")),
            ]
        elif key == "yolo":
            current = self.soul.runtime.approval.is_yolo()
            options = [
                ("off", "off" + (" ← current" if not current else "")),
                ("on", "on" + (" ← current" if current else "")),
            ]
        elif key == "plan_mode":
            current = self.soul.plan_mode
            options = [
                ("off", "off" + (" ← current" if not current else "")),
                ("on", "on" + (" ← current" if current else "")),
            ]
        elif key == "show_thinking_stream":
            current = self.config.show_thinking_stream
            options = [
                ("off", "off" + (" ← current" if not current else "")),
                ("on", "on" + (" ← current" if current else "")),
            ]
        else:
            return

        self._mode = "edit"
        self._edit_key = key
        self._radio_list.values = options
        self._radio_list.current_value = options[0][0]
        self._radio_list.current_values = [options[0][0]]
        self._radio_list._selected_index = 0  # pyright: ignore[reportPrivateUsage]

    def _apply_edit(self) -> None:
        if self._mode != "edit":
            return
        key: _SettingKey = getattr(self, "_edit_key", None)  # type: ignore[assignment]
        value = self._radio_list.current_value
        applied = False

        if key == "theme" and self.config_file is not None:
            try:
                cfg = load_config(self.config_file)
                if value != cfg.theme:
                    cfg.theme = value  # type: ignore[assignment]
                    save_config(cfg, self.config_file)
                    applied = True
                    self.needs_reload = True
            except (ConfigError, OSError) as exc:
                self._set_flash(f"Failed to save: {exc}")
        elif key == "yolo" and self.config_file is not None:
            new_yolo = value == "on"
            current_yolo = self.soul.runtime.approval.is_yolo()
            if new_yolo != current_yolo:
                try:
                    cfg = load_config(self.config_file)
                    cfg.default_yolo = new_yolo
                    save_config(cfg, self.config_file)
                    self.soul.runtime.approval.set_yolo(new_yolo)
                    self.config.default_yolo = new_yolo
                    applied = True
                except (ConfigError, OSError) as exc:
                    self._set_flash(f"Failed to save: {exc}")
        elif key == "plan_mode" and self.config_file is not None:
            new_plan = value == "on"
            current_plan = self.soul.plan_mode
            if new_plan != current_plan:
                try:
                    cfg = load_config(self.config_file)
                    cfg.default_plan_mode = new_plan
                    save_config(cfg, self.config_file)
                    self.config.default_plan_mode = new_plan
                    applied = True
                except (ConfigError, OSError) as exc:
                    self._set_flash(f"Failed to save: {exc}")
            if applied:
                import asyncio

                task = asyncio.get_running_loop().create_task(
                    self.soul.toggle_plan_mode_from_manual()
                )
                task.add_done_callback(
                    lambda t: None if t.cancelled() else t.exception() if t.exception() else None
                )
        elif key == "show_thinking_stream" and self.config_file is not None:
            new_val = value == "on"
            current_val = self.config.show_thinking_stream
            if new_val != current_val:
                try:
                    cfg = load_config(self.config_file)
                    cfg.show_thinking_stream = new_val
                    save_config(cfg, self.config_file)
                    self.config.show_thinking_stream = new_val
                    applied = True
                except (ConfigError, OSError) as exc:
                    self._set_flash(f"Failed to save: {exc}")

        self._return_to_main()
        if applied:
            self._set_flash("Setting saved.")

    def _cancel_edit(self) -> None:
        self._return_to_main()

    def _return_to_main(self) -> None:
        self._mode = "main"
        self._radio_list.values = self._main_values()
        self._radio_list.current_value = self._items[0].key
        self._radio_list.current_values = [self._items[0].key]
        self._radio_list._selected_index = 0  # pyright: ignore[reportPrivateUsage]

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _header_fragments(self) -> StyleAndTextTuples:
        if self._mode == "edit":
            key = self._edit_key or ""
            for item in self._items:
                if item.key == key:
                    return [
                        ("class:header.title", f" Settings — {item.name} "),
                    ]
            return [("class:header.title", " Settings ")]
        return [("class:header.title", " Settings ")]

    def _footer_fragments(self) -> StyleAndTextTuples:
        if self._mode == "edit":
            fragments: StyleAndTextTuples = [
                ("class:footer.key", " Enter "),
                ("class:footer.text", " confirm  "),
                ("class:footer.key", " Esc "),
                ("class:footer.text", " cancel "),
            ]
        else:
            fragments = [
                ("class:footer.key", " Enter "),
                ("class:footer.text", " edit  "),
                ("class:footer.key", " Esc/Q "),
                ("class:footer.text", " exit "),
            ]
        if flash := self._current_flash():
            fragments.extend(
                [
                    ("class:footer.meta", " | "),
                    ("class:footer.flash", f" {flash} "),
                ]
            )
        return fragments

    def _build_app(self) -> Application[None]:
        kb = KeyBindings()

        @kb.add("enter", eager=True)
        def _confirm(event: KeyPressEvent) -> None:
            if self._mode == "main":
                self._enter_edit_mode()
            else:
                self._apply_edit()
            event.app.invalidate()

        @kb.add("escape")
        @kb.add("c-c")
        def _cancel(event: KeyPressEvent) -> None:
            if self._mode == "edit":
                self._cancel_edit()
                event.app.invalidate()
            else:
                event.app.exit()

        @Condition
        def _main_mode() -> bool:
            return self._mode == "main"

        @kb.add("q", filter=_main_mode)
        def _quit(event: KeyPressEvent) -> None:
            event.app.exit()

        # Mark handlers as used
        _ = (_confirm, _cancel, _quit)

        header = Window(
            FormattedTextControl(self._header_fragments),
            height=1,
            style="class:header",
        )
        list_frame = Frame(
            Box(self._radio_list, padding=1),
            title=lambda: " Options " if self._mode == "main" else " Select value ",
        )
        detail_frame = Frame(
            Window(
                FormattedTextControl(lambda: [("", self._detail_text())]),
                wrap_lines=True,
            ),
            title=" Detail ",
        )
        body = VSplit([list_frame, detail_frame])
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
            style=get_task_browser_style(),
        )

    async def run(self) -> _SettingKey | None:
        await self._app.run_async()
        return self.result_key

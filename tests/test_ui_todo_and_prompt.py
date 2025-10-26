import pytest
from prompt_toolkit.key_binding import KeyBindings

from kimi_cli.soul import StatusSnapshot
from kimi_cli.ui.shell.liveview import StepLiveView
from kimi_cli.ui.shell.todo import get_todo, set_todo


@pytest.fixture(autouse=True)
def reset_todo():
    # Ensure TODO storage is clean for each test
    set_todo("initial")
    yield
    set_todo("")


def _make_tool_call(tool_id: str, name: str):
    from kosong.base.message import ToolCall

    return ToolCall(id=tool_id, function=ToolCall.FunctionBody(name=name, arguments=None))


def _make_tool_result(tool_id: str, ok: bool = True, output: str | None = None):
    from kosong.tooling import ToolError, ToolOk, ToolResult

    result = ToolOk(output=output or "") if ok else ToolError(message="boom", brief="error")
    return ToolResult(tool_call_id=tool_id, result=result)


def test_liveview_sets_todo_on_successful_set_todo_list():
    with StepLiveView(StatusSnapshot(context_usage=0.0)) as view:
        call = _make_tool_call("tc1", "SetTodoList")
        view.append_tool_call(call)
        view.append_tool_result(_make_tool_result("tc1", ok=True, output="- A [Pending]\n"))

    assert get_todo() == "- A [Pending]\n"


def test_liveview_does_not_set_todo_for_other_tools_or_unsuccessful():
    # Start with a known value
    set_todo("keep-me")
    with StepLiveView(StatusSnapshot(context_usage=0.0)) as view:
        # Other tool should not change TODO
        bash_call = _make_tool_call("tc2", "Bash")
        view.append_tool_call(bash_call)
        view.append_tool_result(_make_tool_result("tc2", ok=True, output="some output"))

        # Unsuccessful SetTodoList should not change TODO
        todo_call = _make_tool_call("tc3", "SetTodoList")
        view.append_tool_call(todo_call)
        view.append_tool_result(_make_tool_result("tc3", ok=False))

    assert get_todo() == "keep-me"


class _CaptureFT:
    def __init__(self, fragments):
        self.fragments = fragments


def test_prompt_show_todos_prints_content_when_non_empty(monkeypatch):
    # Capture the handler registered for Ctrl-T without affecting global KeyBindings
    captured: dict[str, object] = {}

    import kimi_cli.ui.shell.prompt as prompt_mod
    from kimi_cli.ui.shell.console import console

    class CapturingKeyBindings(KeyBindings):  # type: ignore[misc]
        def add(self, *keys, **kwargs):  # type: ignore[override]
            dec = super().add(*keys, **kwargs)

            def wrapper(fn):
                if "c-t" in keys:
                    captured["handler"] = fn
                return dec(fn)

            return wrapper

    monkeypatch.setattr(prompt_mod, "KeyBindings", CapturingKeyBindings, raising=True)

    # Make run_in_terminal call the function immediately
    monkeypatch.setattr(prompt_mod, "run_in_terminal", lambda fn: fn(), raising=True)
    monkeypatch.setattr(prompt_mod, "get_todo", lambda: "My TODOs\n- item 1", raising=True)

    # Create session (this will register key bindings)
    _ = prompt_mod.CustomPromptSession(lambda: StatusSnapshot(0.0))

    # Invoke the captured Ctrl-T handler
    assert "handler" in captured, "Ctrl-T handler was not registered"

    with console.capture() as cap:
        handler = captured["handler"]
        handler(None)  # type: ignore[misc]
    out = cap.get()

    assert "My TODOs" in out


def test_prompt_show_todos_prints_no_todos_when_empty(monkeypatch):
    captured: dict[str, object] = {}

    import kimi_cli.ui.shell.prompt as prompt_mod
    from kimi_cli.ui.shell.console import console

    class CapturingKeyBindings(KeyBindings):  # type: ignore[misc]
        def add(self, *keys, **kwargs):  # type: ignore[override]
            dec = super().add(*keys, **kwargs)

            def wrapper(fn):
                if "c-t" in keys:
                    captured["handler"] = fn
                return dec(fn)

            return wrapper

    monkeypatch.setattr(prompt_mod, "KeyBindings", CapturingKeyBindings, raising=True)

    monkeypatch.setattr(prompt_mod, "run_in_terminal", lambda fn: fn(), raising=True)
    # Return empty/whitespace -> considered empty
    monkeypatch.setattr(prompt_mod, "get_todo", lambda: "   ", raising=True)

    _ = prompt_mod.CustomPromptSession(lambda: StatusSnapshot(0.0))

    assert "handler" in captured, "Ctrl-T handler was not registered"

    with console.capture() as cap:
        handler = captured["handler"]
        handler(None)  # type: ignore[misc]
    out = cap.get()

    assert "No TODOs yet" in out


def test_bottom_toolbar_shows_ctrl_t_shortcut(monkeypatch):
    # Patch app getter to provide width
    import kimi_cli.ui.shell.prompt as prompt_mod

    class _Size:
        columns = 200

    class _Output:
        def get_size(self):
            return _Size()

    class _App:
        output = _Output()

    monkeypatch.setattr(prompt_mod, "get_app_or_none", lambda: _App(), raising=True)

    # Patch FormattedText to capture fragments
    monkeypatch.setattr(prompt_mod, "FormattedText", _CaptureFT, raising=True)

    session = prompt_mod.CustomPromptSession(lambda: StatusSnapshot(0.0))
    ft = session._render_bottom_toolbar()  # type: ignore[attr-defined]

    text = "".join(seg for _, seg in ft.fragments)  # type: ignore[attr-defined]
    assert "ctrl-t: todos" in text

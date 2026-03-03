from kimi_cli.ui.shell.prompt import _build_toolbar_tips


def test_build_toolbar_tips_without_clipboard():
    assert _build_toolbar_tips(clipboard_available=False) == [
        "ctrl-x: toggle mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "@: mention files",
    ]


def test_build_toolbar_tips_with_clipboard():
    assert _build_toolbar_tips(clipboard_available=True) == [
        "ctrl-x: toggle mode",
        "ctrl-o: editor",
        "ctrl-j: newline",
        "ctrl-v: paste image",
        "@: mention files",
    ]

from __future__ import annotations

from inline_snapshot import snapshot

from kimi_cli.tools.file.utils import build_diff_blocks
from kimi_cli.wire.types import DiffDisplayBlock


def test_build_diff_blocks_simple_change() -> None:
    old_text = """
Line one
Line two
Line three
Line four
Line five
""".strip()
    new_text = """
Line one 123
Line two
Line three
Line four
Line five modified
Line six added
""".strip()

    blocks = build_diff_blocks("/tmp/simple.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/simple.txt",
                old_text="""\
Line one
Line two
Line three
Line four
Line five\
""",
                new_text="""\
Line one 123
Line two
Line three
Line four
Line five modified
Line six added\
""",
            ),
        ]
    )


def test_build_diff_blocks_insert_only() -> None:
    old_text = """
Line one
Line two
""".strip()
    new_text = """
Line one
Line two
Line three
Line four
""".strip()

    blocks = build_diff_blocks("/tmp/insert.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/insert.txt",
                old_text="""\
Line one
Line two\
""",
                new_text="""\
Line one
Line two
Line three
Line four\
""",
            )
        ]
    )


def test_build_diff_blocks_delete_only() -> None:
    old_text = """
Line one
Line two
Line three
Line four
""".strip()
    new_text = """
Line one
Line four
""".strip()

    blocks = build_diff_blocks("/tmp/delete.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/delete.txt",
                old_text="""\
Line one
Line two
Line three
Line four\
""",
                new_text="""\
Line one
Line four\
""",
            )
        ]
    )


def test_build_diff_blocks_multiline_replace() -> None:
    old_text = """
Alpha
Bravo
Charlie
Delta
Echo
""".strip()
    new_text = """
Alpha
Xray
Yankee
Delta
Echo
""".strip()

    blocks = build_diff_blocks("/tmp/replace.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/replace.txt",
                old_text="""\
Alpha
Bravo
Charlie
Delta
Echo\
""",
                new_text="""\
Alpha
Xray
Yankee
Delta
Echo\
""",
            )
        ]
    )


def test_build_diff_blocks_complex_change() -> None:
    old_text = """
Line one
Line two
Line three
Line four
Line five
Line six
Line seven
Line eight
Line nine
Line ten
""".strip()
    new_text = """
Line one
Line two updated
Line three
Line five
Line six
Line seven
Line eight inserted A
Line eight inserted B
Line eight
Line nine updated
Line ten
Line eleven
""".strip()

    blocks = build_diff_blocks("/tmp/complex.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/complex.txt",
                old_text="""\
Line one
Line two
Line three
Line four
Line five
Line six
Line seven
Line eight
Line nine
Line ten\
""",
                new_text="""\
Line one
Line two updated
Line three
Line five
Line six
Line seven
Line eight inserted A
Line eight inserted B
Line eight
Line nine updated
Line ten
Line eleven\
""",
            ),
        ]
    )


def test_build_diff_blocks_split_by_context_window() -> None:
    old_text = """
Line 1
Line 2
Line 3
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
Line 12
Line 13
Line 14
Line 15
Line 16
""".strip()
    new_text = """
Line 1
Line 2 updated
Line 3
Line 4
Line 5
Line 6
Line 7
Line 8
Line 9
Line 10
Line 11
Line 12
Line 13
Line 14 updated
Line 15
Line 16
""".strip()

    blocks = build_diff_blocks("/tmp/context.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/context.txt",
                old_text="""\
Line 1
Line 2
Line 3
Line 4
Line 5\
""",
                new_text="""\
Line 1
Line 2 updated
Line 3
Line 4
Line 5\
""",
            ),
            DiffDisplayBlock(
                path="/tmp/context.txt",
                old_text="""\
Line 11
Line 12
Line 13
Line 14
Line 15
Line 16\
""",
                new_text="""\
Line 11
Line 12
Line 13
Line 14 updated
Line 15
Line 16\
""",
            ),
        ]
    )


def test_build_diff_blocks_old_empty() -> None:
    old_text = ""
    new_text = """
Line 1
Line 2
""".strip()

    blocks = build_diff_blocks("/tmp/old-empty.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/old-empty.txt",
                old_text="",
                new_text="""\
Line 1
Line 2\
""",
            )
        ]
    )


def test_build_diff_blocks_new_empty() -> None:
    old_text = """
Line 1
Line 2
""".strip()
    new_text = ""

    blocks = build_diff_blocks("/tmp/new-empty.txt", old_text, new_text)

    assert blocks == snapshot(
        [
            DiffDisplayBlock(
                path="/tmp/new-empty.txt",
                old_text="""\
Line 1
Line 2\
""",
                new_text="",
            )
        ]
    )


def test_build_diff_blocks_both_empty() -> None:
    blocks = build_diff_blocks("/tmp/both-empty.txt", "", "")

    assert blocks == snapshot([])


def test_build_diff_blocks_equal_text() -> None:
    text = """
Line 1
Line 2
""".strip()

    blocks = build_diff_blocks("/tmp/equal.txt", text, text)

    assert blocks == snapshot([])

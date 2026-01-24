from pathlib import Path
from tempfile import TemporaryDirectory

import pytest
from inline_snapshot import snapshot

from kimi_cli.utils.frontmatter import read_frontmatter


def test_read_frontmatter_parses_yaml():
    with TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / "frontmatter.md"
        path.write_text(
            """---
name: test-skill
description: A test skill
extra: 123
---

# Body
""",
            encoding="utf-8",
        )

        data = read_frontmatter(path)

        assert data == {
            "name": "test-skill",
            "description": "A test skill",
            "extra": 123,
        }


def test_read_frontmatter_invalid_yaml():
    with TemporaryDirectory() as tmpdir:
        path = Path(tmpdir) / "frontmatter.md"
        path.write_text(
            """---
name: "unterminated
description: oops
---
""",
            encoding="utf-8",
        )

        with pytest.raises(ValueError) as exc_info:
            read_frontmatter(path)

        assert str(exc_info.value) == snapshot("Invalid frontmatter YAML.")

"""Tests for parser module."""

import pytest

from agenthooks_ref.errors import ParseError, ValidationError
from agenthooks_ref.models import HookEventType
from agenthooks_ref.parser import find_hook_md, parse_frontmatter, read_properties


class TestFindHookMd:
    def test_finds_uppercase_hook_md(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text("---\n---\n")
        result = find_hook_md(hook_dir)
        assert result == hook_dir / "HOOK.md"

    def test_finds_lowercase_hook_md(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "hook.md").write_text("---\n---\n")
        result = find_hook_md(hook_dir)
        assert result == hook_dir / "hook.md"

    def test_prefers_uppercase(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text("---\n---\n")
        (hook_dir / "hook.md").write_text("---\n---\n")
        result = find_hook_md(hook_dir)
        assert result == hook_dir / "HOOK.md"

    def test_returns_none_if_not_found(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        result = find_hook_md(hook_dir)
        assert result is None


class TestParseFrontmatter:
    def test_parses_valid_frontmatter(self):
        content = "---\nname: my-hook\n---\n# Body"
        metadata, body = parse_frontmatter(content)
        assert metadata["name"] == "my-hook"
        assert body == "# Body"

    def test_parses_frontmatter_with_multiple_lines(self):
        content = "---\nname: my-hook\ndescription: A test hook\n---\n# Body content\nMore content"
        metadata, body = parse_frontmatter(content)
        assert metadata["name"] == "my-hook"
        assert metadata["description"] == "A test hook"
        assert body == "# Body content\nMore content"

    def test_raises_if_no_frontmatter(self):
        content = "# No frontmatter"
        with pytest.raises(ParseError, match="must start with YAML frontmatter"):
            parse_frontmatter(content)

    def test_raises_if_frontmatter_not_closed(self):
        content = "---\nname: my-hook\n# Body"
        with pytest.raises(ParseError, match="frontmatter not properly closed"):
            parse_frontmatter(content)

    def test_raises_if_invalid_yaml(self):
        content = "---\nname: [invalid yaml: : :\n---\nBody"
        with pytest.raises(ParseError, match="Invalid YAML"):
            parse_frontmatter(content)

    def test_normalizes_async_key(self):
        content = "---\nasync: true\n---\nBody"
        metadata, _ = parse_frontmatter(content)
        assert "async_" in metadata
        assert metadata["async_"] is True


class TestReadProperties:
    def test_reads_basic_properties(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
---
# My Hook
"""
        )
        props = read_properties(hook_dir)
        assert props.name == "my-hook"
        assert props.description == "A test hook"
        assert props.trigger == HookEventType.BEFORE_TOOL

    def test_reads_all_properties(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: after_tool
matcher:
  tool: Shell
  pattern: "rm -rf"
timeout: 5000
async: true
priority: 999
---
# My Hook
"""
        )
        props = read_properties(hook_dir)
        assert props.name == "my-hook"
        assert props.trigger == HookEventType.AFTER_TOOL
        assert props.matcher.tool == "Shell"
        assert props.matcher.pattern == "rm -rf"
        assert props.timeout == 5000
        assert props.async_ is True
        assert props.priority == 999

    def test_uses_defaults_for_optional_fields(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
---
"""
        )
        props = read_properties(hook_dir)
        assert props.matcher is None
        assert props.timeout == 30000
        assert props.async_ is False
        assert props.priority == 100

    def test_raises_if_hook_md_missing(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        with pytest.raises(ParseError, match="HOOK.md not found"):
            read_properties(hook_dir)

    def test_raises_if_name_missing(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
description: A test hook
trigger: before_tool
---
"""
        )
        with pytest.raises(ValidationError, match="Missing required field.*name"):
            read_properties(hook_dir)

    def test_raises_if_description_missing(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
trigger: before_tool
---
"""
        )
        with pytest.raises(ValidationError, match="Missing required field.*description"):
            read_properties(hook_dir)

    def test_raises_if_trigger_missing(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
---
"""
        )
        with pytest.raises(ValidationError, match="Missing required field.*trigger"):
            read_properties(hook_dir)

    def test_raises_if_invalid_trigger(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: invalid_trigger
---
"""
        )
        with pytest.raises(ValidationError, match="Invalid trigger"):
            read_properties(hook_dir)

    def test_reads_metadata_dict(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
metadata:
  author: test-user
  version: "1.0"
---
"""
        )
        props = read_properties(hook_dir)
        assert props.metadata == {"author": "test-user", "version": "1.0"}

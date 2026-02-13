"""Tests for prompt module."""

from agenthooks_ref.prompt import to_prompt


class TestToPrompt:
    def test_empty_hooks(self):
        result = to_prompt([])
        assert result == "<available_hooks>\n</available_hooks>"

    def test_single_hook(self, tmp_path):
        hook_dir = tmp_path / "security-check"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: security-check
description: Blocks dangerous commands
trigger: before_tool
---
# Security Check
"""
        )
        result = to_prompt([hook_dir])
        assert "<available_hooks>" in result
        assert "<hook>" in result
        assert "<name>" in result
        assert "security-check" in result
        assert "<description>" in result
        assert "Blocks dangerous commands" in result
        assert "<trigger>" in result
        assert "before_tool" in result
        assert "<location>" in result
        assert "</available_hooks>" in result

    def test_multiple_hooks(self, tmp_path):
        hook1 = tmp_path / "hook-one"
        hook1.mkdir()
        (hook1 / "HOOK.md").write_text(
            """---
name: hook-one
description: First hook
trigger: before_tool
---
"""
        )
        hook2 = tmp_path / "hook-two"
        hook2.mkdir()
        (hook2 / "HOOK.md").write_text(
            """---
name: hook-two
description: Second hook
trigger: after_tool
---
"""
        )
        result = to_prompt([hook1, hook2])
        assert "hook-one" in result
        assert "hook-two" in result
        assert "First hook" in result
        assert "Second hook" in result

    def test_hook_with_matcher(self, tmp_path):
        hook_dir = tmp_path / "pattern-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: pattern-hook
description: Pattern matching hook
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf"
---
"""
        )
        result = to_prompt([hook_dir])
        assert "<matcher>" in result
        assert "<tool>" in result
        assert "Shell" in result
        assert "<pattern>" in result
        assert "rm -rf" in result

    def test_escapes_html(self, tmp_path):
        hook_dir = tmp_path / "html-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: html-hook
description: "Description with <script>alert('xss')</script>"
trigger: before_tool
---
"""
        )
        result = to_prompt([hook_dir])
        assert "<script>" not in result
        assert "&lt;script&gt;" in result

    def test_resolves_absolute_paths(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: Test hook
trigger: before_tool
---
"""
        )
        result = to_prompt([hook_dir])
        # Path should be absolute
        assert str(hook_dir.resolve()) in result

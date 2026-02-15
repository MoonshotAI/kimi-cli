"""Tests for validator module."""

from agenthooks_ref.validator import validate


class TestValidate:
    def test_valid_hook(self, tmp_path):
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
        result = validate(hook_dir)
        assert result.valid is True
        assert result.errors == []

    def test_nonexistent_path(self, tmp_path):
        result = validate(tmp_path / "nonexistent")
        assert result.valid is False
        assert len(result.errors) == 1
        assert "does not exist" in result.errors[0]

    def test_not_a_directory(self, tmp_path):
        file_path = tmp_path / "file.txt"
        file_path.write_text("test")
        result = validate(file_path)
        assert result.valid is False
        assert "Not a directory" in result.errors[0]

    def test_missing_hook_md(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        result = validate(hook_dir)
        assert result.valid is False
        assert "Missing required file: HOOK.md" in result.errors

    def test_invalid_name_uppercase(self, tmp_path):
        hook_dir = tmp_path / "MyHook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: MyHook
description: A test hook
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("lowercase" in e for e in result.errors)

    def test_name_too_long(self, tmp_path):
        long_name = "a" * 70  # Exceeds 64 char limit
        hook_dir = tmp_path / long_name
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            f"""---
name: {long_name}
description: A test hook
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("exceeds" in e and "character limit" in e for e in result.errors)

    def test_name_leading_hyphen(self, tmp_path):
        hook_dir = tmp_path / "-my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: -my-hook
description: A test hook
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("cannot start or end with a hyphen" in e for e in result.errors)

    def test_name_consecutive_hyphens(self, tmp_path):
        hook_dir = tmp_path / "my--hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my--hook
description: A test hook
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("consecutive hyphens" in e for e in result.errors)

    def test_name_invalid_characters(self, tmp_path):
        hook_dir = tmp_path / "my_hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my_hook
description: A test hook
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("invalid characters" in e for e in result.errors)

    def test_name_directory_mismatch(self, tmp_path):
        hook_dir = tmp_path / "wrong-name"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: correct-name
description: A test hook
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("must match hook name" in e for e in result.errors)

    def test_unexpected_fields(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
unknown_field: should not be here
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("Unexpected fields" in e for e in result.errors)

    def test_valid_with_all_fields(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
matcher:
  tool: Shell
  pattern: "rm -rf"
timeout: 5000
async: true
priority: 999
metadata:
  author: Test
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is True

    def test_description_too_long(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        long_desc = "x" * 1100
        (hook_dir / "HOOK.md").write_text(
            f"""---
name: my-hook
description: {long_desc}
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("exceeds" in e and "1024" in e for e in result.errors)

    def test_invalid_trigger(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: invalid_trigger
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("Invalid trigger" in e for e in result.errors)

    def test_timeout_out_of_range(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
timeout: 999999
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("timeout" in e.lower() for e in result.errors)

    def test_priority_out_of_range(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
priority: 2000
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("priority" in e.lower() for e in result.errors)

    def test_invalid_matcher_regex(self, tmp_path):
        hook_dir = tmp_path / "my-hook"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: my-hook
description: A test hook
trigger: before_tool
matcher:
  tool: "[invalid("
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is False
        assert any("Invalid regex" in e for e in result.errors)

    def test_i18n_chinese_name(self, tmp_path):
        """Chinese characters are allowed in hook names."""
        hook_dir = tmp_path / "技能"
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            """---
name: 技能
description: A hook with Chinese name
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is True

    def test_nfkc_normalization(self, tmp_path):
        """Hook names are NFKC normalized before validation."""
        # Use decomposed form: 'cafe' + combining acute accent (U+0301)
        decomposed_name = "cafe\u0301"  # 'café' with combining accent
        composed_name = "café"  # precomposed form

        # Directory uses composed form, HOOK.md uses decomposed
        hook_dir = tmp_path / composed_name
        hook_dir.mkdir()
        (hook_dir / "HOOK.md").write_text(
            f"""---
name: {decomposed_name}
description: A test hook
trigger: before_tool
---
Body
"""
        )
        result = validate(hook_dir)
        assert result.valid is True, f"Expected no errors, got: {result.errors}"

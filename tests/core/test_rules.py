"""Tests for Rules system."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from kimi_cli.rules.discovery import discover_rule_files, resolve_rules_roots
from kimi_cli.rules.injector import RulesInjector
from kimi_cli.rules.models import Rule, RuleMetadata, RuleState
from kimi_cli.rules.parser import parse_frontmatter, parse_rule_file, should_apply_rule
from kimi_cli.rules.registry import RulesRegistry
from kimi_cli.rules.state import RulesStateManager


class TestParseFrontmatter:
    """Test YAML frontmatter parsing."""

    def test_parse_valid_frontmatter(self):
        """Parse frontmatter with all fields."""
        content = """---
name: "Python Style"
description: "Python coding guidelines"
paths: ["**/*.py", "**/pyproject.toml"]
priority: 10
extends: ["common/coding-style"]
---
Use type hints for function parameters.
"""
        metadata, body = parse_frontmatter(content)

        assert metadata["name"] == "Python Style"
        assert metadata["description"] == "Python coding guidelines"
        assert metadata["paths"] == ["**/*.py", "**/pyproject.toml"]
        assert metadata["priority"] == 10
        assert metadata["extends"] == ["common/coding-style"]
        assert "Use type hints" in body

    def test_parse_no_frontmatter(self):
        """Content without frontmatter returns empty metadata."""
        content = "Just plain content without frontmatter."
        metadata, body = parse_frontmatter(content)

        assert metadata == {}
        assert body == content

    def test_parse_empty_frontmatter(self):
        """Handle empty frontmatter block - returns content after frontmatter."""
        content = "---\n---\nContent here."
        metadata, body = parse_frontmatter(content)

        assert metadata == {}
        # Empty frontmatter returns body including the trailing newlines
        assert "Content here" in body

    def test_parse_invalid_yaml(self):
        """Invalid YAML in frontmatter returns empty metadata."""
        content = "---\nname: [invalid: yaml: syntax\n---\nBody content."
        metadata, body = parse_frontmatter(content)

        assert metadata == {}
        assert body == content


class TestParseRuleFile:
    """Test rule file parsing."""

    def test_parse_complete_rule(self, tmp_path: Path):
        """Parse a complete rule file."""
        rule_file = tmp_path / "python" / "coding-style.md"
        rule_file.parent.mkdir(parents=True)
        rule_file.write_text(
            """---
name: "Python Coding Style"
description: "Guidelines for Python code"
paths: ["**/*.py"]
priority: 50
---
Always use type hints.
Follow PEP 8.
""",
            encoding="utf-8",
        )

        rule = parse_rule_file(rule_file, level="project", rules_root=tmp_path)

        assert rule.id == "python/coding-style"
        assert rule.name == "Python Coding Style"
        assert rule.description == "Guidelines for Python code"
        assert rule.level == "project"
        assert rule.category == "python"
        assert rule.metadata.paths == ["**/*.py"]
        assert rule.metadata.priority == 50
        assert "Always use type hints" in rule.content

    def test_parse_rule_without_frontmatter(self, tmp_path: Path):
        """Parse rule file without frontmatter uses defaults."""
        rule_file = tmp_path / "common" / "testing.md"
        rule_file.parent.mkdir(parents=True)
        rule_file.write_text("Write unit tests for all functions.", encoding="utf-8")

        rule = parse_rule_file(rule_file, level="builtin", rules_root=tmp_path)

        assert rule.id == "common/testing"
        assert rule.name == "Testing"  # Derived from filename
        assert rule.metadata.priority == 100  # Default
        assert rule.metadata.paths == []

    def test_parse_rule_fallback_name(self, tmp_path: Path):
        """Rule without name in frontmatter uses filename as fallback."""
        rule_file = tmp_path / "my-rules" / "custom-rule.md"
        rule_file.parent.mkdir(parents=True)
        rule_file.write_text("---\ndescription: Custom\n---\nContent.", encoding="utf-8")

        rule = parse_rule_file(rule_file, level="user", rules_root=tmp_path)

        assert rule.name == "Custom Rule"  # Filename converted to title case


class TestShouldApplyRule:
    """Test rule path matching."""

    def test_rule_without_paths_applies_to_all(self):
        """Rules without paths metadata apply to all files."""
        rule = Rule(
            id="common/general",
            name="General",
            description="General rules",
            source=Path("/fake"),
            level="builtin",
            category="common",
            metadata=RuleMetadata(paths=[]),
            content="content",
        )

        assert should_apply_rule(rule, Path("/any/file.py")) is True
        assert should_apply_rule(rule, None) is True

    def test_rule_with_matching_path(self):
        """Rule applies when file matches path pattern."""
        rule = Rule(
            id="python/style",
            name="Python Style",
            description="Python rules",
            source=Path("/fake"),
            level="builtin",
            category="python",
            metadata=RuleMetadata(paths=["**/*.py", "**/pyproject.toml"]),
            content="content",
        )

        assert should_apply_rule(rule, Path("/src/main.py")) is True
        assert should_apply_rule(rule, Path("/pyproject.toml")) is True
        assert should_apply_rule(rule, Path("/src/nested/file.py")) is True

    def test_rule_with_non_matching_path(self):
        """Rule doesn't apply when file doesn't match."""
        rule = Rule(
            id="python/style",
            name="Python Style",
            description="Python rules",
            source=Path("/fake"),
            level="builtin",
            category="python",
            metadata=RuleMetadata(paths=["**/*.py"]),
            content="content",
        )

        assert should_apply_rule(rule, Path("/src/main.js")) is False
        assert should_apply_rule(rule, Path("/README.md")) is False

    def test_windows_path_separators(self):
        """Handle Windows backslash path separators."""
        rule = Rule(
            id="python/style",
            name="Python Style",
            description="Python rules",
            source=Path("/fake"),
            level="builtin",
            category="python",
            metadata=RuleMetadata(paths=["**/*.py"]),
            content="content",
        )

        assert should_apply_rule(rule, Path("\\src\\main.py")) is True


class TestRulesStateManager:
    """Test rule state persistence."""

    @pytest.fixture
    def state_manager(self, tmp_path: Path) -> RulesStateManager:
        """Create a state manager with temp directory and isolated user state."""
        from kaos.path import KaosPath
        work_dir = KaosPath.unsafe_from_local_path(tmp_path)
        # Use temp path for user state to avoid loading real user states
        user_state_path = tmp_path / "user_rules.state.toml"
        return RulesStateManager(work_dir=work_dir, user_state_path=user_state_path)

    async def test_load_nonexistent_state(self, state_manager: RulesStateManager):
        """Loading non-existent state returns empty dict."""
        await state_manager.load()

        assert state_manager.get_all_states() == {}
        assert state_manager.get_state("any-rule") is None

    async def test_save_and_load_state(self, state_manager: RulesStateManager, tmp_path: Path):
        """Save and load rule states."""
        # Create .agents directory
        from pathlib import Path
        agents_dir = Path(tmp_path / ".agents")
        agents_dir.mkdir(exist_ok=True)
        
        state = RuleState(enabled=True, pinned=True, last_modified="2024-01-01T00:00:00")
        state_manager.set_state("python/style", state)
        await state_manager.save()

        # Create new manager instance to test loading (reuse same user_state_path)
        from kaos.path import KaosPath
        new_manager = RulesStateManager(
            work_dir=KaosPath.unsafe_from_local_path(tmp_path),
            user_state_path=state_manager.user_state_path
        )
        await new_manager.load()

        loaded = new_manager.get_state("python/style")
        assert loaded is not None
        assert loaded.enabled is True
        assert loaded.pinned is True
        assert loaded.last_modified == "2024-01-01T00:00:00"

    async def test_clear_states(self, state_manager: RulesStateManager):
        """Clear all states or filter by level."""
        state_manager.set_state("common/style", RuleState())
        state_manager.set_state("python/style", RuleState())
        await state_manager.save()

        # Clear all
        state_manager.clear_states()

        assert state_manager.get_state("common/style") is None
        assert state_manager.get_state("python/style") is None

    async def test_level_separation(self, state_manager: RulesStateManager, tmp_path: Path):
        """States are saved to separate files based on rule level."""
        from pathlib import Path
        
        # Create .agents directory for project-level state
        agents_dir = Path(tmp_path / ".agents")
        agents_dir.mkdir(exist_ok=True)

        # Set states with different levels
        builtin_state = RuleState(enabled=True, pinned=True)
        user_state = RuleState(enabled=True, pinned=False)
        project_state = RuleState(enabled=False, pinned=True)

        state_manager.set_state("builtin/rule", builtin_state, level="builtin")
        state_manager.set_state("user/custom", user_state, level="user")
        state_manager.set_state("project/local", project_state, level="project")

        await state_manager.save()

        # Verify user-level file contains builtin and user rules
        assert state_manager.user_state_path.exists()
        user_content = state_manager.user_state_path.read_text()
        assert "builtin/rule" in user_content
        assert "user/custom" in user_content
        assert "project/local" not in user_content  # Project rule not in user file

        # Verify project-level file contains only project rules
        project_path = tmp_path / ".agents" / "rules.state.toml"
        assert project_path.exists()
        project_content = project_path.read_text()
        assert "project/local" in project_content
        assert "builtin/rule" not in project_content  # Builtin rule not in project file
        assert "user/custom" not in project_content  # User rule not in project file

    async def test_project_state_priority(self, state_manager: RulesStateManager, tmp_path: Path):
        """Project-level states take precedence over user-level states."""
        from pathlib import Path
        
        # Create .agents directory
        agents_dir = Path(tmp_path / ".agents")
        agents_dir.mkdir(exist_ok=True)

        # Set same rule in both levels (user disabled, project enabled)
        state_manager.set_state("shared/rule", RuleState(enabled=False), level="user")
        state_manager.set_state("shared/rule", RuleState(enabled=True), level="project")

        # Project-level should take precedence
        loaded_state = state_manager.get_state("shared/rule")
        assert loaded_state is not None
        assert loaded_state.enabled is True  # Project level wins

        # After clearing project states, should fall back to user state
        state_manager.clear_states(level="project")
        loaded_state = state_manager.get_state("shared/rule")
        assert loaded_state is not None
        assert loaded_state.enabled is False  # Falls back to user level (disabled)

    async def test_empty_states_delete_files(self, state_manager: RulesStateManager, tmp_path: Path):
        """Empty states should delete state files, not leave stale data."""
        from pathlib import Path
        
        # Create .agents directory for project-level state
        agents_dir = Path(tmp_path / ".agents")
        agents_dir.mkdir(exist_ok=True)

        # Set some states and save
        state_manager.set_state("user/rule", RuleState(enabled=False), level="user")
        state_manager.set_state("project/rule", RuleState(enabled=True), level="project")
        await state_manager.save()

        # Verify files exist
        assert state_manager.user_state_path.exists()
        assert (tmp_path / ".agents" / "rules.state.toml").exists()

        # Clear all states and save again
        state_manager.clear_states()
        await state_manager.save()

        # Files should be deleted (no empty states to persist)
        assert not state_manager.user_state_path.exists()
        assert not (tmp_path / ".agents" / "rules.state.toml").exists()

    async def test_delete_state_files(self, state_manager: RulesStateManager, tmp_path: Path):
        """delete_state_files should remove state files from disk."""
        from pathlib import Path
        
        # Create .agents directory
        agents_dir = Path(tmp_path / ".agents")
        agents_dir.mkdir(exist_ok=True)

        # Set states and save
        state_manager.set_state("user/rule", RuleState(), level="user")
        state_manager.set_state("project/rule", RuleState(), level="project")
        await state_manager.save()

        # Verify files exist
        assert state_manager.user_state_path.exists()
        assert (tmp_path / ".agents" / "rules.state.toml").exists()

        # Delete only user state file
        await state_manager.delete_state_files(level="user")
        assert not state_manager.user_state_path.exists()
        assert (tmp_path / ".agents" / "rules.state.toml").exists()

        # Delete all state files
        await state_manager.delete_state_files()
        assert not (tmp_path / ".agents" / "rules.state.toml").exists()

class TestRulesRegistry:
    """Test rules registry."""

    @pytest.fixture
    async def registry(self, tmp_path: Path) -> RulesRegistry:
        """Create a registry with mocked dependencies."""
        from kaos.path import KaosPath

        work_dir = KaosPath.unsafe_from_local_path(tmp_path)
        registry = RulesRegistry(work_dir)
        return registry

    def test_get_rule_not_found(self, registry: RulesRegistry):
        """Get non-existent rule returns None."""
        assert registry.get_rule("nonexistent") is None

    def test_toggle_nonexistent_rule(self, registry: RulesRegistry):
        """Toggle non-existent rule returns False."""
        assert registry.toggle("nonexistent", enabled=False) is False

    def test_is_enabled_default(self, registry: RulesRegistry):
        """Rules are enabled by default when no state exists."""
        # Manually add a rule
        rule = Rule(
            id="test/rule",
            name="Test Rule",
            description="Test",
            source=Path("/fake"),
            level="builtin",
            category="test",
            metadata=RuleMetadata(),
            content="content",
        )
        registry._rules["test/rule"] = rule

        assert registry.is_enabled("test/rule") is True

    def test_get_active_rules(self, registry: RulesRegistry):
        """Get active rules with filtering."""
        # Add rules
        rule1 = Rule(
            id="common/style",
            name="Common Style",
            description="Common",
            source=Path("/fake"),
            level="builtin",
            category="common",
            metadata=RuleMetadata(paths=[], priority=10),
            content="content",
        )
        rule2 = Rule(
            id="python/style",
            name="Python Style",
            description="Python",
            source=Path("/fake"),
            level="builtin",
            category="python",
            metadata=RuleMetadata(paths=["**/*.py"], priority=20),
            content="content",
        )
        registry._rules["common/style"] = rule1
        registry._rules["python/style"] = rule2

        # Disable one rule
        registry._state["common/style"] = RuleState(enabled=False)

        # Get all active
        active = registry.get_active_rules()
        assert len(active) == 1
        assert active[0].id == "python/style"

        # Get active for specific file
        active_py = registry.get_active_rules(file_path=Path("/src/main.py"))
        assert len(active_py) == 1
        assert active_py[0].id == "python/style"

        # Get active for non-matching file
        active_js = registry.get_active_rules(file_path=Path("/src/main.js"))
        assert len(active_js) == 0

    def test_toggle_persists_state(self, registry: RulesRegistry):
        """Toggle updates state and marks as pinned."""
        rule = Rule(
            id="test/rule",
            name="Test Rule",
            description="Test",
            source=Path("/fake"),
            level="builtin",
            category="test",
            metadata=RuleMetadata(),
            content="content",
        )
        registry._rules["test/rule"] = rule

        # Mock state manager
        registry.state_manager = MagicMock()
        registry.state_manager.set_state = MagicMock()

        # Disable rule
        result = registry.toggle("test/rule", enabled=False)

        assert result is True
        assert registry.is_enabled("test/rule") is False

        # Check state was pinned
        state = registry._state["test/rule"]
        assert state.pinned is True
        assert state.last_modified is not None

        # Check persistence was called with level info
        registry.state_manager.set_state.assert_called_once_with("test/rule", state, level="builtin")

    def test_get_stats(self, registry: RulesRegistry):
        """Get statistics about rules."""
        # Add rules of different levels
        for level, count in [("builtin", 3), ("user", 2), ("project", 1)]:
            for i in range(count):
                rule = Rule(
                    id=f"{level}/rule{i}",
                    name=f"Rule {i}",
                    description="Test",
                    source=Path("/fake"),
                    level=level,
                    category="test",
                    metadata=RuleMetadata(),
                    content="content",
                )
                registry._rules[f"{level}/rule{i}"] = rule

        # Disable some rules
        registry._state["builtin/rule0"] = RuleState(enabled=False)
        registry._state["user/rule0"] = RuleState(enabled=False)

        stats = registry.get_stats()

        assert stats.total == 6
        assert stats.enabled == 4
        assert stats.builtin == 3
        assert stats.user == 2
        assert stats.project == 1

    def test_get_rules_by_level_and_category(self, registry: RulesRegistry):
        """Filter rules by level and category."""
        for id_, level, category in [
            ("common/style", "builtin", "common"),
            ("common/testing", "builtin", "common"),
            ("python/style", "builtin", "python"),
            ("custom/rule", "project", "custom"),
        ]:
            rule = Rule(
                id=id_,
                name=id_,
                description="Test",
                source=Path("/fake"),
                level=level,
                category=category,
                metadata=RuleMetadata(),
                content="content",
            )
            registry._rules[id_] = rule

        builtin = registry.get_rules_by_level("builtin")
        assert len(builtin) == 3

        common = registry.get_rules_by_category("common")
        assert len(common) == 2


class TestRulesInjector:
    """Test rules prompt injection."""

    def test_format_rules_for_prompt(self):
        """Format rules for system prompt."""
        rules = [
            Rule(
                id="common/style",
                name="Common Style",
                description="Common coding style",
                source=Path("/fake"),
                level="builtin",
                category="common",
                metadata=RuleMetadata(priority=10),
                content="Use clear names.",
            ),
            Rule(
                id="python/style",
                name="Python Style",
                description="Python specific",
                source=Path("/fake"),
                level="builtin",
                category="python",
                metadata=RuleMetadata(priority=20),
                content="Use type hints.",
            ),
        ]

        injector = RulesInjector(work_dir=None)  # type: ignore
        formatted = injector.format_rules_content(rules)

        # Verify rule content is formatted correctly
        assert "## Common Style" in formatted
        assert "Use clear names." in formatted
        assert "## Python Style" in formatted
        assert "Use type hints." in formatted

    def test_format_rules_respects_size_limit(self):
        """Respect max size limit when formatting rules."""
        # Create a rule with very long content
        long_content = "x" * 50000
        rules = [
            Rule(
                id="common/style",
                name="Common Style",
                description="Test",
                source=Path("/fake"),
                level="builtin",
                category="common",
                metadata=RuleMetadata(),
                content=long_content,
            ),
        ]

        injector = RulesInjector(work_dir=None, max_size=1000)  # type: ignore
        formatted = injector.format_rules_content(rules)

        assert len(formatted) <= 1100  # Allow some margin for header/trailer
        assert "truncated" in formatted or len(formatted) < len(long_content)

    def test_format_empty_rules(self):
        """Format empty rules list."""
        injector = RulesInjector(work_dir=None)  # type: ignore
        formatted = injector.format_rules_content([])
        assert formatted == ""


class TestDiscovery:
    """Test rule discovery."""

    async def test_discover_rule_files(self, tmp_path: Path):
        """Discover rule files in directory."""
        from kaos.path import KaosPath

        # Create rule files
        (tmp_path / "common").mkdir()
        (tmp_path / "common" / "style.md").write_text("content")
        (tmp_path / "python").mkdir()
        (tmp_path / "python" / "coding.md").write_text("content")
        (tmp_path / "python" / "not-a-rule.txt").write_text("content")

        root = KaosPath.unsafe_from_local_path(tmp_path)
        files = await discover_rule_files(root)

        assert len(files) == 2
        names = {f.name for f in files}
        assert names == {"style.md", "coding.md"}

    async def test_discover_empty_directory(self, tmp_path: Path):
        """Discover in empty directory returns empty list."""
        from kaos.path import KaosPath

        root = KaosPath.unsafe_from_local_path(tmp_path)
        files = await discover_rule_files(root)

        assert files == []

    async def test_resolve_rules_roots(self, tmp_path: Path):
        """Resolve all rules directories with project rules present."""
        from kaos.path import KaosPath

        # Create project rules directory
        (tmp_path / ".agents" / "rules").mkdir(parents=True)

        work_dir = KaosPath.unsafe_from_local_path(tmp_path)
        roots = await resolve_rules_roots(work_dir, include_builtin=True)

        # Should include project and builtin (user may or may not exist)
        assert len(roots) >= 2  # At least project and builtin

    async def test_resolve_rules_roots_without_builtin(self, tmp_path: Path):
        """Resolve rules roots excluding builtin."""
        from kaos.path import KaosPath

        work_dir = KaosPath.unsafe_from_local_path(tmp_path)
        roots = await resolve_rules_roots(work_dir, include_builtin=False)

        # Should not include builtin rules
        builtin_dir = str(Path(__file__).parent.parent.parent / "src" / "kimi_cli" / "rules")
        root_strs = [str(r) for r in roots]
        assert builtin_dir not in root_strs

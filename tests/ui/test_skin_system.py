"""Tests for the custom YAML skin system (theme.py)."""

from __future__ import annotations

import textwrap
from pathlib import Path
from unittest.mock import patch

import pytest

import kimi_cli.ui.theme as theme_mod
from kimi_cli.ui.theme import (
    Skin,
    SkinBranding,
    SkinColors,
    _BUILTIN_SKINS,
    _DARK_COLORS,
    _load_yaml_skin,
    get_active_skin,
    get_active_skin_name,
    get_active_theme,
    get_diff_colors,
    get_mcp_prompt_colors,
    get_prompt_style,
    get_skin_branding,
    get_task_browser_style,
    get_toolbar_colors,
    list_skins,
    set_active_skin,
    set_active_theme,
)


@pytest.fixture(autouse=True)
def _reset_active_skin():
    """Restore module-level skin state after each test."""
    original_name = theme_mod._active_skin_name
    original_custom = dict(theme_mod._custom_skins)
    yield
    theme_mod._active_skin_name = original_name
    theme_mod._custom_skins = original_custom


class TestSkinDataclasses:
    """SkinColors, SkinBranding, and Skin are frozen dataclasses."""

    def test_skin_colors_defaults_are_hex_strings(self) -> None:
        colors = SkinColors()
        assert colors.diff_add_bg.startswith("#")
        assert colors.diff_del_bg.startswith("#")
        assert colors.mcp_connected.startswith("#")

    def test_skin_colors_frozen(self) -> None:
        colors = SkinColors()
        with pytest.raises((AttributeError, TypeError)):
            colors.diff_add_bg = "#000000"  # type: ignore[misc]

    def test_skin_branding_defaults_empty(self) -> None:
        branding = SkinBranding()
        assert branding.welcome == ""
        assert branding.goodbye == ""
        assert branding.prompt_symbol == ""

    def test_skin_frozen(self) -> None:
        skin = Skin(name="test")
        with pytest.raises((AttributeError, TypeError)):
            skin.name = "other"  # type: ignore[misc]

    def test_skin_default_factory_fields(self) -> None:
        s1 = Skin(name="a")
        s2 = Skin(name="b")
        assert s1.colors is not s2.colors

    def test_skin_custom_colors(self) -> None:
        custom = SkinColors(diff_add_bg="#aabbcc")
        skin = Skin(name="custom", colors=custom)
        assert skin.colors.diff_add_bg == "#aabbcc"
        assert skin.colors.diff_del_bg == _DARK_COLORS.diff_del_bg


class TestBuiltinSkins:
    """dark and light built-in skins are always available."""

    def test_both_builtins_present(self) -> None:
        assert "dark" in _BUILTIN_SKINS
        assert "light" in _BUILTIN_SKINS

    def test_dark_skin_name(self) -> None:
        assert _BUILTIN_SKINS["dark"].name == "dark"

    def test_light_skin_name(self) -> None:
        assert _BUILTIN_SKINS["light"].name == "light"

    def test_dark_and_light_colors_differ(self) -> None:
        dark = _BUILTIN_SKINS["dark"].colors
        light = _BUILTIN_SKINS["light"].colors
        assert dark.diff_add_bg != light.diff_add_bg
        assert dark.tb_header_bg != light.tb_header_bg


class TestLoadYamlSkin:
    """_load_yaml_skin() parses Hermes-compatible YAML files."""

    def test_valid_full_yaml(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "ocean.yaml"
        yaml_file.write_text(
            textwrap.dedent("""\
                name: ocean
                description: Ocean blue theme
                colors:
                  diff_add_bg: "#0a2a1a"
                  diff_add_hl: "#1a5a3e"
                branding:
                  welcome: "Welcome"
                  goodbye: "Goodbye"
                  prompt_symbol: "~"
                font:
                  primary: "Fira Code"
            """),
            encoding="utf-8",
        )
        skin = _load_yaml_skin(yaml_file)
        assert skin is not None
        assert skin.name == "ocean"
        assert skin.description == "Ocean blue theme"
        assert skin.colors.diff_add_bg == "#0a2a1a"
        assert skin.colors.diff_add_hl == "#1a5a3e"
        assert skin.branding.welcome == "Welcome"
        assert skin.branding.prompt_symbol == "~"
        assert skin.font_hint == "Fira Code"

    def test_partial_yaml_falls_back_to_dark_defaults(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "minimal.yaml"
        yaml_file.write_text(
            textwrap.dedent("""\
                name: minimal
                colors:
                  diff_add_bg: "#001100"
            """),
            encoding="utf-8",
        )
        skin = _load_yaml_skin(yaml_file)
        assert skin is not None
        assert skin.colors.diff_add_bg == "#001100"
        assert skin.colors.diff_del_bg == _DARK_COLORS.diff_del_bg
        assert skin.colors.mcp_connected == _DARK_COLORS.mcp_connected

    def test_name_falls_back_to_file_stem(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "myskin.yaml"
        yaml_file.write_text("colors:\n  diff_add_bg: '#112233'\n", encoding="utf-8")
        skin = _load_yaml_skin(yaml_file)
        assert skin is not None
        assert skin.name == "myskin"

    def test_branding_defaults_to_empty_strings(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "no_branding.yaml"
        yaml_file.write_text("name: nobrand\n", encoding="utf-8")
        skin = _load_yaml_skin(yaml_file)
        assert skin is not None
        assert skin.branding.welcome == ""
        assert skin.branding.goodbye == ""
        assert skin.branding.prompt_symbol == ""

    def test_font_hint_empty_when_absent(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "nofont.yaml"
        yaml_file.write_text("name: nofont\n", encoding="utf-8")
        skin = _load_yaml_skin(yaml_file)
        assert skin is not None
        assert skin.font_hint == ""

    def test_empty_file_returns_none(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "empty.yaml"
        yaml_file.write_text("", encoding="utf-8")
        assert _load_yaml_skin(yaml_file) is None

    def test_non_dict_yaml_returns_none(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "list.yaml"
        yaml_file.write_text("- item1\n- item2\n", encoding="utf-8")
        assert _load_yaml_skin(yaml_file) is None

    def test_malformed_yaml_returns_none(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "bad.yaml"
        yaml_file.write_text("name: [unclosed\n", encoding="utf-8")
        assert _load_yaml_skin(yaml_file) is None

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "nonexistent.yaml"
        assert _load_yaml_skin(yaml_file) is None

    def test_all_color_fields_overridable(self, tmp_path: Path) -> None:
        yaml_file = tmp_path / "full.yaml"
        colors = {
            "diff_add_bg": "#aaa001",
            "diff_add_hl": "#aaa002",
            "diff_del_bg": "#aaa003",
            "diff_del_hl": "#aaa004",
            "tb_header_bg": "#aaa005",
            "tb_header_fg": "#aaa006",
            "mcp_text": "#aaa007",
            "mcp_connected": "#aaa008",
            "mcp_failed": "#aaa009",
            "toolbar_yolo": "#aaa010",
            "prompt_placeholder": "#aaa011",
        }
        color_lines = "\n".join(f"  {k}: '{v}'" for k, v in colors.items())
        yaml_file.write_text(f"name: full\ncolors:\n{color_lines}\n", encoding="utf-8")
        skin = _load_yaml_skin(yaml_file)
        assert skin is not None
        for field, value in colors.items():
            assert getattr(skin.colors, field) == value, f"{field} not set correctly"


class TestDiscoverCustomSkins:
    """_discover_custom_skins() finds skins in ~/.kimi/skins/."""

    def test_no_skins_dir_returns_empty(self, tmp_path: Path) -> None:
        with patch.object(Path, "home", return_value=tmp_path):
            from kimi_cli.ui.theme import _discover_custom_skins
            result = _discover_custom_skins()
        assert result == {}

    def test_empty_skins_dir_returns_empty(self, tmp_path: Path) -> None:
        skins_dir = tmp_path / ".kimi" / "skins"
        skins_dir.mkdir(parents=True)
        with patch.object(Path, "home", return_value=tmp_path):
            from kimi_cli.ui.theme import _discover_custom_skins
            result = _discover_custom_skins()
        assert result == {}

    def test_valid_yaml_is_discovered(self, tmp_path: Path) -> None:
        skins_dir = tmp_path / ".kimi" / "skins"
        skins_dir.mkdir(parents=True)
        (skins_dir / "dracula.yaml").write_text(
            "name: dracula\ndescription: Dracula theme\n", encoding="utf-8"
        )
        with patch.object(Path, "home", return_value=tmp_path):
            from kimi_cli.ui.theme import _discover_custom_skins
            result = _discover_custom_skins()
        assert "dracula" in result
        assert result["dracula"].description == "Dracula theme"

    def test_invalid_yaml_is_skipped(self, tmp_path: Path) -> None:
        skins_dir = tmp_path / ".kimi" / "skins"
        skins_dir.mkdir(parents=True)
        (skins_dir / "broken.yaml").write_text("- bad\n", encoding="utf-8")
        (skins_dir / "good.yaml").write_text("name: good\n", encoding="utf-8")
        with patch.object(Path, "home", return_value=tmp_path):
            from kimi_cli.ui.theme import _discover_custom_skins
            result = _discover_custom_skins()
        assert "broken" not in result
        assert "good" in result

    def test_multiple_skins_discovered(self, tmp_path: Path) -> None:
        skins_dir = tmp_path / ".kimi" / "skins"
        skins_dir.mkdir(parents=True)
        for name in ("alpha", "beta", "gamma"):
            (skins_dir / f"{name}.yaml").write_text(f"name: {name}\n", encoding="utf-8")
        with patch.object(Path, "home", return_value=tmp_path):
            from kimi_cli.ui.theme import _discover_custom_skins
            result = _discover_custom_skins()
        assert {"alpha", "beta", "gamma"} == set(result.keys())


class TestActiveSkinAPI:
    """set_active_skin / get_active_skin / list_skins public API."""

    def test_default_skin_is_dark(self) -> None:
        theme_mod._active_skin_name = "dark"
        assert get_active_skin_name() == "dark"

    def test_set_active_skin_builtin_returns_true(self) -> None:
        assert set_active_skin("light") is True
        assert get_active_skin_name() == "light"

    def test_set_active_skin_unknown_returns_false(self) -> None:
        assert set_active_skin("nonexistent_skin_xyz") is False
        assert get_active_skin_name() == "dark"

    def test_get_active_skin_returns_skin_object(self) -> None:
        set_active_skin("light")
        skin = get_active_skin()
        assert isinstance(skin, Skin)
        assert skin.name == "light"

    def test_get_active_skin_dark(self) -> None:
        set_active_skin("dark")
        skin = get_active_skin()
        assert skin.name == "dark"

    def test_list_skins_includes_builtins(self) -> None:
        names = [name for name, _ in list_skins()]
        assert "dark" in names
        assert "light" in names

    def test_list_skins_returns_descriptions(self) -> None:
        skins = dict(list_skins())
        assert skins["dark"] != ""
        assert skins["light"] != ""

    def test_custom_skin_activatable(self, tmp_path: Path) -> None:
        skins_dir = tmp_path / ".kimi" / "skins"
        skins_dir.mkdir(parents=True)
        (skins_dir / "retro.yaml").write_text("name: retro\n", encoding="utf-8")
        with patch.object(Path, "home", return_value=tmp_path):
            result = set_active_skin("retro")
        assert result is True

    def test_get_skin_branding_empty_for_builtins(self) -> None:
        set_active_skin("dark")
        branding = get_skin_branding()
        assert branding.welcome == ""
        assert branding.prompt_symbol == ""

    def test_get_skin_branding_custom(self, tmp_path: Path) -> None:
        skins_dir = tmp_path / ".kimi" / "skins"
        skins_dir.mkdir(parents=True)
        (skins_dir / "branded.yaml").write_text(
            "name: branded\nbranding:\n  welcome: Hello\n  prompt_symbol: '>'\n",
            encoding="utf-8",
        )
        with patch.object(Path, "home", return_value=tmp_path):
            set_active_skin("branded")
            branding = get_skin_branding()
        assert branding.welcome == "Hello"
        assert branding.prompt_symbol == ">"


class TestBackwardsCompatibility:
    """Legacy set_active_theme / get_active_theme still work."""

    def test_set_active_theme_dark(self) -> None:
        set_active_theme("dark")
        assert get_active_theme() == "dark"

    def test_set_active_theme_light(self) -> None:
        set_active_theme("light")
        assert get_active_theme() == "light"

    def test_custom_skin_get_active_theme_returns_dark_fallback(self) -> None:
        theme_mod._active_skin_name = "some_custom_skin"
        assert get_active_theme() == "dark"

    def test_set_active_skin_dark_theme_readable(self) -> None:
        set_active_skin("dark")
        assert get_active_theme() == "dark"

    def test_set_active_skin_light_theme_readable(self) -> None:
        set_active_skin("light")
        assert get_active_theme() == "light"


class TestColorResolvers:
    """Color resolver functions return correctly typed objects for active skin."""

    def test_get_diff_colors_returns_rich_styles(self) -> None:
        from rich.style import Style as RichStyle

        set_active_skin("dark")
        diff = get_diff_colors()
        assert isinstance(diff.add_bg, RichStyle)
        assert isinstance(diff.del_bg, RichStyle)
        assert isinstance(diff.add_hl, RichStyle)
        assert isinstance(diff.del_hl, RichStyle)

    def test_get_diff_colors_light_differs_from_dark(self) -> None:
        set_active_skin("dark")
        dark_diff = get_diff_colors()
        set_active_skin("light")
        light_diff = get_diff_colors()
        assert dark_diff.add_bg != light_diff.add_bg

    def test_get_task_browser_style_returns_ptk_style(self) -> None:
        from prompt_toolkit.styles import Style as PTKStyle

        style = get_task_browser_style()
        assert isinstance(style, PTKStyle)

    def test_get_task_browser_style_has_header_key(self) -> None:
        style = get_task_browser_style()
        style_dict = dict(style.style_rules)
        assert any("header" in rule for rule in style_dict)

    def test_get_prompt_style_returns_ptk_style(self) -> None:
        from prompt_toolkit.styles import Style as PTKStyle

        style = get_prompt_style()
        assert isinstance(style, PTKStyle)

    def test_get_toolbar_colors_contains_skin_colors(self) -> None:
        set_active_skin("dark")
        dark_colors = get_toolbar_colors()
        set_active_skin("light")
        light_colors = get_toolbar_colors()
        assert dark_colors.yolo_label != light_colors.yolo_label

    def test_get_toolbar_colors_format(self) -> None:
        tc = get_toolbar_colors()
        assert "fg:" in tc.separator or "bg:" in tc.separator or "#" in tc.separator
        assert "fg:" in tc.yolo_label or "bold" in tc.yolo_label

    def test_get_mcp_prompt_colors_returns_dataclass(self) -> None:
        from kimi_cli.ui.theme import MCPPromptColors

        mcp = get_mcp_prompt_colors()
        assert isinstance(mcp, MCPPromptColors)
        assert mcp.connected.startswith("fg:")
        assert mcp.failed.startswith("fg:")

    def test_get_mcp_prompt_colors_light_differs_from_dark(self) -> None:
        set_active_skin("dark")
        dark_mcp = get_mcp_prompt_colors()
        set_active_skin("light")
        light_mcp = get_mcp_prompt_colors()
        assert dark_mcp.connected != light_mcp.connected

    def test_resolvers_reflect_custom_skin(self, tmp_path: Path) -> None:
        skins_dir = tmp_path / ".kimi" / "skins"
        skins_dir.mkdir(parents=True)
        (skins_dir / "mono.yaml").write_text(
            "name: mono\ncolors:\n  mcp_connected: '#ffffff'\n", encoding="utf-8"
        )
        with patch.object(Path, "home", return_value=tmp_path):
            set_active_skin("mono")
            mcp = get_mcp_prompt_colors()
        assert "#ffffff" in mcp.connected

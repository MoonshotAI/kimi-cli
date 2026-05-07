from pathlib import Path

from scripts.pyinstaller_version_info import (
    parse_fixed_file_version,
    render_version_info,
    write_version_info,
)


def test_parse_fixed_file_version_pads_to_four_parts() -> None:
    assert parse_fixed_file_version("1.41.0") == (1, 41, 0, 0)
    assert parse_fixed_file_version("2.3.4.5") == (2, 3, 4, 5)


def test_render_version_info_uses_project_version() -> None:
    text = render_version_info("1.41.0")

    assert "filevers=(1, 41, 0, 0)" in text
    assert 'StringStruct("FileVersion", "1.41.0")' in text
    assert 'StringStruct("ProductVersion", "1.41.0")' in text
    assert 'StringStruct("FileDescription", "Kimi Code CLI")' in text


def test_write_version_info_reads_pyproject(tmp_path: Path) -> None:
    pyproject = tmp_path / "pyproject.toml"
    output = tmp_path / "dist" / "kimi_version_info.txt"
    pyproject.write_text('[project]\nname = "kimi-cli"\nversion = "1.42.0"\n', encoding="utf-8")

    assert write_version_info(pyproject, output) == output
    assert 'StringStruct("ProductVersion", "1.42.0")' in output.read_text(encoding="utf-8")

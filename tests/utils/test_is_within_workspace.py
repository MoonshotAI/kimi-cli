"""Tests for is_within_workspace and is_within_directory utility functions."""

from __future__ import annotations

from pathlib import PurePosixPath, PureWindowsPath

from kaos.path import KaosPath

from kimi_cli.utils.path import is_within_directory, is_within_workspace


def test_within_work_dir():
    """Path inside work_dir should be accepted."""
    work_dir = KaosPath("/home/user/project")
    assert is_within_workspace(KaosPath("/home/user/project/src/main.py"), work_dir)


def test_work_dir_itself():
    """Work dir itself should be accepted."""
    work_dir = KaosPath("/home/user/project")
    assert is_within_workspace(work_dir, work_dir)


def test_outside_work_dir_no_additional():
    """Path outside work_dir with no additional dirs should be rejected."""
    work_dir = KaosPath("/home/user/project")
    assert not is_within_workspace(KaosPath("/home/user/other/file.py"), work_dir)


def test_within_additional_dir():
    """Path inside an additional dir should be accepted."""
    work_dir = KaosPath("/home/user/project")
    additional = [KaosPath("/home/user/lib")]
    assert is_within_workspace(KaosPath("/home/user/lib/module.py"), work_dir, additional)


def test_additional_dir_itself():
    """The additional dir path itself should be accepted."""
    work_dir = KaosPath("/home/user/project")
    additional = [KaosPath("/home/user/lib")]
    assert is_within_workspace(KaosPath("/home/user/lib"), work_dir, additional)


def test_outside_all_dirs():
    """Path outside both work_dir and additional dirs should be rejected."""
    work_dir = KaosPath("/home/user/project")
    additional = [KaosPath("/home/user/lib")]
    assert not is_within_workspace(KaosPath("/tmp/evil"), work_dir, additional)


def test_multiple_additional_dirs():
    """Path within any of multiple additional dirs should be accepted."""
    work_dir = KaosPath("/home/user/project")
    additional = [KaosPath("/home/user/lib"), KaosPath("/opt/shared")]
    assert is_within_workspace(KaosPath("/opt/shared/config.json"), work_dir, additional)


def test_prefix_attack_work_dir():
    """Path sharing prefix but not actually inside work_dir should be rejected."""
    work_dir = KaosPath("/home/user/project")
    assert not is_within_workspace(KaosPath("/home/user/project-evil/hack.py"), work_dir)


def test_prefix_attack_additional_dir():
    """Path sharing prefix but not actually inside additional dir should be rejected."""
    work_dir = KaosPath("/home/user/project")
    additional = [KaosPath("/home/user/lib")]
    assert not is_within_workspace(KaosPath("/home/user/lib-evil/hack.py"), work_dir, additional)


def test_empty_additional_dirs():
    """Empty additional_dirs sequence should not cause errors."""
    work_dir = KaosPath("/home/user/project")
    assert is_within_workspace(KaosPath("/home/user/project/a.py"), work_dir, [])
    assert not is_within_workspace(KaosPath("/tmp/x"), work_dir, [])


def test_default_additional_dirs():
    """Default parameter (no additional_dirs) should work."""
    work_dir = KaosPath("/home/user/project")
    assert is_within_workspace(KaosPath("/home/user/project/a.py"), work_dir)
    assert not is_within_workspace(KaosPath("/tmp/x"), work_dir)


# ── Cross-platform path tests ──────────────────────────────────────────────
#
# is_within_directory uses PurePath(str(path)).relative_to(...), which delegates
# to the platform's PurePath implementation. These tests verify the underlying
# logic works with both POSIX and Windows-style paths by testing PurePath
# directly, ensuring no hardcoded "/" comparisons sneak in.


def test_purepath_relative_to_posix():
    """PurePosixPath.relative_to correctly detects containment."""
    base = PurePosixPath("/home/user/project")
    assert PurePosixPath("/home/user/project/src/main.py").is_relative_to(base)
    assert not PurePosixPath("/home/user/project-evil/hack.py").is_relative_to(base)
    assert not PurePosixPath("/tmp/other").is_relative_to(base)


def test_purepath_relative_to_windows():
    """PureWindowsPath.relative_to correctly detects containment with backslashes."""
    base = PureWindowsPath("C:\\Users\\user\\project")
    child = PureWindowsPath("C:\\Users\\user\\project\\src\\main.py")
    assert child.is_relative_to(base)

    sneaky = PureWindowsPath("C:\\Users\\user\\project-evil\\hack.py")
    assert not sneaky.is_relative_to(base)

    outside = PureWindowsPath("D:\\other")
    assert not outside.is_relative_to(base)


def test_purepath_windows_forward_slash_normalized():
    """PureWindowsPath treats forward slashes the same as backslashes."""
    base = PureWindowsPath("C:/Users/user/project")
    child = PureWindowsPath("C:/Users/user/project/src/main.py")
    assert child.is_relative_to(base)


def test_is_within_directory_prefix_attack():
    """is_within_directory must not be fooled by shared path prefixes."""
    # This is the exact bug that a naive startswith("/" + ...) check would miss
    assert not is_within_directory(
        KaosPath("/home/user/project-evil"), KaosPath("/home/user/project")
    )
    assert is_within_directory(KaosPath("/home/user/project/sub"), KaosPath("/home/user/project"))


def test_is_within_directory_self():
    """A directory is considered within itself."""
    d = KaosPath("/home/user/project")
    assert is_within_directory(d, d)


def test_is_within_workspace_uses_relative_to_not_string_ops():
    """Verify workspace check is immune to string-prefix false positives."""
    work_dir = KaosPath("/app")
    additional = [KaosPath("/app-data")]

    # /app-data is an additional dir, so paths inside it should pass
    assert is_within_workspace(KaosPath("/app-data/file.txt"), work_dir, additional)

    # /app-data-evil shares prefix with /app-data but is not inside it
    assert not is_within_workspace(KaosPath("/app-data-evil/file.txt"), work_dir, additional)

"""Tests for is_within_workspace utility function."""

from __future__ import annotations

from kaos.path import KaosPath

from kimi_cli.utils.path import is_within_workspace


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

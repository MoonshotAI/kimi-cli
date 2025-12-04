from __future__ import annotations

import sys
import types

import pytest

from kimi_cli.soul.agent import _load_tool
from kimi_cli.soul.injector import Injector, ToolDependencyError, ToolLoadError


def _install_fake_module(
    name: str, cls_name: str, cls_obj: type, *, extra_classes: list[type] | None = None
) -> None:
    module = types.ModuleType(name)
    setattr(module, cls_name, cls_obj)
    for cls in extra_classes or []:
        setattr(module, cls.__name__, cls)
    sys.modules[name] = module


def test_load_tool_success_injects_dependency():
    class Dep:
        pass

    class GoodTool:
        def __init__(self, dep: Dep):
            self.dep = dep

    module_name = "tests.fake_tool_module_success"
    cls_name = "GoodTool"
    _install_fake_module(module_name, cls_name, GoodTool, extra_classes=[Dep])

    dep_instance = Dep()
    injector = Injector({Dep: dep_instance})

    tool = _load_tool(f"{module_name}:{cls_name}", injector)

    assert isinstance(tool, GoodTool)
    assert tool.dep is dep_instance

    sys.modules.pop(module_name, None)


def test_load_tool_missing_dependency_raises():
    class Dep:
        pass

    class NeedsDep:
        def __init__(self, dep: Dep):
            self.dep = dep

    module_name = "tests.fake_tool_module_missing_dep"
    cls_name = "NeedsDep"
    _install_fake_module(module_name, cls_name, NeedsDep, extra_classes=[Dep])

    injector = Injector({})

    with pytest.raises(ToolDependencyError):
        _load_tool(f"{module_name}:{cls_name}", injector)

    sys.modules.pop(module_name, None)


def test_load_tool_import_failure_raises():
    injector = Injector({})

    with pytest.raises(ToolLoadError):
        _load_tool("tests.nonexistent_module:Nope", injector)

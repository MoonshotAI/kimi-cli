import inspect
from collections.abc import Sequence
from types import ModuleType
from typing import Any, TypeAliasType, cast

import pytest

import kimi_types
from kimi_types import core, display, tool, wire
from kimi_types.utils.typing import flatten_union


@pytest.mark.parametrize("module", [kimi_types, core, display, tool, wire])
def test_module_definitions_in___all__(module: ModuleType) -> None:
    module_name = module.__name__
    module_all = getattr(module, "__all__", None)
    assert module_all is not None, f"{module_name} is missing __all__"

    exports = set(cast(Sequence[str], module_all))

    defined_ordered: list[str] = []
    for name, obj in module.__dict__.items():
        if name.startswith("_"):
            continue
        if not (inspect.isclass(obj) or inspect.isfunction(obj) or isinstance(obj, TypeAliasType)):
            continue
        obj_module = cast(str | None, getattr(obj, "__module__", None))
        if obj_module != module_name:
            continue
        defined_ordered.append(name)

    missing = set(defined_ordered) - exports
    assert not missing, f"{module_name} __all__ missing: {sorted(missing)}"

    ordered_exports = [name for name in cast(Sequence[str], module_all) if name in defined_ordered]
    assert ordered_exports == defined_ordered, (
        f"{module_name} __all__ order mismatch: expected {defined_ordered}, got {ordered_exports}"
    )


def test_wire_message_exports_present() -> None:
    expected = [cast(type[Any], typ).__name__ for typ in flatten_union(wire.WireMessage)]
    exports = set(cast(Sequence[str], wire.__all__))

    missing = [name for name in expected if name not in exports]
    assert not missing, f"kimi_types.wire __all__ missing wire messages: {missing}"

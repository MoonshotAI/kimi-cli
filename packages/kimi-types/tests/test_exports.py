import inspect
from typing import TypeAliasType

import pytest

import kimi_types
from kimi_types import core, display, tool, wire


@pytest.mark.parametrize("module", [kimi_types, core, display, tool, wire])
def test_module_definitions_in___all__(module):
    assert hasattr(module, "__all__"), f"{module.__name__} is missing __all__"
    exports = set(module.__all__)

    defined_ordered: list[str] = []
    for name, obj in module.__dict__.items():
        if name.startswith("_"):
            continue
        if not (inspect.isclass(obj) or inspect.isfunction(obj) or isinstance(obj, TypeAliasType)):
            continue
        if obj.__module__ != module.__name__:
            continue
        defined_ordered.append(name)

    missing = set(defined_ordered) - exports
    assert not missing, f"{module.__name__} __all__ missing: {sorted(missing)}"

    ordered_exports = [name for name in module.__all__ if name in defined_ordered]
    assert ordered_exports == defined_ordered, (
        f"{module.__name__} __all__ order mismatch: "
        f"expected {defined_ordered}, got {ordered_exports}"
    )


def test_wire_message_exports_present():
    expected = [typ.__name__ for typ in wire._WIRE_MESSAGE_TYPES]
    exports = set(wire.__all__)

    missing = [name for name in expected if name not in exports]
    assert not missing, f"kimi_types.wire __all__ missing wire messages: {missing}"

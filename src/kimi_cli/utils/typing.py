from types import UnionType
from typing import Any, TypeAliasType, Union, get_args, get_origin


def flatten_union(tp: Any) -> tuple[Any, ...]:
    """
    If `tp` is a `UnionType`, return its flattened arguments as a tuple.
    Otherwise, return a tuple with `tp` as the only element.
    """
    if isinstance(tp, TypeAliasType):
        tp = tp.__value__
    origin = get_origin(tp)
    if origin in (UnionType, Union):
        args = get_args(tp)
        flattened_args: list[Any] = []
        for arg in args:
            flattened_args.extend(flatten_union(arg))
        return tuple(flattened_args)
    else:
        return (tp,)

from __future__ import annotations

import copy
from typing import cast

from kosong.utils.typing import JsonType

type JsonDict = dict[str, JsonType]


def deref_json_schema(schema: JsonDict) -> JsonDict:
    """Expand local `$ref` entries in a JSON Schema without infinite recursion."""
    # Work on a deep copy so we never mutate the caller's schema.
    full_schema: JsonDict = copy.deepcopy(schema)

    def resolve_pointer(root: JsonDict, pointer: str) -> JsonType:
        """Resolve a JSON Pointer (e.g. ``#/$defs/User``) inside the schema."""
        parts = pointer.lstrip("#/").split("/")
        current: JsonType = root
        try:
            for part in parts:
                if isinstance(current, dict):
                    current = current[part]
                else:
                    raise ValueError
            return current
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"Unable to resolve reference path: {pointer}") from None

    def traverse(node: JsonType, root: JsonDict) -> JsonType:
        """Recursively traverse every node to inline local references."""
        if isinstance(node, dict):
            # Replace local ``$ref`` entries with their referenced payload.
            if "$ref" in node and isinstance(node["$ref"], str):
                ref_path = node["$ref"]
                if ref_path.startswith("#"):
                    # Resolve the local reference target.
                    target = resolve_pointer(root, ref_path)
                    # Recursively inline the target in case it contains more refs.
                    ref = traverse(target, root)
                    if not isinstance(ref, dict):
                        msg = "Local $ref must resolve to a JSON object"
                        raise TypeError(msg)
                    node.pop("$ref")
                    node.update(ref)
                    return node
                else:
                    # Ignore remote references such as http://...
                    return node

            # Traverse the remaining mapping entries.
            return {k: traverse(v, root) for k, v in node.items()}

        elif isinstance(node, list):
            # Traverse list members (e.g. allOf, oneOf, items).
            return [traverse(item, root) for item in node]

        else:
            return node

    # Remove definition buckets to keep the resolved schema minimal.
    resolved = cast(JsonDict, traverse(full_schema, full_schema))

    # Comment these lines if you want to keep the emitted definitions.
    resolved.pop("$defs", None)
    resolved.pop("definitions", None)

    return resolved

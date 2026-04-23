from __future__ import annotations

import copy
from typing import cast

from kosong.utils.typing import JsonType

type JsonDict = dict[str, JsonType]

# JSON Schema keywords that describe a property's shape without (or in
# addition to) a ``type`` keyword. When any of these are present we skip
# the type-filling step so we don't distort the schema's meaning —
# ``not``/``if``/``then``/``else`` are less common but every bit as valid
# as ``anyOf``/``oneOf``/``allOf``.
_COMBINATOR_KEYS = (
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "if",
    "then",
    "else",
    "$ref",
)


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


def ensure_property_types(schema: JsonDict) -> JsonDict:
    """Return a deep copy of ``schema`` with an explicit ``type`` on every property.

    The Moonshot (Kimi) API rejects tool parameter schemas where a property
    schema omits ``type`` — for example ``{"enum": ["smart", "full"]}`` with no
    ``"type": "string"``. JSON Schema itself permits this (the property then
    accepts any value), and providers such as OpenAI and Anthropic accept it,
    but Moonshot's stricter validator returns HTTP 400 with
    ``"At path 'properties.X': type is not defined"``.

    This function walks any property schemas nested under ``properties``,
    ``items``, ``additionalProperties``, ``anyOf``, ``oneOf``, and ``allOf``
    and fills in a ``type`` when one is missing:

    - when ``enum`` / ``const`` is present, the type is inferred from the values
    - otherwise the type defaults to ``"string"``

    Nodes that use combinators (``anyOf``/``oneOf``/``allOf``/``$ref``) are left
    alone since they legitimately declare their shape without ``type``. The
    outer schema object itself is treated as a container and never mutated —
    only the property schemas it contains are normalized.
    """
    result: JsonDict = copy.deepcopy(schema)
    _recurse_schema(result)
    return result


def _recurse_schema(node: JsonType) -> None:
    """Walk into property-schema positions under ``node`` and normalize them.

    ``node`` itself is treated as a container and is not normalized.
    """
    if not isinstance(node, dict):
        return

    props = node.get("properties")
    if isinstance(props, dict):
        for value in props.values():
            _normalize_property(value)

    items = node.get("items")
    if isinstance(items, dict):
        _normalize_property(items)
    elif isinstance(items, list):
        for value in items:
            _normalize_property(value)

    additional = node.get("additionalProperties")
    if isinstance(additional, dict):
        _normalize_property(additional)

    for key in ("anyOf", "oneOf", "allOf"):
        branches = node.get(key)
        if isinstance(branches, list):
            for value in branches:
                _normalize_property(value)


def _normalize_property(node: JsonType) -> None:
    """Ensure ``node`` (a property schema) declares a ``type``, then recurse."""
    if not isinstance(node, dict):
        return

    if "type" not in node and not any(key in node for key in _COMBINATOR_KEYS):
        enum_values = node.get("enum")
        if isinstance(enum_values, list) and enum_values:
            node["type"] = _infer_type_from_values(enum_values)
        elif "const" in node:
            node["type"] = _infer_type_from_values([node["const"]])
        else:
            node["type"] = _infer_type_from_structure(node)

    _recurse_schema(node)


# Structural keywords that only make sense for a given JSON Schema type.
# Used to infer `type` when enum/const are absent but the node otherwise
# clearly describes an object or array or constrained scalar — setting
# `type: "string"` on such a node would misadvertise the parameter shape
# and cause the model to emit arguments that then fail downstream
# `jsonschema.validate` against the tool's real parameter schema.
_OBJECT_KEYWORDS = (
    "properties",
    "additionalProperties",
    "patternProperties",
    "propertyNames",
    "required",
    "minProperties",
    "maxProperties",
)
_ARRAY_KEYWORDS = (
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "uniqueItems",
    "contains",
)
_STRING_KEYWORDS = ("minLength", "maxLength", "pattern", "format")
_NUMERIC_KEYWORDS = (
    "minimum",
    "maximum",
    "multipleOf",
    "exclusiveMinimum",
    "exclusiveMaximum",
)


def _infer_type_from_structure(node: JsonDict) -> str:
    """Infer a JSON Schema ``type`` from structural keywords in ``node``.

    Used as the fallback when no ``enum`` / ``const`` is present. Defaults
    to ``"string"`` only when the node carries no structural hints at all.
    """
    if any(k in node for k in _OBJECT_KEYWORDS):
        return "object"
    if any(k in node for k in _ARRAY_KEYWORDS):
        return "array"
    if any(k in node for k in _STRING_KEYWORDS):
        return "string"
    if any(k in node for k in _NUMERIC_KEYWORDS):
        return "number"
    return "string"


def _infer_type_from_values(values: list[JsonType]) -> str:
    """Infer a JSON Schema ``type`` string from a list of concrete values.

    Classify each value, then:
    - single type → return it
    - ``{integer, number}`` → ``"number"`` (integer is a subset of number)
    - anything else mixed (e.g. ``[True, 1]`` or ``["a", 1]``) → fall back to
      ``"string"``, which Moonshot tolerates without cross-checking enum
      values against the declared type
    """
    inferred: set[str] = set()
    for value in values:
        # ``bool`` is a subclass of ``int`` in Python, but JSON Schema treats
        # booleans as a distinct type, so classify it before the numeric checks.
        if isinstance(value, bool):
            inferred.add("boolean")
        elif isinstance(value, int):
            inferred.add("integer")
        elif isinstance(value, float):
            inferred.add("number")
        elif isinstance(value, str):
            inferred.add("string")
        elif value is None:
            inferred.add("null")
        elif isinstance(value, dict):
            inferred.add("object")
        elif isinstance(value, list):  # pyright: ignore[reportUnnecessaryIsInstance]
            inferred.add("array")
        else:
            # Unreachable for well-formed JSON values, but defensive for
            # non-JSON inputs (e.g. if a caller passes a tuple or custom
            # object): fall back to the safe string type.
            return "string"

    if len(inferred) == 1:
        return next(iter(inferred))
    if inferred == {"integer", "number"}:
        return "number"
    return "string"

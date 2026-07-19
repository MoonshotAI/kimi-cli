"""Tests for kosong.utils.json_args.decode_tool_arguments.

Covers the double-encoding unwrap edge cases E1-E8, the outer-malformed
re-raise, and two termination cases on adversarial nested input.

IMPORTANT (load-bearing): termination inputs are built with BOUNDED structural
generators. Never use `for _ in range(N): x = json.dumps(x)` — each json.dumps
re-escapes every backslash/quote so the string length grows ~4x per iteration
and OOM-kills the process at modest N. The structural generators below grow
linearly (+2 chars per nesting level).
"""

from __future__ import annotations

import json

import pytest

from kosong.utils.json_args import decode_tool_arguments

# --- E1: top-level double-encoding ---


def test_e1_top_level_double_encoding_unwraps_to_list():
    inner = json.dumps([{"title": "x", "status": "in_progress"}])
    raw = json.dumps({"todos": inner})
    assert decode_tool_arguments(raw) == {"todos": [{"title": "x", "status": "in_progress"}]}


# --- E2: nested double-encoding ---


def test_e2_nested_double_encoding_unwraps_inner_dict():
    deepest = json.dumps({"k": 1})
    middle = json.dumps({"meta": deepest})
    raw = json.dumps({"todos": middle})
    assert decode_tool_arguments(raw) == {"todos": {"meta": {"k": 1}}}


# --- E3: looks-like-JSON-but-isn't ---


def test_e3_non_json_string_preserved():
    raw = json.dumps({"note": "{oops}"})
    assert decode_tool_arguments(raw) == {"note": "{oops}"}


# --- E4: valid-JSON-scalar where field is string ---


def test_e4_scalar_json_string_preserved():
    raw = json.dumps({"count_str": "42"})
    assert decode_tool_arguments(raw) == {"count_str": "42"}


# --- E5: empty / None arguments ---


def test_e5_none_returns_empty_dict():
    assert decode_tool_arguments(None) == {}


def test_e5_empty_string_returns_empty_dict():
    assert decode_tool_arguments("") == {}


# --- E6: well-formed single-encoded args unchanged ---


def test_e6_well_formed_args_unchanged():
    raw = json.dumps({"todos": [{"title": "x", "status": "todo"}], "count": 3})
    expected = {"todos": [{"title": "x", "status": "todo"}], "count": 3}
    assert decode_tool_arguments(raw) == expected


# --- E7: list-typed outer value ---


def test_e7_list_outer_value_inner_string_decoded():
    raw = json.dumps([{"x": json.dumps(["y"])}])
    assert decode_tool_arguments(raw) == [{"x": ["y"]}]


# --- E8: value with bracket in the middle ---


def test_e8_value_with_mid_bracket_preserved():
    raw = json.dumps({"a": "hello [world"})
    assert decode_tool_arguments(raw) == {"a": "hello [world"}


# --- Outer malformed: re-raises JSONDecodeError ---


def test_outer_malformed_raises_jsondecodeerror():
    with pytest.raises(json.JSONDecodeError):
        decode_tool_arguments("{not json")


# --- Termination: bounded structural generators (NOT json.dumps in a loop) ---


def test_termination_structural_nested_array():
    """Build a deeply nested array by string concatenation (linear growth).

    `s = "[1]"; for _ in range(20): s = "[" + s + "]"` produces
    `[[[...[1]...]]]` (~43 chars at 20 levels). Exercises _unwrap's list
    branch recursively without exponential string growth. Starting from the
    single-element list ``[1]`` and adding 20 wrappers yields 21 total list
    levels, so the expected value wraps the int ``1`` in 21 lists.
    """
    wraps = 20
    s = "[1]"
    for _ in range(wraps):
        s = "[" + s + "]"
    expected: object = 1
    for _ in range(wraps + 1):  # +1 for the starting [1]
        expected = [expected]
    assert decode_tool_arguments(s) == expected


def test_termination_nested_double_encoding_structural():
    """Build a nested double-encoded string structurally (bounded).

    Each level wraps the previous JSON text as a JSON string value inside a
    new dict, exercising the string→dict→string→dict recursion path of
    ``_unwrap``. The innermost value is a scalar JSON string (the JSON text
    ``"1"``); because the dict-or-list gate refuses to promote scalar parses,
    that innermost value is preserved unchanged as the Python string with
    literal value ``"1"`` (3 chars), and each surrounding layer unwraps to a
    dict. After 10 levels ``_unwrap`` must have bottomed out to nested dicts
    with that innermost string intact — proving termination on an arbitrarily
    deep double-encoded chain.

    Growth is ~2x per level (the single layer of quotes/backslashes present in
    ``s`` gets re-escaped once per wrap, doubling rather than quadrupling), so
    10 levels is ~6 KB — comfortably bounded. This is NOT the OOM pattern
    (``for _ in range(N): x = json.dumps(x)`` on a nested object, which
    compounds ~4x per level); the base here is a scalar string with no quotes
    of its own.
    """
    levels = 10
    s = '"1"'  # innermost scalar JSON (stays a string: gate on dict-or-list)
    for _ in range(levels):
        s = json.dumps({"k": s})
    result = decode_tool_arguments(s)
    # The innermost value is the Python str with literal value '"1"' (the JSON
    # text '"1"', i.e. a 3-char string). _unwrap attempts json.loads on it,
    # which returns the scalar Python str '1' — NOT a dict/list — so the gate
    # returns the ORIGINAL '"1"' unchanged. Each surrounding layer then
    # unwraps to {"k": <inner>}.
    expected: object = '"1"'
    for _ in range(levels):
        expected = {"k": expected}
    assert result == expected

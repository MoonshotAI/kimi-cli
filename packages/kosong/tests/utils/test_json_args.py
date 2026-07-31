"""Tests for :func:`kosong.utils.json_args.decode_tool_arguments`.

Covers double-encoding unwrap, fast-path correctness, edge cases,
termination, and regression prevention (genuine string fields must
never be corrupted).
"""

from __future__ import annotations

import json

import pytest

from kosong.utils.json_args import decode_tool_arguments


# ───────────────────────────── E1: top-level double-encoding ─────


def test_e1_top_level_double_encoding_unwraps_to_list():
    inner = json.dumps([{"title": "x", "status": "in_progress"}])
    raw = json.dumps({"todos": inner})
    assert decode_tool_arguments(raw) == {"todos": [{"title": "x", "status": "in_progress"}]}


def test_e1_top_level_dict_double_encoding_unwraps():
    inner = json.dumps({"nested": {"deep": 1}})
    raw = json.dumps({"options": inner})
    assert decode_tool_arguments(raw) == {"options": {"nested": {"deep": 1}}}


# ───────────────────────────── E2: nested double-encoding ──────


def test_e2_nested_double_encoding_unwraps_inner_dict():
    deepest = json.dumps({"k": 1})
    middle = json.dumps({"meta": deepest})
    raw = json.dumps({"todos": middle})
    assert decode_tool_arguments(raw) == {"todos": {"meta": {"k": 1}}}


def test_e2_triple_nested_list_in_dict():
    inner = json.dumps([{"a": json.dumps([1, 2])}])
    raw = json.dumps({"data": inner})
    assert decode_tool_arguments(raw) == {"data": [{"a": [1, 2]}]}


# ───────────────────────────── E3: non-JSON strings preserved ──


def test_e3_non_json_string_preserved():
    raw = json.dumps({"note": "{oops}"})
    assert decode_tool_arguments(raw) == {"note": "{oops}"}


def test_e3_trailing_brace_only_preserved():
    raw = json.dumps({"msg": "hello}"})
    assert decode_tool_arguments(raw) == {"msg": "hello}"}


def test_e3_leading_bracket_only_preserved():
    raw = json.dumps({"msg": "[hello"})
    assert decode_tool_arguments(raw) == {"msg": "[hello"}


def test_e3_empty_string_preserved():
    raw = json.dumps({"empty": ""})
    assert decode_tool_arguments(raw) == {"empty": ""}


# ───────────────────────────── E4: scalar JSON strings preserved ─


def test_e4_scalar_json_string_preserved():
    raw = json.dumps({"count_str": "42"})
    assert decode_tool_arguments(raw) == {"count_str": "42"}


def test_e4_float_string_preserved():
    raw = json.dumps({"price_str": "3.14"})
    assert decode_tool_arguments(raw) == {"price_str": "3.14"}


def test_e4_bool_string_preserved():
    raw = json.dumps({"flag_str": "true"})
    assert decode_tool_arguments(raw) == {"flag_str": "true"}


def test_e4_null_string_preserved():
    raw = json.dumps({"none_str": "null"})
    assert decode_tool_arguments(raw) == {"none_str": "null"}


# ───────────────────────────── E5: None / empty input ────────────


def test_e5_none_returns_empty_dict():
    assert decode_tool_arguments(None) == {}


def test_e5_empty_string_returns_empty_dict():
    assert decode_tool_arguments("") == {}


# ───────────────────────────── E6: well-formed passthrough ───────


def test_e6_well_formed_args_unchanged():
    raw = json.dumps({"todos": [{"title": "x", "status": "todo"}], "count": 3})
    expected = {"todos": [{"title": "x", "status": "todo"}], "count": 3}
    assert decode_tool_arguments(raw) == expected


def test_e6_list_outer_value_unchanged():
    raw = json.dumps([{"a": 1}, {"b": 2}])
    assert decode_tool_arguments(raw) == [{"a": 1}, {"b": 2}]


# ───────────────────────────── E7: list-typed outer with inner ──


def test_e7_list_outer_value_inner_string_decoded():
    raw = json.dumps([{"x": json.dumps(["y"])}])
    assert decode_tool_arguments(raw) == [{"x": ["y"]}]


# ───────────────────────────── E8: mid-bracket / whitespace ─────


def test_e8_value_with_mid_bracket_preserved():
    raw = json.dumps({"a": "hello [world"})
    assert decode_tool_arguments(raw) == {"a": "hello [world"}


def test_e8_leading_whitespace_non_json_preserved():
    raw = json.dumps({"a": "   not json"})
    assert decode_tool_arguments(raw) == {"a": "   not json"}


def test_e8_leading_whitespace_json_array_still_decoded():
    inner = json.dumps([1, 2])
    raw = json.dumps({"nums": "   " + inner})
    assert decode_tool_arguments(raw) == {"nums": [1, 2]}


# ───────────────────────────── E9: malformed outer ──────────────


def test_e9_outer_malformed_raises_jsondecodeerror():
    with pytest.raises(json.JSONDecodeError):
        decode_tool_arguments("{not json")


def test_e9_outer_malformed_array_raises():
    with pytest.raises(json.JSONDecodeError):
        decode_tool_arguments("[1, 2,")


# ───────────────────────────── E10: fast-path sanity ──────────────


def test_e10_fast_path_does_not_corrupt_plain_text():
    """Strings starting with characters other than [ or { must never be parsed."""
    raw = json.dumps({
        "alpha": "alpha",
        "bravo": "123",
        "charlie": "true",
        "delta": "null",
        "echo": "   spaces",
        "foxtrot": "\t\ttabs",
    })
    assert decode_tool_arguments(raw) == {
        "alpha": "alpha",
        "bravo": "123",
        "charlie": "true",
        "delta": "null",
        "echo": "   spaces",
        "foxtrot": "\t\ttabs",
    }


# ───────────────────────────── Termination: deep nesting ─────────


def test_termination_structural_nested_array():
    """Build a deeply nested array by string concatenation (linear growth).

    ``s = \"[1]\"; for _ in range(20): s = \"[\" + s + \"]\"`` produces
    ``[[[...[1]...]]]`` (~43 chars at 20 levels). Exercises ``_unwrap``
    recursively without exponential string growth.
    """
    wraps = 20
    s = "[1]"
    for _ in range(wraps):
        s = "[" + s + "]"
    expected: object = 1
    for _ in range(wraps + 1):
        expected = [expected]
    assert decode_tool_arguments(s) == expected


def test_termination_nested_double_encoding_structural():
    """Build a nested double-encoded string structurally (bounded growth).

    Each level wraps the previous JSON text as a JSON string value inside a
    new dict, exercising the string→dict→string→dict recursion path of
    ``_unwrap``. The innermost value is a scalar JSON string (``"1"``); the
    dict-or-list gate refuses to promote scalar parses, so that innermost
    value is preserved unchanged, and each surrounding layer unwraps to a
    dict. After 10 levels ``_unwrap`` must have bottomed out to nested dicts
    with that innermost string intact.
    """
    levels = 10
    s = '"1"'  # innermost scalar JSON (stays a string: gate on dict-or-list)
    for _ in range(levels):
        s = json.dumps({"k": s})
    result = decode_tool_arguments(s)
    expected: object = '"1"'
    for _ in range(levels):
        expected = {"k": expected}
    assert result == expected


def test_termination_deep_dict_chain():
    """Deep dict nesting without double-encoding — verifies pure recursion."""
    depth = 100
    d: dict[str, object] = {"v": "leaf"}
    for _ in range(depth - 1):
        d = {"next": d}
    raw = json.dumps(d)
    assert decode_tool_arguments(raw) == d


# ───────────────────────────── Regression: real-world shapes ─────


def test_regression_set_todo_list_shape():
    """Reproduces the exact reported SetTodoList failure."""
    todos = [{"title": "Buy milk", "status": "in_progress"}]
    raw = json.dumps({"todos": json.dumps(todos)})
    assert decode_tool_arguments(raw) == {"todos": todos}


def test_regression_str_replace_file_edit_shape():
    """Reproduces StrReplaceFile.edit double-encoding."""
    edit = {"old_string": "foo", "new_string": "bar"}
    raw = json.dumps({"edit": json.dumps(edit)})
    assert decode_tool_arguments(raw) == {"edit": edit}


def test_regression_exit_plan_mode_options_shape():
    """Reproduces ExitPlanMode.options double-encoding."""
    options = [{"name": "opt1", "value": "val1"}]
    raw = json.dumps({"options": json.dumps(options)})
    assert decode_tool_arguments(raw) == {"options": options}


# ───────────────────────────── Mixed genuine + encoded ────────────


def test_mixed_genuine_and_encoded_fields():
    """A dict where some fields are genuine strings and others are double-encoded."""
    raw = json.dumps({
        "title": "genuine string",          # preserved
        "tags": json.dumps(["a", "b"]),     # unwrapped to list
        "count_str": "42",                   # preserved (scalar)
        "config": json.dumps({"x": 1}),      # unwrapped to dict
    })
    assert decode_tool_arguments(raw) == {
        "title": "genuine string",
        "tags": ["a", "b"],
        "count_str": "42",
        "config": {"x": 1},
    }


# ───────────────────────────── Unicode in encoded strings ───────


def test_unicode_in_double_encoded_string():
    inner = json.dumps({"message": "你好世界 🌍"})
    raw = json.dumps({"payload": inner})
    assert decode_tool_arguments(raw) == {"payload": {"message": "你好世界 🌍"}}


# ───────────────────────────── Safety: max depth guard ────────────


def test_max_depth_guard_terminates():
    """Adversarial payloads exceeding _MAX_UNWRAP_DEPTH are left unchanged
    rather than causing RecursionError.

    Uses a bounded structural generator (linear growth) rather than
    ``json.dumps`` in a loop which compounds ~4x per iteration.
    """
    # Build a chain deeper than _MAX_UNWRAP_DEPTH (100) using string
    # concatenation: each level adds ~8 chars, so 110 levels is ~1 KB.
    s = '{"v":1}'
    for _ in range(110):
        s = '{"next":' + s + '}'
    result = decode_tool_arguments(s)
    assert isinstance(result, dict)
    assert "next" in result
    # At depth >= _MAX_UNWRAP_DEPTH the dict is returned unchanged rather
    # than recursing further.  Dive 99 times → depth 99 < 100, so the 100th
    # level is still a dict (not a string) because json.loads ran at depth 99
    # and produced a dict which _unwrap then sees at depth 100 and preserves.
    inner = result
    for _ in range(99):
        inner = inner["next"]
    assert isinstance(inner, dict)

from kimi_cli.tools.review import MAX_CHANGES_CHARS, build_review_prompt


def test_build_review_prompt_injects_diff():
    diff = "example diff"
    prompt = build_review_prompt(diff, scope_hint="scope hint")

    assert "scope hint" in prompt
    assert "example diff" in prompt


def test_build_review_prompt_truncates_long_diff():
    long_diff = "x" * (MAX_CHANGES_CHARS + 10)
    prompt = build_review_prompt(long_diff)

    assert len(prompt) > 0
    assert long_diff[:MAX_CHANGES_CHARS] in prompt
    assert long_diff not in prompt

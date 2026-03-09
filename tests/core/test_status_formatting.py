from kimi_cli.soul import format_context_status, format_token_count


def test_format_token_count_drops_trailing_zero():
    assert format_token_count(1_000) == "1k"
    assert format_token_count(128_000) == "128k"
    assert format_token_count(1_000_000) == "1m"


def test_format_token_count_keeps_decimal_when_needed():
    assert format_token_count(1_550) == "1.6k"
    assert format_token_count(1_240_000) == "1.2m"


def test_format_context_status_uses_compact_token_counts():
    assert format_context_status(0.42, context_tokens=3_000, max_context_tokens=10_000) == (
        "context: 42.0% (3k/10k)"
    )

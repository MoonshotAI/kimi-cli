from kosong.chat_provider import TokenUsage

from kimi_cli.soul.kimisoul import KimiSoul


def test_safe_usage_handles_missing_input_tokens():
    usage = TokenUsage(input_other=None, output=7)  # type: ignore[arg-type]

    input_tokens, total_tokens = KimiSoul._safe_usage(usage)

    assert input_tokens == 0
    assert total_tokens == 7


def test_safe_usage_sums_all_fields():
    usage = TokenUsage(
        input_other=5,
        output=3,
        input_cache_read=2,
        input_cache_creation=1,
    )

    input_tokens, total_tokens = KimiSoul._safe_usage(usage)

    assert input_tokens == 8
    assert total_tokens == 11

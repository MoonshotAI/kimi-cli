from kimi_cli.auth.oauth import _ascii_header_value


def test_ascii_header_value_strips_trailing_space():
    assert _ascii_header_value("test ") == "test"
    assert _ascii_header_value(" test") == "test"
    assert _ascii_header_value("  test  ") == "test"


def test_ascii_header_value_non_ascii_strips_trailing_space():
    # Non-ASCII character (Chinese 'test') followed by space
    # The non-ASCII characters are ignored by encode('ascii', errors='ignore')
    # So "测试 " becomes " " and then .strip() makes it empty, returning fallback
    assert _ascii_header_value("测试 ") == "unknown"
    # "A测试 " -> "A " -> "A"
    assert _ascii_header_value("A测试 ") == "A"


def test_ascii_header_value_fallback():
    # Only non-ASCII characters that get ignored, resulting in empty string
    assert _ascii_header_value("🚀") == "unknown"
    assert _ascii_header_value("🚀", fallback="default") == "default"

"""Tests for datetime utility functions, including format_elapsed."""

from kimi_cli.utils.datetime import format_elapsed


class TestFormatElapsed:
    """format_elapsed: human-friendly elapsed time for spinners."""

    def test_sub_second(self):
        assert format_elapsed(0.0) == "<1s"
        assert format_elapsed(0.5) == "<1s"
        assert format_elapsed(0.99) == "<1s"

    def test_seconds(self):
        assert format_elapsed(1.0) == "1s"
        assert format_elapsed(5.3) == "5s"
        assert format_elapsed(59.9) == "59s"

    def test_one_minute(self):
        assert format_elapsed(60.0) == "1m 0s"

    def test_minutes_and_seconds(self):
        assert format_elapsed(61.0) == "1m 1s"
        assert format_elapsed(90.0) == "1m 30s"
        assert format_elapsed(125.0) == "2m 5s"

    def test_many_minutes(self):
        assert format_elapsed(300.0) == "5m 0s"
        assert format_elapsed(599.0) == "9m 59s"

    def test_hours(self):
        assert format_elapsed(3600.0) == "1h 0m 0s"
        assert format_elapsed(3661.0) == "1h 1m 1s"

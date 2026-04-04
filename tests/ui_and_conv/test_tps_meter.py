"""Tests for TPS meter UI state module."""

import pytest

from kimi_cli.ui.tps_meter import get_show_tps_meter, set_show_tps_meter


@pytest.fixture(autouse=True)
def _reset_tps_meter():
    set_show_tps_meter(False)
    yield
    set_show_tps_meter(False)


class TestTpsMeterState:
    def test_get_and_set_show_tps_meter(self):
        assert get_show_tps_meter() is False
        set_show_tps_meter(True)
        assert get_show_tps_meter() is True
        set_show_tps_meter(False)
        assert get_show_tps_meter() is False

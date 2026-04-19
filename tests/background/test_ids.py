from __future__ import annotations

import pytest

from kimi_cli.background.ids import generate_task_id
from kimi_cli.background.store import _VALID_TASK_ID


class TestTaskIdValidation:
    def test_generated_ids_pass_store_validation(self):
        """Ensure ids.py and store.py stay in sync."""
        for kind in ("bash", "agent"):
            task_id = generate_task_id(kind)
            assert _VALID_TASK_ID.match(task_id), f"{task_id!r} should pass validation"

    @pytest.mark.parametrize(
        "task_id",
        [
            "b1234567",
            "a1234567",
            "bmissing01",
        ],
    )
    def test_old_format_ids_still_accepted(self, task_id):
        assert _VALID_TASK_ID.match(task_id), f"old format {task_id!r} should still be valid"

    @pytest.mark.parametrize(
        "task_id",
        [
            "",
            "x",
            "-bash",
            "BASH-123",
            "bash_123",
            "../escape",
            "a" * 26,
        ],
    )
    def test_invalid_ids_rejected(self, task_id):
        assert not _VALID_TASK_ID.match(task_id), f"{task_id!r} should be rejected"

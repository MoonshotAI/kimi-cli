# type: ignore
import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
from kimi_cli.utils.logging import logger

from swebench.config import EvalConfig
from swebench.runtime import SWEBenchContainerRuntime
from swebench.utils.patch import filter_binary_diffs


@dataclass
class EvalResult:
    instance_id: str
    status: str
    git_patch: str = ""
    error: str | None = None
    history: list[dict[str, Any]] | None = None
    metrics: dict[str, Any] | None = None
    duration_seconds: float = 0.0


    def __post_init__(self) -> None:
        self.history = self.history or []
        self.metrics = self.metrics or {}


    def to_dict(self) -> dict[str, Any]:
        return {
            "instance_id": self.instance_id,
            "status": self.status,
            "git_patch": self.git_patch,
            "error": self.error,
            "history": self.history,
            "metrics": self.metrics,
            "duration_seconds": self.duration_seconds,
        }


    def to_json(self) -> str:
        return json.dumps(self.to_dict())


class SWEBenchInstanceEvaluator:
    def __init__(self, instance: pd.Series, config: EvalConfig):
        self.instance = instance
        self.config = config


    async def evaluate(self) -> EvalResult:
        start_time = asyncio.get_event_loop().time()
        result = EvalResult(instance_id=self.instance["instance_id"], status="error")

        try:
            runtime = SWEBenchContainerRuntime(self.instance.to_dict(), self.config, Path("/testbed"))
            await runtime.start()

            try:
                base_commit = self.instance.get("base_commit")
                if base_commit:
                    await runtime.checkout_base_commit()

                git_patch = await runtime.get_git_diff()
                result.git_patch = filter_binary_diffs(git_patch)
                result.status = "success"

                logger.info(f"✓ {self.instance['instance_id']}: completed")
            except Exception as e:
                logger.error(f"✗ {self.instance['instance_id']}: {e}")
                result.status = "error"
                result.error = str(e)
            finally:
                await runtime.cleanup()

        except Exception as e:
            logger.error(f"Failed to evaluate {self.instance['instance_id']}: {e}")
            result.status = "error"
            result.error = str(e)
        finally:
            end_time = asyncio.get_event_loop().time()
            result.duration_seconds = end_time - start_time

        return result
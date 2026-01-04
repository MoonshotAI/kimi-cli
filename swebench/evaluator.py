import asyncio
import json
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd
from kimi_cli.app import KimiCLI
from kimi_cli.session import Session
from kimi_cli.utils.logging import logger

from swebench_kimi_eval.config import EvalConfig, RuntimeConfig
from swebench_kimi_eval.utils.git import get_diff
from swebench_kimi_eval.utils.patch import filter_binary_diffs


@dataclass
class EvalResult:
    instance_id: str
    status: str  # "success", "failed", "timeout", "error"
    git_patch: str = ""
    error: str | None = None
    history: list[dict[str, Any]] = None
    metrics: dict[str, Any] | None = None
    duration_seconds: float = 0.0

    def __post_init__(self) -> None:
        if self.history is None:
            self.history = []
        if self.metrics is None:
            self.metrics = {}

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
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

    def __init__(
        self,
        instance: pd.Series,
        config: EvalConfig,
        work_dir: Path,
    ):
        self.instance = instance
        self.config = config
        self.work_dir = work_dir

    def _get_instruction(self) -> str:
        problem_statement = self.instance.get("problem_statement", "")

        instruction = f"""
<uploaded_files>
{self.work_dir}
</uploaded_files>

I've uploaded a code repository. Consider the following issue description:

<issue_description>
{problem_statement}
</issue_description>

Can you help me implement the necessary changes to the repository to resolve this issue?

Follow these steps:
1. Explore the repository structure to understand the codebase
2. Create a reproduction script to verify the issue
3. Implement the fix
4. Verify the fix works

Be thorough in your exploration and testing.
""".strip()
        return instruction

    async def evaluate(self) -> EvalResult:
        start_time = asyncio.get_event_loop().time()
        result = EvalResult(
            instance_id=self.instance["instance_id"],
            status="error",
        )

        try:
            async with tempfile.TemporaryDirectory() as tmpdir:
                session = await Session.create(work_dir=self.work_dir)

                try:
                    kimi = await KimiCLI.create(
                        session,
                        model_name=self.config.kimi.model,
                        yolo=True,  # Auto-approve actions
                    )

                    instruction = self._get_instruction()

                    logger.info(
                        f"Evaluating instance {self.instance['instance_id']}..."
                    )

                    result.status = "success"

                    try:
                        git_patch = get_diff(
                            self.work_dir,
                            self.instance.get("base_commit", "")
                        )
                        result.git_patch = filter_binary_diffs(git_patch)
                    except Exception as e:
                        logger.error(f"Failed to get git patch: {e}")
                        result.error = str(e)

                except Exception as e:
                    logger.error(f"Error running KimiCLI: {e}")
                    result.status = "error"
                    result.error = str(e)
                finally:
                    await session.close()

        except Exception as e:
            logger.error(f"Evaluation failed: {e}")
            result.status = "error"
            result.error = str(e)
        finally:
            end_time = asyncio.get_event_loop().time()
            result.duration_seconds = end_time - start_time

        return result


class SWEBenchEvaluator:
    def __init__(self, config: EvalConfig | Path | str | None = None, **kwargs: Any):
        if isinstance(config, (Path, str)):
            self.config = EvalConfig.from_file(config)
        elif isinstance(config, EvalConfig):
            self.config = config
        else:
            self.config = EvalConfig(**kwargs)

        for key, value in kwargs.items():
            if hasattr(self.config, key):
                setattr(self.config, key, value)

        if self.config.eval_output_dir is None:
            self.config.eval_output_dir = str(
                Path(self.config.output_dir) / "eval_output"
            )
        Path(self.config.eval_output_dir).mkdir(parents=True, exist_ok=True)

    async def run(self) -> list[EvalResult]:
        results: list[EvalResult] = []
        instances = self._load_instances()

        logger.info(f"Loaded {len(instances)} instances for evaluation")

        with tempfile.TemporaryDirectory() as work_dir:
            work_path = Path(work_dir)

            for idx, instance in enumerate(instances.iterrows(), 1):
                idx_val, row = instance
                logger.info(f"[{idx}/{len(instances)}] Evaluating {row['instance_id']}")

                evaluator = SWEBenchInstanceEvaluator(row, self.config, work_path)
                result = await evaluator.evaluate()
                results.append(result)

                self._save_result(result)

        return results

    def _load_instances(self) -> pd.DataFrame:
        dataset_path = Path(self.config.dataset_path)

        if not dataset_path.exists():
            raise FileNotFoundError(f"Dataset not found: {dataset_path}")

        if dataset_path.suffix == ".jsonl":
            records = []
            with open(dataset_path) as f:
                for line in f:
                    if line.strip():
                        records.append(json.loads(line))
            instances = pd.DataFrame(records)
        else:
            instances = pd.read_json(dataset_path, lines=True)

        if self.config.selected_ids:
            instances = instances[instances["instance_id"].isin(self.config.selected_ids)]

        return instances

    def _save_result(self, result: EvalResult) -> None:
        output_file = Path(self.config.eval_output_dir) / "output.jsonl"
        with open(output_file, "a") as f:
            f.write(result.to_json() + "\n")

    async def run_single(self, instance_id: str) -> EvalResult:
        instances = self._load_instances()
        instance = instances[instances["instance_id"] == instance_id]

        if instance.empty:
            raise ValueError(f"Instance not found: {instance_id}")

        with tempfile.TemporaryDirectory() as work_dir:
            evaluator = SWEBenchInstanceEvaluator(
                instance.iloc[0], self.config, Path(work_dir)
            )
            return await evaluator.evaluate()
import asyncio
import json
import tempfile
from pathlib import Path
from typing import Any, Callable

import pandas as pd
from kimi_cli.utils.logging import logger

from swebench_kimi_eval.config import EvalConfig
from swebench_kimi_eval.evaluator import EvalResult, SWEBenchEvaluator


class SWEBenchRunner:
    def __init__(self, config: EvalConfig):
        self.config = config
        self.evaluator = SWEBenchEvaluator(config)
        self.results: list[EvalResult] = []

    async def run(
        self,
        on_instance_complete: Callable[[EvalResult], None] | None = None,
    ) -> list[EvalResult]:
        logger.info(f"Starting SWE-Bench evaluation")
        logger.info(f"  Dataset: {self.config.dataset_path}")
        logger.info(f"  Output: {self.config.output_dir}")
        logger.info(f"  Model: {self.config.kimi.model}")
        logger.info(f"  Timeout: {self.config.timeout_seconds}s per instance")

        self.results = await self.evaluator.run()

        if on_instance_complete:
            for result in self.results:
                on_instance_complete(result)

        return self.results

    def print_summary(self) -> None:
        if not self.results:
            print("No results to summarize")
            return

        stats = {
            "total": len(self.results),
            "success": sum(1 for r in self.results if r.status == "success"),
            "failed": sum(1 for r in self.results if r.status == "failed"),
            "error": sum(1 for r in self.results if r.status == "error"),
            "timeout": sum(1 for r in self.results if r.status == "timeout"),
        }

        total_time = sum(r.duration_seconds for r in self.results)

        print(f"\n{'='*70}")
        print(f"SWE-Bench Evaluation Summary")
        print(f"{'='*70}")
        print(f"Total instances: {stats['total']}")
        print(f"  ✓ Successful: {stats['success']} ({stats['success']*100/stats['total']:.1f}%)")
        print(f"  ✗ Failed: {stats['failed']} ({stats['failed']*100/stats['total']:.1f}%)")
        print(f"  ⚠ Error: {stats['error']} ({stats['error']*100/stats['total']:.1f}%)")
        print(f"  ⏱ Timeout: {stats['timeout']} ({stats['timeout']*100/stats['total']:.1f}%)")
        print(f"Total time: {total_time:.1f}s ({total_time/3600:.1f}h)")
        print(f"{'='*70}\n")

    def save_results(self, format: str = "jsonl") -> Path:
        output_dir = Path(self.config.output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        if format == "jsonl":
            output_file = output_dir / "results.jsonl"
            with open(output_file, "w") as f:
                for result in self.results:
                    f.write(result.to_json() + "\n")
        elif format == "json":
            output_file = output_dir / "results.json"
            with open(output_file, "w") as f:
                json.dump([r.to_dict() for r in self.results], f, indent=2)
        else:
            raise ValueError(f"Unsupported format: {format}")

        logger.info(f"Results saved to: {output_file}")
        return output_file

    def get_failed_instances(self) -> list[str]:
        return [r.instance_id for r in self.results if r.status in ("failed", "error")]

    def get_successful_instances(self) -> list[str]:
        return [r.instance_id for r in self.results if r.status == "success"]

    def filter_results(self, status: str | None = None) -> list[EvalResult]:
        if status is None:
            return self.results
        return [r for r in self.results if r.status == status]


async def run_evaluation(
    config: EvalConfig,
    on_progress: Callable[[int, int, EvalResult], None] | None = None,
) -> list[EvalResult]:
    runner = SWEBenchRunner(config)

    dataset_path = Path(config.dataset_path)
    if dataset_path.suffix == ".jsonl":
        total = sum(1 for _ in open(dataset_path) if _.strip())
    else:
        total = len(pd.read_json(dataset_path, lines=True))

    current = 0

    def on_complete(result: EvalResult) -> None:
        nonlocal current
        current += 1
        if on_progress:
            on_progress(current, total, result)

    results = await runner.run(on_instance_complete=on_complete)

    return results


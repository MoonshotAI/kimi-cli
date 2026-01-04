# type: ignore
import argparse
import asyncio
import json
from pathlib import Path

from kimi_cli.utils.logging import enable_logging, logger  # type: ignore

from swebench.config import EvalConfig, KimiCliConfig
from swebench.evaluator import EvalResult, SWEBenchEvaluator


class Evaluator:
    def __init__(
        self, config: EvalConfig, max_workers: int = 1, output_file: Path | None = None
    ):
        self.config = config
        self.max_workers = max_workers
        self.semaphore = asyncio.Semaphore(max_workers)
        self.output_file = output_file
        self.current_task = 0
        self.total_tasks = 0
        self.completed_ids = self._load_completed_ids()

    def _load_completed_ids(self) -> set[str]:
        """Load already completed instance IDs from output file."""
        if not self.output_file or not self.output_file.exists():
            return set()

        completed = set()
        try:
            with open(self.output_file) as f:
                for line in f:
                    if line.strip():
                        result = json.loads(line)
                        completed.add(result.get("instance_id"))
        except Exception as e:
            logger.warning(f"Failed to load completed IDs: {e}")
        return completed

    async def _evaluate_instance(self, instance_id: str) -> EvalResult | None:
        if instance_id in self.completed_ids:
            logger.debug(f"Skipping already completed: {instance_id}")
            return None

        async with self.semaphore:
            self.current_task += 1
            logger.info(f"[{self.current_task}/{self.total_tasks}] Evaluating {instance_id}")

            try:
                result = await SWEBenchEvaluator(self.config).run_single(instance_id)
                logger.info(f"✓ {instance_id}: {result.status}")

                if self.output_file:
                    self._save_result(result)

                return result
            except Exception as e:
                logger.error(f"✗ {instance_id}: {e}")
                result = EvalResult(instance_id=instance_id, status="error", error=str(e))
                if self.output_file:
                    self._save_result(result)
                return result

    def _save_result(self, result: EvalResult) -> None:
        try:
            with open(self.output_file, "a") as f:
                f.write(result.to_json() + "\n")
        except Exception as e:
            logger.error(f"Failed to save result: {e}")

    async def run(self) -> list[EvalResult]:
        instances_df = SWEBenchEvaluator(self.config)._load_instances()
        self.total_tasks = len(instances_df)

        logger.info(f"Loaded {self.total_tasks} instances")
        logger.info(f"Already completed: {len(self.completed_ids)}")
        logger.info(f"Running with {self.max_workers} concurrent workers")

        tasks = [
            self._evaluate_instance(instance_id)
            for instance_id in instances_df["instance_id"]
        ]

        results = await asyncio.gather(*tasks)
        return [r for r in results if r is not None]


def main(args: argparse.Namespace) -> None:
    enable_logging(debug=args.debug)
    logger.info("Starting SWE-Bench evaluation")

    config = EvalConfig(
        dataset_path=args.dataset,
        output_dir=args.output,
        kimi=KimiCliConfig(model=args.model),
        timeout_seconds=args.timeout,
    )

    if args.instances:
        config.selected_ids = [id.strip() for id in args.instances.split(",")]
        logger.info(f"Evaluating {len(config.selected_ids)} specific instances")

    Path(config.output_dir).mkdir(parents=True, exist_ok=True)

    logger.info(f"Dataset: {config.dataset_path}")
    logger.info(f"Output: {config.output_dir}")
    logger.info(f"Model: {config.kimi.model}")
    logger.info(f"Workers: {args.workers}")
    logger.info(f"Timeout: {config.timeout_seconds}s per instance")

    output_file = Path(config.output_dir) / "results.jsonl"

    evaluator = Evaluator(config, max_workers=args.workers, output_file=output_file)
    results = asyncio.run(evaluator.run())
    logger.info(f"Evaluation completed: {len(results)} new results")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SWE-Bench evaluation")
    parser.add_argument("--dataset", required=True, help="Path to dataset")
    parser.add_argument("--output", default="./results", help="Output directory")
    parser.add_argument("--model", default="gpt-4", help="LLM model")
    parser.add_argument("--workers", type=int, default=1, help="Concurrent workers")
    parser.add_argument("--timeout", type=int, default=43200, help="Timeout (s)")
    parser.add_argument("--instances", help="Comma-separated instance IDs")
    parser.add_argument("--debug", action="store_true", help="Debug logging")
    args = parser.parse_args()
    main(args)

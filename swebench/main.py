# type: ignore
import argparse
import asyncio
import json
from pathlib import Path

import pandas as pd
from kimi_cli.utils.logging import enable_logging, logger  # type: ignore

from swebench.config import EvalConfig, KimiCliConfig
from swebench.evaluator import EvalResult, SWEBenchInstanceEvaluator


async def main(args: argparse.Namespace) -> None:
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

    # Load completed instances
    output_file = Path(config.output_dir) / "results.jsonl"
    completed_ids = set()
    if output_file.exists():
        with open(output_file) as f:
            for line in f:
                if line.strip():
                    try:
                        result = json.loads(line)
                        completed_ids.add(result.get("instance_id"))
                    except Exception:
                        pass

    dataset_path = Path(config.dataset_path)
    if not dataset_path.exists():
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")

    if dataset_path.suffix == ".jsonl":
        records = []
        with open(dataset_path) as f:
            for line in f:
                if line.strip():
                    records.append(json.loads(line))
        instances_df = pd.DataFrame(records)
    else:
        instances_df = pd.read_json(dataset_path, lines=True)

    if config.selected_ids:
        instances_df = instances_df[instances_df["instance_id"].isin(config.selected_ids)]

    total_tasks = len(instances_df)
    already_completed = len(completed_ids)

    logger.info(f"Loaded {total_tasks} instances")
    logger.info(f"Already completed: {already_completed}")
    logger.info(f"Running with {args.workers} concurrent workers")

    semaphore = asyncio.Semaphore(args.workers)
    current_task = 0

    async def evaluate_with_limit(instance_id: str) -> EvalResult | None:
        nonlocal current_task

        if instance_id in completed_ids:
            logger.debug(f"Skipping already completed: {instance_id}")
            return None

        async with semaphore:
            current_task += 1
            logger.info(f"[{current_task}/{total_tasks}] Evaluating {instance_id}")

            try:
                instance = instances_df[instances_df["instance_id"] == instance_id].iloc[0]
                evaluator = SWEBenchInstanceEvaluator(instance, config)
                result = await evaluator.evaluate()
                logger.info(f"✓ {instance_id}: {result.status}")

                with open(output_file, "a") as f:
                    f.write(result.to_json() + "\n")

                return result
            except Exception as e:
                logger.error(f"✗ {instance_id}: {e}")
                result = EvalResult(instance_id=instance_id, status="error", error=str(e))
                with open(output_file, "a") as f:
                    f.write(result.to_json() + "\n")
                return result

    tasks = [
        evaluate_with_limit(instance_id) for instance_id in instances_df["instance_id"]
    ]
    results = await asyncio.gather(*tasks)
    new_results = [r for r in results if r is not None]

    logger.info(f"Evaluation completed: {len(new_results)} new results")


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
    asyncio.run(main(args))

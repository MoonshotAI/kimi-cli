# type: ignore
import argparse
import asyncio
import json
import sys
import os
from pathlib import Path

import pandas as pd
from kimi_cli.app import enable_logging
from kimi_cli.utils.logging import logger  # type: ignore

from swebench.config import EvalConfig, KimiCliConfig
from swebench.evaluator import EvalResult, SWEBenchInstanceEvaluator
from swebench.utils.log import EvalRunLogger


async def main(args: argparse.Namespace) -> None:
    enable_logging(debug=args.debug)
    logger.add(
        sys.stderr,
        level="DEBUG" if args.debug else "INFO",
        format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan> - <level>{message}</level>",
    )
    logger.info("Starting SWE-Bench evaluation")

    config = EvalConfig(
        dataset_path=args.dataset,
        output_dir=args.output,
        kimi=KimiCliConfig(
            model=args.model,
            api_key=args.api_key,
            base_url=args.base_url,
            temperature=args.temperature,
            top_p=args.top_p,
            max_output_tokens=args.max_output_tokens,
        ),
        timeout_seconds=args.timeout,
    )

    if args.instances:
        config.selected_ids = [id.strip() for id in args.instances.split(",")]
        logger.info(f"Evaluating {len(config.selected_ids)} specific instances")

    os.makedirs(config.output_dir, exist_ok=True)

    logger.info(f"Dataset: {config.dataset_path}")
    logger.info(f"Output: {config.output_dir}")
    logger.info(f"Model: {config.kimi.model}")
    logger.info(f"API Key: {config.kimi.api_key}")
    logger.info(f"Base URL: {config.kimi.base_url}")
    logger.info(f"Workers: {args.workers}")
    logger.info(f"Timeout: {config.timeout_seconds}s per instance")

    dataset_path = os.path.join(config.dataset_path)
    if not os.path.exists(dataset_path):
        raise FileNotFoundError(f"Dataset not found: {dataset_path}")

    if os.path.splitext(dataset_path)[1] == ".jsonl":
        records = []
        with open(dataset_path) as f:
            for line in f:
                if line.strip():
                    records.append(json.loads(line))
        instances_df = pd.DataFrame(records)
    else:
        with open(dataset_path) as f:
            instances_df = pd.read_json(f, lines=True)

    if config.selected_ids:
        instances_df = instances_df[instances_df["instance_id"].isin(config.selected_ids)]

    total_tasks = len(instances_df)

    logger.info(f"Loaded {total_tasks} instances")
    logger.info(f"Running with {args.workers} concurrent workers")

    # Initialize structured logging
    run_logger = EvalRunLogger(config.output_dir, config.kimi.model)
    logger.info(f"Structured logs: {run_logger.run_dir}")
    run_output_file = run_logger.run_dir / "results.jsonl"

    completed_ids = set()
    if run_output_file.exists():
        with open(run_output_file) as f:
            for line in f:
                if line.strip():
                    try:
                        result = json.loads(line)
                        completed_ids.add(result.get("instance_id"))
                    except Exception:
                        pass
    
    already_completed = len(completed_ids)
    logger.info(f"Already completed in this run: {already_completed}")

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
                config.kimi.model = args.model
                logger.info(f"Model configured: {config.kimi.model}, API Key set: {bool(config.kimi.api_key)}")
                evaluator = SWEBenchInstanceEvaluator(instance, config, run_logger)
                result = await evaluator.evaluate()
                logger.info(f"✓ {instance_id}: {result.status}")

                with open(run_output_file, "a") as f:
                    f.write(result.to_json() + "\n")

                return result
            except Exception as e:
                logger.error(f"✗ {instance_id}: {e}")
                result = EvalResult(instance_id=instance_id, status="error", error=str(e))
                with open(run_output_file, "a") as f:
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
    parser.add_argument("--model", default="gpt-4", help="LLM model name")
    parser.add_argument("--api-key", default=None, help="API key for LLM")
    parser.add_argument("--base-url", default=None, help="Base URL for LLM API")
    parser.add_argument("--temperature", type=float, default=1.0, help="Temperature for sampling")
    parser.add_argument("--top-p", type=float, default=1.0, help="Top-p for sampling")
    parser.add_argument("--max-output-tokens", type=int, default=8192, help="Max output tokens")
    parser.add_argument("--workers", type=int, default=1, help="Concurrent workers")
    parser.add_argument("--timeout", type=int, default=7200, help="Timeout per instance (s)")
    parser.add_argument("--instances", help="Comma-separated instance IDs")
    parser.add_argument("--debug", action="store_true", help="Debug logging")
    args = parser.parse_args()
    asyncio.run(main(args))

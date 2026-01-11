# type: ignore
import argparse
import asyncio
import json
import jsonlines
import sys
import os

import pandas as pd
from kimi_cli.app import enable_logging
from kimi_cli.utils.logging import logger

from benchmarking.utils.config import EvalConfig, EvalResult
from benchmarking.utils.log import EvalRunLogger
from benchmarking.utils.utils import get_evaluator_map

async def main(args: argparse.Namespace) -> None:
    enable_logging(debug=args.debug)
    logger.add(
        sys.stderr,
        level="DEBUG" if args.debug else "INFO",
        format="<green>{time:HH:mm:ss}</green> | <level>{level: <8}</level> | <cyan>{name}</cyan>:<cyan>{function}</cyan> - <level>{message}</level>",
    )
    
    config = EvalConfig(
        api_key=args.api_key,
        base_url=args.base_url,
        model=args.model,
        max_context_size=args.max_context_size,
        temperature=args.temperature,
        top_p=args.top_p,
        max_tokens=args.max_tokens,
        debug=args.debug,
        dataset_path=args.dataset_path,
        split=args.split,
        output_dir=args.output_dir,
        timeout_seconds=args.timeout,
        max_workers=args.max_workers,
        use_gpu=args.use_gpu,
        max_iterations=args.max_iterations,
        max_retries=args.max_retries,
        task_type=args.task_type,
    )
 
    semaphore = asyncio.Semaphore(args.max_workers)
    current_task = 0
    EVALUATOR_CLASS = get_evaluator_map()[config.task_type]
    
    os.makedirs(config.output_dir, exist_ok=True)

    logger.info(f"Running benchmarking with config: {config.model_dump_json(indent=2)}")

    dataset_path = os.path.join(config.dataset_path)
    if dataset_path.endswith(".jsonl"):
        with jsonlines.open(dataset_path) as reader:
            records = list(reader)
        instances_df = pd.DataFrame(records)
    else:
        instances_df = pd.read_json(dataset_path, lines=True)

    instances_df = instances_df.set_index("instance_id")
    logger.info(f"Loaded {len(instances_df)} instances")
    run_logger = EvalRunLogger(config.output_dir, config.model)
    logger.info(f"Structured logs: {run_logger.run_dir}")
    run_output_file = str(run_logger.run_dir / "results.jsonl")

    completed_ids = set()
    if os.path.exists(run_output_file):
        with jsonlines.open(run_output_file) as f:
            for result in f:
                completed_ids.add(result["instance_id"])

    already_completed = len(completed_ids)
    logger.info(f"Already completed in this run: {already_completed}")

    async def evaluate_with_limit(instance_id):
        nonlocal current_task
        if instance_id in completed_ids:
            logger.debug(f"Skipping already completed: {instance_id}")
            return None

        async with semaphore:
            current_task += 1
            logger.info(f"[{current_task}/{len(instances_df)}] Evaluating {instance_id}")

            instance = instances_df.loc[instance_id].to_dict()
            instance["instance_id"] = instance_id
            result = None
            for attempt in range(1, config.max_retries + 1):
                try:
                    evaluator = EVALUATOR_CLASS(instance, config, run_logger)
                    result = await evaluator.evaluate()
                    if result.status == "success":
                        logger.info(f"✓ {instance_id}: {result.status}")
                        with open(run_output_file, "a") as f:
                            f.write(json.dumps(result.to_dict()) + "\n")
                        return
                    elif attempt < config.max_retries:
                        logger.warning(
                            f"✗ {instance_id} (attempt {attempt}/{config.max_retries}): "
                            f"status={result.status}, will retry..."
                        )
                        continue
                    else:
                        logger.error(
                            f"✗ {instance_id}: Failed after {config.max_retries} attempts, "
                            f"final status={result.status}"
                        )
                        with open(run_output_file, "a") as f:
                            f.write(json.dumps(result.to_dict()) + "\n")
                        return
                except Exception as e:
                    if attempt < config.max_retries:
                        logger.warning(
                            f"✗ {instance_id} (attempt {attempt}/{config.max_retries}): {e}, "
                            f"will retry..."
                        )
                        continue
                    else:
                        logger.error(f"✗ {instance_id}: Failed after {config.max_retries} attempts")
                        result = EvalResult(instance_id=instance_id, status="error", error=str(e))
                        with open(run_output_file, "a") as f:
                            f.write(json.dumps(result.to_dict()) + "\n")
                        return

    tasks = [evaluate_with_limit(instance_id) for instance_id in instances_df.index]
    await asyncio.gather(*tasks)
    logger.info(f"Evaluation completed!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Benchmarking evaluation")
    parser.add_argument("--api-key", required=True, help="API key")
    parser.add_argument("--base-url", required=True, help="Base URL")
    parser.add_argument("--model", required=True, help="Model name")
    parser.add_argument("--max-context-size", type=int, default=131072, help="Max context size")
    parser.add_argument("--temperature", type=float, default=1.0, help="Temperature for sampling")
    parser.add_argument("--top-p", type=float, default=1.0, help="Top-p for sampling")
    parser.add_argument("--max-tokens", type=int, default=8192, help="Max output tokens")
    parser.add_argument("--debug", action="store_true", help="Debug logging")
    parser.add_argument("--dataset-path", required=True, help="Path to dataset")
    parser.add_argument("--split", default="train", help="Dataset split to use")
    parser.add_argument("--selected-ids", help="Comma-separated instance IDs")
    parser.add_argument("--output-dir", default="./results", help="Output directory")
    parser.add_argument("--timeout", type=int, default=7200, help="Timeout per instance (s)")
    parser.add_argument("--max-workers", type=int, default=1, help="Concurrent workers")
    parser.add_argument("--use-gpu", action="store_true", help="Enable GPU support")
    parser.add_argument("--max-iterations", type=int, default=100, help="Max iterations per instance")
    parser.add_argument("--max-retries", type=int, default=3, help="Max retries for failed instances")
    parser.add_argument("--task-type", required=True, help="Task type", choices=["swebench", "nl2repo"])
    args = parser.parse_args()
    asyncio.run(main(args))

# python -m benchmarking.main \
#     --api-key 11979310bd934a60b38655558991d16a.2RI5rqFP46jtrBBi \
#     --base-url https://open.bigmodel.cn/api/paas/v4/ \
#     --model GLM-4.7 \
#     --max-context-size 131072 \
#     --temperature 1.0 \
#     --top-p 1.0 \
#     --max-tokens 8192 \
#     --debug \
#     --dataset-path /workspace/swe-data/dataset/rl/swebench-verified.jsonl \
#     --timeout 7200 \
#     --max-workers 1 \
#     --max-iterations 1000 \
#     --task-type swebench
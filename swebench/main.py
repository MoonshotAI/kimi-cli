import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import typer
from kimi_cli.utils.logging import enable_logging, logger

from swebench_kimi_eval.config import EvalConfig
from swebench_kimi_eval.evaluator import EvalResult, SWEBenchEvaluator
from swebench_kimi_eval.runner import SWEBenchRunner

app = typer.Typer(help="SWE-Bench evaluation with concurrency control")

class ConcurrentEvaluator:
    """Run evaluations with concurrency control."""

    def __init__(
        self,
        config: EvalConfig,
        max_workers: int = 1,
    ):
        self.config = config
        self.max_workers = max_workers
        self.semaphore = asyncio.Semaphore(max_workers)
        self.results: list[EvalResult] = []
        self.current_task = 0
        self.total_tasks = 0

    async def _evaluate_instance_with_limit(
        self,
        evaluator: SWEBenchEvaluator,
        instance_id: str,
    ) -> EvalResult:
        """Evaluate a single instance with concurrency limit."""
        async with self.semaphore:
            self.current_task += 1
            logger.info(
                f"[{self.current_task}/{self.total_tasks}] Evaluating {instance_id}"
            )

            try:
                result = await evaluator.run_single(instance_id)
                logger.info(f"✓ {instance_id}: {result.status}")
                return result
            except Exception as e:
                logger.error(f"✗ {instance_id}: {e}")
                return EvalResult(
                    instance_id=instance_id,
                    status="error",
                    error=str(e),
                )

    async def run(self) -> list[EvalResult]:
        """Run evaluation with concurrency control."""
        evaluator = SWEBenchEvaluator(self.config)

        # Load instances
        instances_df = evaluator._load_instances()
        self.total_tasks = len(instances_df)

        logger.info(f"Loaded {self.total_tasks} instances")
        logger.info(f"Running with {self.max_workers} concurrent workers")

        # Create tasks
        tasks = [
            self._evaluate_instance_with_limit(evaluator, row["instance_id"])
            for _, row in instances_df.iterrows()
        ]

        # Run with progress
        self.results = await asyncio.gather(*tasks)

        return self.results


@app.command()
def eval_dataset(
    dataset_path: str = typer.Option(
        ...,
        "--dataset",
        "-d",
        help="Path to SWE-Bench dataset (JSONL or JSON)",
    ),
    output_dir: str = typer.Option(
        "./results",
        "--output",
        "-o",
        help="Output directory for results",
    ),
    model: str = typer.Option(
        "gpt-4",
        "--model",
        "-m",
        help="LLM model to use",
    ),
    workers: int = typer.Option(
        1,
        "--workers",
        "-w",
        help="Number of concurrent workers",
    ),
    timeout: int = typer.Option(
        43200,
        "--timeout",
        "-t",
        help="Timeout per instance in seconds (default: 12h)",
    ),
    instances: str | None = typer.Option(
        None,
        "--instances",
        "-i",
        help="Comma-separated instance IDs to evaluate (optional)",
    ),
    config_file: str | None = typer.Option(
        None,
        "--config",
        "-c",
        help="Configuration file path (TOML/JSON/YAML)",
    ),
    debug: bool = typer.Option(
        False,
        "--debug",
        help="Enable debug logging",
    ),
) -> None:
    """Run SWE-Bench evaluation with concurrency control.

    Examples:
        # Evaluate all instances with 4 workers
        python -m swebench.main eval-dataset --dataset data.jsonl --workers 4

        # Evaluate specific instances
        python -m swebench.main eval-dataset --dataset data.jsonl --instances "django__django-11111,flask__flask-2222"

        # Use custom config file
        python -m swebench.main eval-dataset --config eval_config.toml
    """
    # Enable logging
    enable_logging(debug=debug)

    logger.info("Starting SWE-Bench evaluation")

    # Load or create config
    if config_file:
        logger.info(f"Loading config from {config_file}")
        config = EvalConfig.from_file(config_file)
        # Override with CLI args
        if dataset_path:
            config.dataset_path = dataset_path
        if output_dir:
            config.output_dir = output_dir
        if model:
            config.kimi.model = model
        if timeout:
            config.timeout_seconds = timeout
    else:
        # Create config from CLI args
        config = EvalConfig(
            dataset_path=dataset_path,
            output_dir=output_dir,
            kimi=EvalConfig.kimi.__class__(model=model),
            timeout_seconds=timeout,
        )

    # Parse instance IDs if provided
    if instances:
        config.selected_ids = [id.strip() for id in instances.split(",")]
        logger.info(f"Evaluating {len(config.selected_ids)} specific instances")

    # Validate config
    if not Path(config.dataset_path).exists():
        logger.error(f"Dataset not found: {config.dataset_path}")
        raise typer.Exit(code=1)

    # Create output directory
    Path(config.output_dir).mkdir(parents=True, exist_ok=True)

    logger.info(f"Dataset: {config.dataset_path}")
    logger.info(f"Output: {config.output_dir}")
    logger.info(f"Model: {config.kimi.model}")
    logger.info(f"Workers: {workers}")
    logger.info(f"Timeout: {config.timeout_seconds}s per instance")

    # Run evaluation
    try:
        evaluator = ConcurrentEvaluator(config, max_workers=workers)
        results = asyncio.run(evaluator.run())

        # Print summary
        _print_summary(results)

        # Save results
        _save_results(results, Path(config.output_dir))

        logger.info("Evaluation completed successfully")

    except Exception as e:
        logger.error(f"Evaluation failed: {e}")
        raise typer.Exit(code=1)


@app.command()
def eval_instance(
    instance_id: str = typer.Argument(..., help="Instance ID to evaluate"),
    dataset_path: str = typer.Option(
        ...,
        "--dataset",
        "-d",
        help="Path to SWE-Bench dataset",
    ),
    output_dir: str = typer.Option(
        "./results",
        "--output",
        "-o",
        help="Output directory for results",
    ),
    model: str = typer.Option(
        "gpt-4",
        "--model",
        "-m",
        help="LLM model to use",
    ),
    debug: bool = typer.Option(
        False,
        "--debug",
        help="Enable debug logging",
    ),
) -> None:
    """Evaluate a single instance.

    Examples:
        python -m swebench.main eval-instance django__django-11111 --dataset data.jsonl
    """
    enable_logging(debug=debug)

    logger.info(f"Evaluating single instance: {instance_id}")

    config = EvalConfig(
        dataset_path=dataset_path,
        output_dir=output_dir,
        kimi=EvalConfig.kimi.__class__(model=model),
    )

    try:
        evaluator = SWEBenchEvaluator(config)
        result = asyncio.run(evaluator.run_single(instance_id))

        # Print result
        print(f"\n{'='*70}")
        print(f"Evaluation Result for {instance_id}")
        print(f"{'='*70}")
        print(f"Status: {result.status}")
        if result.error:
            print(f"Error: {result.error}")
        else:
            if result.git_patch:
                print(f"Patch size: {len(result.git_patch)} bytes")
            print(f"Duration: {result.duration_seconds:.1f}s")
        print(f"{'='*70}\n")

        # Save result
        output_path = Path(config.output_dir) / "result.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, "w") as f:
            json.dump(result.to_dict(), f, indent=2)

        logger.info(f"Result saved to {output_path}")

    except Exception as e:
        logger.error(f"Evaluation failed: {e}")
        raise typer.Exit(code=1)


@app.command()
def analyze_results(
    results_file: str = typer.Argument(
        ...,
        help="Path to results file (JSONL or JSON)",
    ),
) -> None:
    """Analyze evaluation results.

    Examples:
        python -m swebench.main analyze-results results.jsonl
    """
    results_path = Path(results_file)
    if not results_path.exists():
        logger.error(f"Results file not found: {results_file}")
        raise typer.Exit(code=1)

    logger.info(f"Loading results from {results_file}")

    # Load results
    results: list[dict[str, Any]] = []
    if results_path.suffix == ".jsonl":
        with open(results_path) as f:
            for line in f:
                if line.strip():
                    results.append(json.loads(line))
    else:
        with open(results_path) as f:
            data = json.load(f)
            results = data if isinstance(data, list) else [data]

    # Analyze
    stats = _analyze_results(results)

    # Print analysis
    print(f"\n{'='*70}")
    print(f"Results Analysis")
    print(f"{'='*70}")
    print(f"Total instances: {stats['total']}")
    print(f"  ✓ Successful: {stats['success']} ({stats['success_rate']:.1f}%)")
    print(f"  ✗ Failed: {stats['failed']} ({stats['failed_rate']:.1f}%)")
    print(f"  ⚠ Error: {stats['error']} ({stats['error_rate']:.1f}%)")
    print(f"  ⏱ Timeout: {stats['timeout']} ({stats['timeout_rate']:.1f}%)")
    print(f"\nTotal time: {stats['total_time']:.1f}s ({stats['total_time_hours']:.2f}h)")
    print(f"Average time per instance: {stats['avg_time']:.1f}s")
    if stats['patch_stats']:
        print(f"\nPatch statistics:")
        print(f"  Instances with patches: {stats['patch_stats']['with_patch']}")
        print(f"  Avg patch size: {stats['patch_stats']['avg_size']:.1f} bytes")
    print(f"{'='*70}\n")


def _print_summary(results: list[EvalResult]) -> None:
    """Print evaluation summary."""
    stats = {
        "total": len(results),
        "success": sum(1 for r in results if r.status == "success"),
        "failed": sum(1 for r in results if r.status == "failed"),
        "error": sum(1 for r in results if r.status == "error"),
        "timeout": sum(1 for r in results if r.status == "timeout"),
    }

    total_time = sum(r.duration_seconds for r in results)

    print(f"\n{'='*70}")
    print(f"SWE-Bench Evaluation Summary")
    print(f"{'='*70}")
    print(f"Total instances: {stats['total']}")
    if stats['total'] > 0:
        print(
            f"  ✓ Successful: {stats['success']} ({stats['success']*100/stats['total']:.1f}%)"
        )
        print(
            f"  ✗ Failed: {stats['failed']} ({stats['failed']*100/stats['total']:.1f}%)"
        )
        print(
            f"  ⚠ Error: {stats['error']} ({stats['error']*100/stats['total']:.1f}%)"
        )
        print(
            f"  ⏱ Timeout: {stats['timeout']} ({stats['timeout']*100/stats['total']:.1f}%)"
        )
    print(f"Total time: {total_time:.1f}s ({total_time/3600:.1f}h)")
    if stats['total'] > 0:
        print(f"Average time: {total_time/stats['total']:.1f}s per instance")
    print(f"{'='*70}\n")


def _save_results(results: list[EvalResult], output_dir: Path) -> None:
    """Save results to files."""
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save as JSONL
    jsonl_file = output_dir / "results.jsonl"
    with open(jsonl_file, "w") as f:
        for result in results:
            f.write(result.to_json() + "\n")
    logger.info(f"Results saved to {jsonl_file}")

    # Save as JSON
    json_file = output_dir / "results.json"
    with open(json_file, "w") as f:
        json.dump([r.to_dict() for r in results], f, indent=2)
    logger.info(f"Results saved to {json_file}")


def _analyze_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    """Analyze results data."""
    total = len(results)
    success = sum(1 for r in results if r.get("status") == "success")
    failed = sum(1 for r in results if r.get("status") == "failed")
    error = sum(1 for r in results if r.get("status") == "error")
    timeout = sum(1 for r in results if r.get("status") == "timeout")

    total_time = sum(r.get("duration_seconds", 0) for r in results)

    # Patch statistics
    patch_stats = None
    patches = [r for r in results if r.get("git_patch")]
    if patches:
        patch_sizes = [len(p.get("git_patch", "")) for p in patches]
        patch_stats = {
            "with_patch": len(patches),
            "avg_size": sum(patch_sizes) / len(patch_sizes),
        }

    return {
        "total": total,
        "success": success,
        "failed": failed,
        "error": error,
        "timeout": timeout,
        "success_rate": (success * 100 / total) if total > 0 else 0,
        "failed_rate": (failed * 100 / total) if total > 0 else 0,
        "error_rate": (error * 100 / total) if total > 0 else 0,
        "timeout_rate": (timeout * 100 / total) if total > 0 else 0,
        "total_time": total_time,
        "total_time_hours": total_time / 3600,
        "avg_time": (total_time / total) if total > 0 else 0,
        "patch_stats": patch_stats,
    }


if __name__ == "__main__":
    app()


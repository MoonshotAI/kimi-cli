#!/usr/bin/env python3
"""Execute AI-driven audits and emit pytest-style results."""

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

RESET = "\033[0m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"


def load_report(report_path: Path) -> list[dict]:
    try:
        raw = report_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise SystemExit(f"ERROR: report.json not found at {report_path}") from exc

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"ERROR: invalid JSON in {report_path}: {exc}") from exc

    if not isinstance(payload, list):
        raise SystemExit(f"ERROR: expected a list in {report_path}")

    return payload


def run_agent(script_dir: Path, tests_dir: Path) -> None:
    cmd = [
        "uv",
        "run",
        "kimi",
        "--yolo",
        "--agent-file",
        str(script_dir / "main.yaml"),
        "-c",
        str(tests_dir),
    ]

    subprocess.run(cmd, check=True)


def colorize(text: str, color: str, use_color: bool) -> str:
    if not use_color:
        return text
    return f"{color}{text}{RESET}"


def emit_results(report: list[dict], *, use_color: bool) -> tuple[int, int]:
    passed = 0
    failed = 0

    for test in report:
        if not isinstance(test, dict):
            raise SystemExit("ERROR: each test entry must be an object.")

        test_file = Path(str(test.get("file", "")))
        display_file = test_file.name or str(test_file)

        cases = test.get("cases", [])
        if not isinstance(cases, list):
            raise SystemExit(f"ERROR: 'cases' must be a list in {display_file}.")

        for case in cases:
            if not isinstance(case, dict):
                raise SystemExit(f"ERROR: each case must be an object in {display_file}.")

            case_name = str(case.get("name") or "unnamed_case")
            status = bool(case.get("pass"))
            outcome = colorize(
                "PASSED" if status else "FAILED",
                GREEN if status else RED,
                use_color,
            )
            print(f'{display_file}::"{case_name}" {outcome}')

            if status:
                passed += 1
            else:
                failed += 1

    return passed, failed


def render_summary_line(summary: str, duration: float, *, use_color: bool, failed: int) -> str:
    duration_text = f"in {duration:.2f}s"
    if failed:
        summary_color = RED
    elif summary == "no tests ran":
        summary_color = YELLOW
    else:
        summary_color = GREEN

    text = f"{summary} {duration_text}"
    colored_text = colorize(f" {text} ", summary_color, use_color)
    terminal_width = shutil.get_terminal_size((80, 20)).columns
    base = f"=== {text} ==="

    if terminal_width <= len(base):
        return colorize(base, summary_color, use_color)

    extra = terminal_width - len(base)
    left_extra = extra // 2
    right_extra = extra - left_extra
    left = "===" + "=" * left_extra
    right = "=" * right_extra + "==="

    return f"{left}{colored_text}{right}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("tests_dir", nargs="?", default="tests_ai")
    args = parser.parse_args(argv)

    script_dir = Path(__file__).resolve().parent
    tests_dir = Path(args.tests_dir).resolve()

    if not tests_dir.is_dir():
        raise SystemExit(f"ERROR: tests directory '{tests_dir}' does not exist.")

    start = time.perf_counter()
    run_agent(script_dir, tests_dir)
    duration = time.perf_counter() - start

    report = load_report(tests_dir / "report.json")
    use_color = sys.stdout.isatty()
    passed, failed = emit_results(report, use_color=use_color)

    if failed:
        summary = f"{failed} failed"
        if passed:
            summary += f", {passed} passed"
    elif passed:
        summary = f"{passed} passed"
    else:
        summary = "no tests ran"

    print()
    summary_line = render_summary_line(summary, duration, use_color=use_color, failed=failed)
    print(summary_line)

    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode) from exc

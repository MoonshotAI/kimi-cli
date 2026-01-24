import json
import os
import subprocess
from pathlib import Path
from typing import cast

import pytest
from kaos.path import KaosPath


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _print_trace(label: str, text: str) -> None:
    if os.getenv("KIMI_TEST_TRACE") == "1":
        print("-----")
        print(f"{label}: {text}")


def _collect_stdout(process: subprocess.Popen[str]) -> list[str]:
    assert process.stdout is not None
    lines: list[str] = []
    for line in process.stdout:
        line = line.rstrip("\n")
        _print_trace("STDOUT", line)
        lines.append(line)
    return lines


def _run_print_mode(config_path: Path, work_dir: Path, user_prompt: str) -> tuple[int, list[str]]:
    cmd = [
        "uv",
        "run",
        "kimi",
        "--print",
        "--yolo",
        "--input-format",
        "text",
        "--output-format",
        "stream-json",
        "--config-file",
        str(config_path),
        "--work-dir",
        str(work_dir),
    ]
    process = subprocess.Popen(
        cmd,
        cwd=_repo_root(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=os.environ.copy(),
    )
    assert process.stdin is not None
    process.stdin.write(user_prompt)
    process.stdin.close()
    stdout_lines = _collect_stdout(process)
    return process.wait(), stdout_lines


def _run_shell_mode(config_path: Path, work_dir: Path, user_prompt: str) -> tuple[int, list[str]]:
    cmd = [
        "uv",
        "run",
        "kimi",
        "--yolo",
        "--prompt",
        user_prompt,
        "--config-file",
        str(config_path),
        "--work-dir",
        str(work_dir),
    ]
    process = subprocess.Popen(
        cmd,
        cwd=_repo_root(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=os.environ.copy(),
    )
    if process.stdin is not None:
        process.stdin.close()
    stdout_lines = _collect_stdout(process)
    return process.wait(), stdout_lines


def _send_json(process: subprocess.Popen[str], payload: dict[str, object]) -> None:
    assert process.stdin is not None
    line = json.dumps(payload)
    _print_trace("STDIN", line)
    process.stdin.write(line + "\n")
    process.stdin.flush()


def _collect_until_response(
    process: subprocess.Popen[str], response_id: str
) -> tuple[dict[str, object], list[dict[str, object]]]:
    assert process.stdout is not None
    events: list[dict[str, object]] = []
    while True:
        line = process.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        _print_trace("STDOUT", line)
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(msg, dict):
            continue
        msg = cast(dict[str, object], msg)
        msg_id = msg.get("id")
        if msg_id == response_id:
            return msg, events
        if msg.get("method") == "event":
            params = msg.get("params")
            if isinstance(params, dict):
                events.append(params)
    raise AssertionError(f"Missing response for id {response_id!r}")


def _wire_has_text(events: list[dict[str, object]], text: str) -> bool:
    for event in events:
        if event.get("type") != "ContentPart":
            continue
        payload = event.get("payload", {})
        if not isinstance(payload, dict):
            continue
        if payload.get("type") == "text" and text in str(payload.get("text", "")):
            return True
    return False


def _run_wire_mode(
    config_path: Path, work_dir: Path, user_prompt: str
) -> tuple[int, dict[str, object], list[dict[str, object]]]:
    cmd = [
        "uv",
        "run",
        "kimi",
        "--wire",
        "--yolo",
        "--config-file",
        str(config_path),
        "--work-dir",
        str(work_dir),
    ]
    process = subprocess.Popen(
        cmd,
        cwd=_repo_root(),
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=os.environ.copy(),
    )

    _send_json(
        process,
        {
            "jsonrpc": "2.0",
            "id": "init",
            "method": "initialize",
            "params": {"protocol_version": "1.1"},
        },
    )
    init_resp, _ = _collect_until_response(process, "init")
    assert "result" in init_resp

    _send_json(
        process,
        {
            "jsonrpc": "2.0",
            "id": "prompt-1",
            "method": "prompt",
            "params": {"user_input": user_prompt},
        },
    )
    resp, events = _collect_until_response(process, "prompt-1")

    if process.stdin is not None:
        process.stdin.close()
    _collect_stdout(process)
    return process.wait(), resp, events


@pytest.mark.parametrize("mode", ["print", "wire", "shell"])
async def test_scripted_echo_kimi_cli_agent_e2e(
    temp_work_dir: KaosPath, tmp_path: Path, mode: str
) -> None:
    sample_js = "\n".join(
        [
            "function add(a, b) {",
            "  return a + b;",
            "}",
            "",
            "function main() {",
            "  const result = add(2, 3);",
            "  console.log(`2 + 3 = ${result}`);",
            "}",
            "",
            "main();",
            "",
        ]
    )
    await (temp_work_dir / "sample.js").write_text(sample_js)

    translated_py = "\n".join(
        [
            "def add(a, b):",
            "    return a + b",
            "",
            "def main():",
            "    result = add(2, 3)",
            '    print(f"2 + 3 = {result}")',
            "",
            'if __name__ == "__main__":',
            "    main()",
            "",
        ]
    )

    read_args = json.dumps({"path": "sample.js"})
    write_args = json.dumps(
        {
            "path": "translated.py",
            "content": translated_py,
            "mode": "overwrite",
        }
    )
    read_call = {"id": "ReadFile:0", "name": "ReadFile", "arguments": read_args}
    write_call = {"id": "WriteFile:1", "name": "WriteFile", "arguments": write_args}

    scripts = [
        "\n".join(
            [
                "id: scripted-1",
                'usage: {"input_other": 18, "output": 3}',
                f"tool_call: {json.dumps(read_call)}",
            ]
        ),
        "\n".join(
            [
                "id: scripted-2",
                'usage: {"input_other": 22, "output": 4}',
                f"tool_call: {json.dumps(write_call)}",
            ]
        ),
        "\n".join(
            [
                "id: scripted-3",
                'usage: {"input_other": 12, "output": 2}',
                "text: Translation completed successfully.",
            ]
        ),
    ]

    scripts_path = tmp_path / "scripts.json"
    scripts_path.write_text(json.dumps(scripts), encoding="utf-8")

    config_path = tmp_path / "config.json"
    trace_env = os.getenv("KIMI_SCRIPTED_ECHO_TRACE", "0")
    config_data = {
        "default_model": "scripted",
        "models": {
            "scripted": {
                "provider": "scripted_provider",
                "model": "scripted_echo",
                "max_context_size": 100000,
            }
        },
        "providers": {
            "scripted_provider": {
                "type": "_scripted_echo",
                "base_url": "",
                "api_key": "",
                "env": {
                    "KIMI_SCRIPTED_ECHO_SCRIPTS": str(scripts_path),
                    "KIMI_SCRIPTED_ECHO_TRACE": trace_env,
                },
            }
        },
    }
    config_path.write_text(json.dumps(config_data), encoding="utf-8")

    user_prompt = (
        "You are a code translation assistant.\n\n"
        "Task:\n"
        "- Read the file `sample.js` in the current working directory.\n"
        "- Translate it into idiomatic Python 3.\n"
        "- Write the translated code to `translated.py` in the current working directory.\n\n"
        "Rules:\n"
        "- You must read the file from disk; do not guess its contents.\n"
        "- Preserve behavior and output.\n"
        "- Write only Python code in translated.py (no Markdown).\n"
        "- Overwrite translated.py if it already exists.\n"
        "- After writing, reply with a single short ASCII confirmation sentence.\n"
    )

    work_dir = temp_work_dir.unsafe_to_local_path()
    _print_trace("USER INPUT", json.dumps(user_prompt))

    if mode == "print":
        return_code, stdout_lines = _run_print_mode(config_path, work_dir, user_prompt)
        assert return_code == 0
        assert any("Translation completed successfully." in line for line in stdout_lines)
    elif mode == "wire":
        return_code, resp, events = _run_wire_mode(config_path, work_dir, user_prompt)
        assert return_code == 0
        result = resp.get("result")
        assert isinstance(result, dict)
        assert result.get("status") == "finished"
        assert _wire_has_text(events, "Translation completed successfully.")
    elif mode == "shell":
        return_code, stdout_lines = _run_shell_mode(config_path, work_dir, user_prompt)
        assert return_code == 0
        assert any("Translation completed successfully." in line for line in stdout_lines)
    else:
        raise AssertionError(f"Unknown mode: {mode}")

    translated_path = work_dir / "translated.py"
    assert translated_path.read_text(encoding="utf-8") == translated_py

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


def _turn_has_part_type(events: list[dict[str, object]], part_type: str) -> bool:
    for event in events:
        if event.get("type") != "TurnBegin":
            continue
        payload = event.get("payload", {})
        if not isinstance(payload, dict):
            continue
        user_input = payload.get("user_input")
        if not isinstance(user_input, list):
            continue
        for part in user_input:
            if isinstance(part, dict) and part.get("type") == part_type:
                return True
    return False


def _has_content_part(events: list[dict[str, object]], part_type: str) -> bool:
    for event in events:
        if event.get("type") != "ContentPart":
            continue
        payload = event.get("payload", {})
        if isinstance(payload, dict) and payload.get("type") == part_type:
            return True
    return False


def _has_text_content(events: list[dict[str, object]], text: str) -> bool:
    for event in events:
        if event.get("type") != "ContentPart":
            continue
        payload = event.get("payload", {})
        if not isinstance(payload, dict):
            continue
        if payload.get("type") == "text" and text in str(payload.get("text", "")):
            return True
    return False


def _parse_message_content(line: str) -> list[dict[str, object]]:
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        return []
    if not isinstance(msg, dict):
        return []
    content = msg.get("content")
    if isinstance(content, list):
        return [part for part in content if isinstance(part, dict)]
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return []


def _content_has_part(parts: list[dict[str, object]], part_type: str) -> bool:
    return any(part.get("type") == part_type for part in parts)


def _content_has_text(parts: list[dict[str, object]], text: str) -> bool:
    return any(part.get("type") == "text" and text in str(part.get("text", "")) for part in parts)


def _run_print_mode(
    config_path: Path, work_dir: Path, messages: list[dict[str, object]]
) -> tuple[int, list[str]]:
    cmd = [
        "uv",
        "run",
        "kimi",
        "--print",
        "--yolo",
        "--input-format",
        "stream-json",
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
    for msg in messages:
        _send_json(process, msg)
    process.stdin.close()

    stdout_lines: list[str] = []
    assert process.stdout is not None
    for line in process.stdout:
        line = line.rstrip("\n")
        _print_trace("STDOUT", line)
        stdout_lines.append(line)
    return process.wait(), stdout_lines


@pytest.mark.parametrize("mode", ["print", "wire"])
def test_scripted_echo_media_e2e(temp_work_dir: KaosPath, tmp_path: Path, mode: str) -> None:
    image_url = "data:image/png;base64,AAAA"
    video_url = "data:video/mp4;base64,AAAA"

    scripts = [
        "\n".join(
            [
                "id: scripted-1",
                'usage: {"input_other": 11, "output": 5}',
                "think: analyzing the image",
                "text: The image shows a simple scene.",
            ]
        ),
        "\n".join(
            [
                "id: scripted-2",
                'usage: {"input_other": 13, "output": 6}',
                "think: analyzing the video",
                "text: The video appears to be a short clip.",
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
                "capabilities": ["image_in", "video_in", "thinking"],
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

    work_dir = temp_work_dir.unsafe_to_local_path()
    if mode == "print":
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this image."},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "Describe this video."},
                    {"type": "video_url", "video_url": {"url": video_url}},
                ],
            },
        ]
        return_code, stdout_lines = _run_print_mode(config_path, work_dir, messages)
        assert return_code == 0
        parsed_contents = [_parse_message_content(line) for line in stdout_lines]
        parsed_contents = [parts for parts in parsed_contents if parts]
        assert len(parsed_contents) >= 2
        assert _content_has_part(parsed_contents[0], "think")
        assert _content_has_text(parsed_contents[0], "The image shows a simple scene.")
        assert _content_has_part(parsed_contents[1], "think")
        assert _content_has_text(parsed_contents[1], "The video appears to be a short clip.")
    elif mode == "wire":
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
                "params": {
                    "user_input": [
                        {"type": "text", "text": "Describe this image."},
                        {"type": "image_url", "image_url": {"url": image_url}},
                    ]
                },
            },
        )
        resp1, events1 = _collect_until_response(process, "prompt-1")
        result1 = resp1.get("result")
        assert isinstance(result1, dict)
        assert result1.get("status") == "finished"
        assert _turn_has_part_type(events1, "image_url")
        assert _has_content_part(events1, "think")
        assert _has_text_content(events1, "The image shows a simple scene.")

        _send_json(
            process,
            {
                "jsonrpc": "2.0",
                "id": "prompt-2",
                "method": "prompt",
                "params": {
                    "user_input": [
                        {"type": "text", "text": "Describe this video."},
                        {"type": "video_url", "video_url": {"url": video_url}},
                    ]
                },
            },
        )
        resp2, events2 = _collect_until_response(process, "prompt-2")
        result2 = resp2.get("result")
        assert isinstance(result2, dict)
        assert result2.get("status") == "finished"
        assert _turn_has_part_type(events2, "video_url")
        assert _has_content_part(events2, "think")
        assert _has_text_content(events2, "The video appears to be a short clip.")

        assert process.stdin is not None
        process.stdin.close()
        process.wait(timeout=10)
    else:
        raise AssertionError(f"Unknown mode: {mode}")

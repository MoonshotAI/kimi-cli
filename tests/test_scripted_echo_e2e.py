import asyncio
import json
import os
from pathlib import Path

from kaos.path import KaosPath
from kosong.chat_provider.scripted_echo import ScriptedEchoChatProvider

from kimi_cli.llm import LLM
from kimi_cli.soul import run_soul
from kimi_cli.soul.agent import Agent, Runtime
from kimi_cli.soul.context import Context
from kimi_cli.soul.kimisoul import KimiSoul
from kimi_cli.soul.toolset import KimiToolset
from kimi_cli.tools.file.read import ReadFile
from kimi_cli.tools.file.write import WriteFile
from kimi_cli.utils.aioqueue import QueueShutDown
from kimi_cli.wire import Wire
from kimi_cli.wire.serde import serialize_wire_message
from kimi_cli.wire.types import TextPart, WireMessage


def _runtime_with_llm(runtime: Runtime, llm: LLM) -> Runtime:
    return Runtime(
        config=runtime.config,
        llm=llm,
        session=runtime.session,
        builtin_args=runtime.builtin_args,
        denwa_renji=runtime.denwa_renji,
        approval=runtime.approval,
        labor_market=runtime.labor_market,
        environment=runtime.environment,
        skills=runtime.skills,
    )


def _trace(msg: str) -> None:
    if os.getenv("KIMI_TEST_TRACE") == "1":
        print("-----")
        print(msg)


def _wire_message_to_text(msg: WireMessage) -> str:
    payload = serialize_wire_message(msg)
    return f"{type(msg).__name__}: {payload}"


class TracingScriptedEchoChatProvider(ScriptedEchoChatProvider):
    async def generate(self, system_prompt: str, tools, history):
        script_text = self._scripts[0] if self._scripts else ""
        _trace(f"PROVIDER SCRIPT:\n{script_text}")
        return await super().generate(system_prompt, tools, history)


async def test_scripted_echo_kimi_cli_agent_e2e(
    runtime: Runtime, temp_work_dir: KaosPath, tmp_path: Path
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

    llm = LLM(
        chat_provider=TracingScriptedEchoChatProvider(scripts),
        max_context_size=100_000,
        capabilities=set(),
    )
    runtime_with_llm = _runtime_with_llm(runtime, llm)

    toolset = KimiToolset()
    toolset.add(ReadFile(runtime_with_llm))
    toolset.add(WriteFile(runtime_with_llm.builtin_args, runtime_with_llm.approval))

    agent = Agent(
        name="Scripted Echo Agent",
        system_prompt="You are a code translation assistant.",
        toolset=toolset,
        runtime=runtime_with_llm,
    )
    context = Context(file_backend=tmp_path / "history.jsonl")
    soul = KimiSoul(agent, context=context)

    user_prompt = (
        "You are a code translation assistant.\n\n"
        "Task:\n"
        "- Read the file `sample.js` in the current working directory.\n"
        "- Translate it into idiomatic Python 3.\n"
        "- Write the translated code to `translated.py` in the current working directory.\n\n"
    )
    _trace(f"USER INPUT:\n{user_prompt}")

    streamed_text: list[str] = []

    async def _ui_loop(wire: Wire) -> None:
        wire_ui = wire.ui_side(merge=True)
        while True:
            try:
                msg = await wire_ui.receive()
            except QueueShutDown:
                return
            _trace(f"WIRE MESSAGE:\n{_wire_message_to_text(msg)}")
            if isinstance(msg, TextPart):
                streamed_text.append(msg.text)

    await run_soul(soul, user_prompt, _ui_loop, asyncio.Event())

    translated_path = temp_work_dir / "translated.py"
    assert await translated_path.read_text() == translated_py
    assert streamed_text[-1] == "Translation completed successfully."

import asyncio
import json
import os

KIMI_CLI_COMMAND = "uv run --project ../../ kimi"


async def main():
    proc = await asyncio.create_subprocess_exec(
        *KIMI_CLI_COMMAND.split(),
        "--work-dir",
        os.getcwd(),
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
    )

    assert proc.stdout is not None, "stdout is None"
    assert proc.stdin is not None, "stdin is None"

    user_message = {
        "role": "user",
        "content": "How many lines of code are there in the current working directory?",
    }
    proc.stdin.write(json.dumps(user_message).encode("utf-8") + b"\n")
    await proc.stdin.drain()

    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        message = json.loads(line.decode("utf-8"))
        print("Received message:", message)


if __name__ == "__main__":
    asyncio.run(main())

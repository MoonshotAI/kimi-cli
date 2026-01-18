import asyncio
from pathlib import Path

from kosong.contrib.context.linear import JsonlLinearStorage, LinearContext, MemoryLinearStorage
from kosong.message import Message


def test_linear_context():
    context = LinearContext(
        storage=MemoryLinearStorage(),
    )
    assert context.history == []

    async def run():
        await context.add_message(Message(role="user", content="abc"))
        await context.add_message(Message(role="assistant", content="def"))
        return context.history

    history = asyncio.run(run())
    assert history == [
        Message(role="user", content="abc"),
        Message(role="assistant", content="def"),
    ]


def test_linear_context_with_jsonl_storage():
    test_path = Path(__file__).parent / "test.jsonl"
    if test_path.exists():
        test_path.unlink()

    async def run():
        storage = JsonlLinearStorage(path=test_path)
        context = LinearContext(
            storage=storage,
        )
        await context.add_message(Message(role="user", content="abc"))
        await context.add_message(Message(role="assistant", content="def"))
        return context.history

    history = asyncio.run(run())
    assert history == [
        Message(role="user", content="abc"),
        Message(role="assistant", content="def"),
    ]

    with open(test_path) as f:
        expected = """\
{"role":"user","content":"abc"}
{"role":"assistant","content":"def"}
"""
        assert f.read() == expected

    test_path.unlink()

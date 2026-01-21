from openai.types.chat import ChatCompletionChunk

from kosong.chat_provider.kimi import extract_usage_from_chunk


def test_kimi_extracts_choice_usage_in_stream_chunk() -> None:
    chunk = ChatCompletionChunk.model_validate(
        {
            "id": "chatcmpl-6970b5d02fa474c1767e8767",
            "object": "chat.completion.chunk",
            "created": 1768994256,
            "model": "kimi-k2-turbo-preview",
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop",
                    "usage": {
                        "prompt_tokens": 8,
                        "completion_tokens": 11,
                        "total_tokens": 19,
                        "cached_tokens": 8,
                    },
                }
            ],
            "system_fingerprint": "fpv0_10a6da87",
        }
    )
    usage = extract_usage_from_chunk(chunk)
    assert usage is not None
    assert usage.prompt_tokens == 8
    assert usage.completion_tokens == 11
    assert usage.total_tokens == 19

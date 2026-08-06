from inline_snapshot import snapshot

from kimi_cli.llm import LLM


def test_soul_exceptions(llm: LLM):
    from kimi_cli.soul import LLMNotSet, LLMNotSupported, MaxStepsReached

    try:
        raise LLMNotSet()
    except LLMNotSet as e:
        assert str(e) == snapshot("LLM not set")

    try:
        raise LLMNotSupported(llm, ["image_in"])
    except LLMNotSupported as e:
        assert str(e) == snapshot(
            "LLM model 'mock' does not support required capability: image_in. "
            'Add capabilities = ["image_in"] to [models.<alias>] in config.toml '
            "(or set KIMI_MODEL_CAPABILITIES)."
        )

    try:
        raise MaxStepsReached(10)
    except MaxStepsReached as e:
        assert str(e) == snapshot("Max number of steps reached: 10")

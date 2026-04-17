"""Tests for Bedrock Mantle platform helpers and OpenAI-style model list parsing."""

from kimi_cli.auth import platforms as auth_platforms
from kimi_cli.auth.platforms import (
    BEDROCK_MANTLE_PLATFORM_ID,
    bedrock_mantle_base_url,
    get_platform_by_id,
)


def test_bedrock_mantle_base_url() -> None:
    assert bedrock_mantle_base_url("eu-west-2") == "https://bedrock-mantle.eu-west-2.api.aws/v1"


def test_bedrock_mantle_platform_registered() -> None:
    p = get_platform_by_id(BEDROCK_MANTLE_PLATFORM_ID)
    assert p is not None
    assert p.llm_provider_type == "openai_legacy"
    assert p.base_url == ""


def test_openai_compatible_model_sparse_payload_kimi() -> None:
    info = auth_platforms._model_info_from_models_payload_item(
        {"id": "moonshotai.kimi-k2.5"}, openai_compatible=True
    )
    assert info is not None
    assert info.id == "moonshotai.kimi-k2.5"
    assert info.context_length == 131_072


def test_openai_compatible_model_sparse_payload_other() -> None:
    info = auth_platforms._model_info_from_models_payload_item(
        {"id": "openai.gpt-oss-120b"}, openai_compatible=True
    )
    assert info is not None
    assert info.context_length == 128_000


def test_kimi_payload_unchanged() -> None:
    info = auth_platforms._model_info_from_models_payload_item(
        {
            "id": "kimi-k2-turbo-preview",
            "context_length": 65536,
            "supports_reasoning": True,
            "supports_image_in": False,
            "supports_video_in": False,
        },
        openai_compatible=False,
    )
    assert info is not None
    assert info.context_length == 65536
    assert info.supports_reasoning is True

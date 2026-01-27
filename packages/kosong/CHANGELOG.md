# Changelog

## Unreleased

## 0.41.0 (2026-01-27)

- Remove default temperature setting in Kimi chat provider based on model name

## 0.40.0 (2026-01-24)

- Add `ScriptedEchoChatProvider` for scripted conversation simulation in end-to-end testing

## 0.39.1 (2026-01-21)

- Fix streamed usage from choice not being read properly

## 0.39.0 (2026-01-21)

- Control thinking mode via `extra_body` parameter instead of legacy `reasoning_effort`
- Add `files` property to `Kimi` provider that returns a `KimiFiles` object
- Add `KimiFiles.upload_video()` method for uploading videos to Kimi files API, returning `VideoURLPart`

## 0.38.0 (2026-01-15)

- Add `thinking_effort` property to `ChatProvider` protocol to query current thinking effort level

## 0.37.0 (2026-01-08)

- Change `TokenUsage` from dataclass to pydantic BaseModel.

## 0.36.1 (2026-01-04)

- Relax `loguru` lower bound.

## 0.36.0 (2025-12-31)

- Add `VideoURLPart` content part

## 0.35.1-4 (2025-12-26)

- Nothing changed.

## 0.35.0 (2025-12-24)

- Add registry-based `DisplayBlock` validation to allow custom tool/UI display block subclasses, plus `BriefDisplayBlock` and `UnknownDisplayBlock`
- Rename brief display payload field to `text` and keep tool return display blocks empty when no brief is provided

## 0.34.1 (2025-12-22)

- Add `convert_mcp_content` util to convert MCP content type to kosong content type

## 0.34.0 (2025-12-19)

- Support Vertex AI in GoogleGenAI chat provider
- Add `SimpleToolset.add()` and `SimpleToolset.remove()` methods to add or remove tools from the toolset

## 0.33.0 (2025-12-12)

- Lower the required Python version to 3.12
- Make the `contrib` module an optional extra that can be installed with `uv add "kosong[contrib]"`

## 0.32.0 (2025-12-08)

- Introduce `ToolMessageConversion` to customize how tool messages are converted in chat providers

## 0.31.0 (2025-12-03)

- Fix OpenAI Responses provider not mapping `role="system"` to `developer`
- Improve the compatibility of OpenAI Responses and Anthropic providers against some third-party APIs

## 0.30.0 (2025-12-03)

- Serialize empty content as an empty list instead of `None`
- Fix Kimi chat provider panicking when `stream` is `False`

## 0.29.0 (2025-12-02)

- Change `Message.content` field from `str | list[ContentPart]` to just `list[ContentPart]`
- Add `Message.extract_text()` method to extract text content from message

## 0.28.1 (2025-12-01)

- Fix interleaved thinking for Kimi and OpenAILegacy chat providers

## 0.28.0 (2025-11-28)

- Support non-OpenAI models which do not accept `developer` role in system prompt in `OpenAIResponses` chat provider
- Fix token usage for Anthropic chat provider
- Fix `StepResult.tool_results()` cannot be called multiple times
- Add `EchoChatProvider` to allow generate assistant responses by echoing back the user messages

## 0.27.1 (2025-11-24)

- Nothing

## 0.27.0 (2025-11-24)

- Fix function call ID in `GoogleGenAI` chat provider
- Make `CallableTool2` not a `pydantic.BaseModel`
- Introduce `ToolReturnValue` as the common base class of `ToolOk` and `ToolError`
- Require `CallableTool` and `CallableTool2` to return `ToolReturnValue` instead of `ToolOk | ToolError`
- Rename `ToolResult.result` to `ToolResult.return_value`

## 0.26.2 (2025-11-20)

- Better thinking level mapping in `GoogleGenAI` chat provider

## 0.26.1 (2025-11-19)

- Deref JSON schema in tool parameters to fix compatibility with some LLM providers

## 0.26.0 (2025-11-19)

- Fix thinking part in `Anthropic` provider's non-stream mode
- Add `GoogleGenAI` chat provider

## 0.25.1 (2025-11-18)

- Catch httpx exceptions correctly in Kimi and OpenAI providers

## 0.25.0 (2025-11-13)

- Add `reasoning_key` argument to `OpenAILegacy` chat provider to specify the field for reasoning content in messages

## 0.24.0 (2025-11-12)

- Set default temperature settings for Kimi models based on model name

## 0.23.0 (2025-11-10)

- Change type of `ToolError.output` to `str | ContentPart | Sequence[ContentPart]`

## 0.22.0 (2025-11-10)

- Add `APIEmptyResponseError` for cases where the API returns an empty response
- Add `GenerateResult` as the return type of `generate` function
- Add `id: str | None` field to `GenerateResult` and `StepResult`

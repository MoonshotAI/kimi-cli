# Changelog

## Unreleased

## 0.52.0 (2026-04-24)

- Kimi: Add `keep` to `ThinkingConfig` (Moonshot `thinking.keep` passthrough for Preserved Thinking); value is typed as `Any` and forwarded unchanged, with case-preservation and no validation — callers choose a value the server accepts (e.g. `"all"`)
- Kimi: Fix `with_extra_body` silently dropping earlier `thinking.*` fields on subsequent calls — the `thinking` sub-dict is now merged field-by-field so composing `with_thinking(...)` with `with_extra_body({"thinking": {...}})` preserves both contributions; other top-level keys retain last-writer-wins semantics
- Kimi: Normalize MCP tool parameter schemas before sending to Moonshot — properties that declare `enum`/`const` but no `type` (or have no type hint at all) get an inferred `type` filled in, so MCP servers whose schemas are valid JSON Schema but not strict enough for Moonshot's validator (notably the JetBrains Rider MCP, whose `truncateMode` property is enum-only) no longer make every request fail with `400 At path 'properties.X': type is not defined`; the normalization is Kimi-specific and leaves OpenAI/Anthropic conversions untouched
- Kimi: Fix sending empty `content` alongside `tool_calls`, which caused 400 "text content is empty" errors from the Moonshot API. When an assistant message has tool calls and its visible content is effectively empty (no text or only whitespace/think parts), the `content` field is now omitted entirely

## 0.51.0 (2026-04-22)

- Anthropic: Fix parallel tool results being split into multiple user messages — consecutive tool-result-only user messages are now merged into a single message, complying with the Anthropic Messages API spec that all `tool_use` blocks in an assistant turn must be answered within one user message; this fixes 400 errors on strict Anthropic-compatible backends (e.g. DeepSeek `/anthropic` endpoint) and prevents the official backend from silently teaching the model to avoid parallel tool calls

## 0.50.0 (2026-04-17)

- Anthropic: Add adaptive thinking support for Claude Opus 4.7 — model capability detection now uses regex version extrapolation (covers `opus-4-7`, Bedrock/Vertex name variants such as `aws/claude-opus-4-7` and `anthropic.claude-opus-4-7-v1:0`, `claude-mythos-preview`, and future Claude versions ≥ 4.6) instead of hard-coded substring matching; adaptive requests now set `display: "summarized"` explicitly so thinking content still streams on Opus 4.7 (where the default flipped to `"omitted"`); the legacy `thinking: {type: "enabled", budget_tokens: N}` path is no longer used for Opus 4.7, which rejects it with 400
- Anthropic: Plumb `output_config.effort` through both adaptive and legacy paths — the user-requested effort was previously dropped in adaptive mode, silently collapsing `low`/`medium` to the model default; effort is now faithfully forwarded, and on legacy paths it is emitted only for models that Anthropic's docs explicitly list as supporting the parameter (Opus 4.5 on top of all adaptive-capable models) to avoid 400 validation errors on Claude 3.x and other models that reject `output_config`
- Core: Extend `ThinkingEffort` with `xhigh` and `max` — new tiers available on Opus 4.7 (`xhigh`), Opus 4.6 / Sonnet 4.6 / Claude Mythos Preview (`max`), and OpenAI models after `gpt-5.1-codex-max` (`xhigh`); providers clamp unsupported levels down transparently (e.g., `xhigh` → `high` on Opus 4.6, `max` → `xhigh` on OpenAI, `xhigh`/`max` → `high` on Gemini and Kimi)

## 0.49.0 (2026-04-10)

- Core: Treat think-only model responses (reasoning content with no text or tool calls) as incomplete response errors, enabling automatic retry instead of silently stopping the agent loop
- OpenAI: Fix crash on streaming mid-flight disconnection — classify base `openai.APIError` (body=None) as retryable via heuristic message matching, so that `_run_with_connection_recovery` and tenacity retry logic correctly trigger instead of crashing

## 0.48.0 (2026-04-02)

- Google GenAI: Add `default_headers` parameter to `GoogleGenAI` constructor — custom headers are merged into `HttpOptions` so they are included in all API requests

## 0.47.0 (2026-03-30)

- OpenAI: Fix implicit `reasoning_effort` causing 400 errors — auto-set `reasoning_effort` to `"medium"` when history contains `ThinkPart` and the parameter wasn't explicitly set

## 0.46.0 (2026-03-25)

- Google GenAI: Fix `FunctionCall` and `FunctionResponse` wire format — remove `id` field from outbound messages as Gemini API returns HTTP 400 when it is included; internal `tool_call_id` tracking remains unchanged
- Core: Use `json.loads(strict=False)` when parsing tool call arguments to tolerate unescaped control characters from LLM output
- Core: Treat `httpx.ProtocolError` as `APIConnectionError` in shared `convert_httpx_error()` mapping so streaming protocol disconnects now participate in existing retry logic
- Anthropic: Fix `httpx.ReadTimeout` leaking through `_convert_stream_response` during streaming — the exception is now caught and converted to `APITimeoutError`, enabling retry logic that was previously bypassed
- Anthropic: Fix `_convert_error` ordering — `AnthropicAPITimeoutError` is now checked before `AnthropicAPIConnectionError` to avoid misclassification due to inheritance
- Core: Add shared `convert_httpx_error()` utility for converting httpx transport errors to `ChatProviderError` subtypes, used by all providers
- Google GenAI: Add `httpx.HTTPError` catch in `_convert_stream_response` for the httpx fallback transport path

## 0.45.0 (2026-03-11)

- OpenAI Responses: Fix implicit `reasoning.effort=null` being sent which breaks Responses-compatible endpoints that require reasoning — reasoning parameters are now omitted unless explicitly set

## 0.44.0 (2026-03-09)

- Anthropic: Support optional `metadata` parameter in `Anthropic` chat provider for passing metadata (e.g., `user_id`) to the API

## 0.43.0 (2026-02-24)

- Add `RetryableChatProvider` protocol for providers that can recover from retryable transport errors
- Implement `RetryableChatProvider` in Kimi, OpenAI Legacy, and OpenAI Responses providers
- Add `create_openai_client` and `close_replaced_openai_client` utilities to `openai_common`

## 0.42.0 (2026-02-06)

- Anthropic: Use adaptive thinking for Opus 4.6+ models instead of budget-based thinking

## 0.41.1 (2026-02-05)

- Handle string annotations in `SimpleToolset` return type check (supports `from __future__ import annotations`)

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

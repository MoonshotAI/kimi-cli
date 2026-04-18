// Message types
export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from './message.js';
export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallFunction,
  ToolCallPart,
  VideoURLPart,
} from './message.js';

// Provider interfaces
export type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  RetryableChatProvider,
  StreamedMessage,
  ThinkingEffort,
} from './provider.js';

// Model capability matrix
export { UNKNOWN_CAPABILITY } from './capability.js';
export type { ModelCapability } from './capability.js';

// Core functions
export { generate } from './generate.js';
export type { GenerateCallbacks, GenerateResult } from './generate.js';
export { step } from './step.js';
export type { StepCallbacks, StepResult } from './step.js';

// Tool system
export { toolError, toolOk } from './tool.js';
export type {
  BriefDisplayBlock,
  DisplayBlock,
  JsonType,
  Tool,
  ToolResult,
  ToolReturnValue,
  Toolset,
  UnknownDisplayBlock,
} from './tool.js';
export {
  toolNotFoundError,
  toolParseError,
  toolRuntimeError,
  toolValidateError,
} from './tool-errors.js';

// Toolset implementations
export { SimpleToolset } from './simple-toolset.js';
export { EmptyToolset } from './empty-toolset.js';
export { MCPToolset, convertMCPContentBlock } from './mcp-toolset.js';

// Typed tool helpers
export { createTypedTool } from './typed-tool.js';
export type { TypedTool, TypedToolConfig } from './typed-tool.js';
export type {
  MCPClient,
  MCPContentBlock,
  MCPToolDefinition,
  MCPToolResult,
} from './mcp-toolset.js';

// Token usage
export { addUsage, emptyUsage, grandTotal, inputTotal } from './usage.js';
export type { TokenUsage } from './usage.js';

// Errors
export {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from './errors.js';

// Context / Storage
export { JsonlLinearStorage, LinearContext, MemoryLinearStorage } from './context.js';
export type { LinearRestoreResult, LinearStorage } from './context.js';

// Logger
export { getLogger, setLogger } from './logger.js';
export type { Logger } from './logger.js';

// JSON Schema utilities
export { derefJsonSchema } from './json-schema-deref.js';

// Test utilities (no SDK dependencies)
export { MockChatProvider } from './mock-provider.js';
export { EchoChatProvider, ScriptedEchoChatProvider } from './echo-provider.js';

// NOTE: Concrete provider adapters are NOT exported from the root barrel
// because their SDK type graphs (undici-types, etc.) pollute downstream
// declaration bundles and break builds in packages that only need the generic
// chat/tool types.
//
// Import provider adapters from subpaths instead:
//   import { KimiChatProvider } from '@moonshot-ai/kosong/providers/kimi';
//   import { OpenAILegacyChatProvider } from '@moonshot-ai/kosong/providers/openai-legacy';
